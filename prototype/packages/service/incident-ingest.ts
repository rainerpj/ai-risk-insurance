import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { canonicalize, parseStrictJSON } from '../domain/evidence.ts';
import { exactObject, identifier, requireIncident as need, text, timestamp, type Actor, type AgentRun, type Workflow } from '../domain/incident-schema.ts';
import { IncidentStore } from './incident-store.ts';

export const INGEST_LIMITS = { objects:32, objectBytes:256*1024, totalBytes:2*1024*1024, records:1000, requestBytes:3*1024*1024 } as const;
export type SourceInput = { schemaVersion:1; projectId:string; sourceId:string; controllerPartyId:string; kind:string; allowedWorkflowIds:string[]; captureMethod:'source_export'|'gateway_receipt'|'attested'|'synthetic'; keyId:string|null; publicKey:string|null; validFrom:string; validUntil:string|null };
export type ObjectDescriptor = { objectId:string; path:string; sourceId:string; mediaType:'application/json'|'application/x-ndjson'|'text/plain'; byteLength:number; sha256:string; signature:string|null };
export type ImportManifest = { schemaVersion:1; projectId:string; packageId:string; runId:string; dataAuthorizationRef:string; dataClass:'synthetic'|'approved_redacted'; supersedesImportId:string|null; objects:ObjectDescriptor[] };
export type ImportBundle = { manifest:ImportManifest; objects:{path:string;contentBase64:string}[] };
export type ImportReceipt = {schemaVersion:1; importId:string;tenantId:string;projectId:string;runId:string;packageId:string;receivedAt:string;manifestDigest:string;manifest:ImportManifest;status:'accepted'|'quarantined';missingPaths:string[];objects:(ObjectDescriptor & {signatureStatus:'valid'|'unsigned';trust:'source_signed'|'gateway_received'|'attested'|'synthetic'|'unverified'})[];limitations:string[];supersedesImportId:string|null};
export const byteDigest = (bytes: Uint8Array|string) => createHash('sha256').update(bytes).digest('hex');
const hash = (value:unknown) => byteDigest(canonicalize(JSON.stringify(value)));
export function safeImportPath(value:unknown): asserts value is string {
  need(typeof value === 'string' && value.length <= 200 && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(json|jsonl|txt)$/.test(value),'INVALID_OBJECT_PATH');
  need(value.split('/').every(segment => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)),'INVALID_OBJECT_PATH');
}
export function parseManifest(value:unknown): ImportManifest {
  exactObject(value,['schemaVersion','projectId','packageId','runId','dataAuthorizationRef','dataClass','supersedesImportId','objects']);
  need(value.schemaVersion === 1,'UNSUPPORTED_SCHEMA');
  need(identifier(value.projectId) && identifier(value.packageId) && identifier(value.runId) && text(value.dataAuthorizationRef));
  need((typeof value.dataClass === 'string' && ['synthetic','approved_redacted'].includes(value.dataClass)) && (value.supersedesImportId === null || identifier(value.supersedesImportId)));
  need(Array.isArray(value.objects) && value.objects.length > 0 && value.objects.length <= INGEST_LIMITS.objects,'OBJECT_COUNT_LIMIT');
  const ids = new Set(), paths = new Set();let size=0;
  for (const obj of value.objects) {
    exactObject(obj,['objectId','path','sourceId','mediaType','byteLength','sha256','signature']);safeImportPath(obj.path);
    need(identifier(obj.objectId) && identifier(obj.sourceId) && !ids.has(obj.objectId) && !paths.has(obj.path.toLowerCase()),'DUPLICATE_OBJECT');ids.add(obj.objectId);paths.add(obj.path.toLowerCase());
    const expected = obj.path.endsWith('.jsonl') ? 'application/x-ndjson' : obj.path.endsWith('.json') ? 'application/json' : 'text/plain';
    need(obj.mediaType === expected,'MEDIA_TYPE_MISMATCH');
    need(Number.isInteger(obj.byteLength) && Number(obj.byteLength)>0 && Number(obj.byteLength)<=INGEST_LIMITS.objectBytes,'OBJECT_SIZE_LIMIT');size+=Number(obj.byteLength);
    need(typeof obj.sha256 === 'string' && /^[0-9a-f]{64}$/.test(obj.sha256));
    need(obj.signature === null || (typeof obj.signature === 'string' && /^[0-9a-f]{128}$/.test(obj.signature)),'INVALID_SIGNATURE');
  }
  need(size<=INGEST_LIMITS.totalBytes,'PACKAGE_SIZE_LIMIT');
  return value as ImportManifest;
}
/** Signature binds original bytes AND tenant/project/run/source/object, not merely the digest. */
export function objectSigningBytes(tenantId:string, manifest:ImportManifest, object:ObjectDescriptor): Buffer {
  const {signature:_,...descriptor}=object;
  return Buffer.from(canonicalize(JSON.stringify({protocol:'INCIDENT-OBJECT-v1',tenantId,projectId:manifest.projectId,runId:manifest.runId,dataAuthorizationRef:manifest.dataAuthorizationRef,dataClass:manifest.dataClass,object:descriptor})));
}

export class IncidentIngest {
  constructor(readonly store:IncidentStore) {}
  registerSource(actor:Actor,raw:unknown): SourceInput {
    exactObject(raw,['schemaVersion','projectId','sourceId','controllerPartyId','kind','allowedWorkflowIds','captureMethod','keyId','publicKey','validFrom','validUntil']);
    need(raw.schemaVersion===1 && identifier(raw.projectId) && identifier(raw.sourceId) && identifier(raw.controllerPartyId) && text(raw.kind));
    need(Array.isArray(raw.allowedWorkflowIds) && raw.allowedWorkflowIds.length>0 && raw.allowedWorkflowIds.length<=100 && raw.allowedWorkflowIds.every(identifier) && new Set(raw.allowedWorkflowIds).size===raw.allowedWorkflowIds.length);
    need((typeof raw.captureMethod === 'string' && ['source_export','gateway_receipt','attested','synthetic'].includes(raw.captureMethod)));
    need(raw.validFrom!==null && timestamp(raw.validFrom) && timestamp(raw.validUntil) && (raw.validUntil===null || String(raw.validUntil)>String(raw.validFrom)));
    need((raw.keyId===null && raw.publicKey===null) || (identifier(raw.keyId) && typeof raw.publicKey==='string' && raw.publicKey.length<=1024),'INVALID_SOURCE_KEY');
    if(raw.publicKey!==null) { try {need(createPublicKey(String(raw.publicKey)).asymmetricKeyType==='ed25519','INVALID_SOURCE_KEY');} catch {need(false,'INVALID_SOURCE_KEY');} }
    const input=raw as SourceInput;
    return this.store.tx(() => {
      this.store.authorize(actor,input.projectId,['enterprise_admin']);
      for(const id of input.allowedWorkflowIds)this.store.get(actor,input.projectId,'workflow',id);
      const previous=this.store.db.prepare('SELECT * FROM incident_sources WHERE id=? AND tenant=? AND project=?').get(input.sourceId,actor.tenantId,input.projectId);
      if(previous) {need(previous.tenant===actor.tenantId && previous.project===input.projectId,'NOT_FOUND',404);need(hash(JSON.parse(String(previous.payload)))===hash(input),'SOURCE_CONFLICT',409);need(previous.revoked_at===null,'SOURCE_REVOKED',409);return input;}
      this.store.db.prepare('INSERT INTO incident_sources VALUES(?,?,?,?,NULL,NULL)').run(input.sourceId,actor.tenantId,input.projectId,JSON.stringify(input));
      this.store.audit(actor.actorId,'register_source',input.sourceId);return input;
    });
  }
  source(actor:Actor,projectId:string,id:string) {
    this.store.authorize(actor,projectId);need(identifier(id));
    const row=this.store.db.prepare('SELECT * FROM incident_sources WHERE id=? AND tenant=? AND project=?').get(id,actor.tenantId,projectId);need(row,'NOT_FOUND',404);
    return {...JSON.parse(String(row.payload)) as SourceInput,revokedAt:row.revoked_at as string|null,revocationReason:row.revocation_reason as string|null};
  }
  revokeSource(actor:Actor,projectId:string,id:string,reason:string) {
    need(text(reason));return this.store.tx(() => {
      this.store.authorize(actor,projectId,['enterprise_admin']);const current=this.source(actor,projectId,id);
      if(current.revokedAt) {need(current.revocationReason===reason,'REVOCATION_CONFLICT',409);return current;}
      this.store.db.prepare('UPDATE incident_sources SET revoked_at=?,revocation_reason=? WHERE id=? AND tenant=? AND project=?').run(new Date().toISOString(),reason,id,actor.tenantId,projectId);
      this.store.audit(actor.actorId,'revoke_source',id);return this.source(actor,projectId,id);
    });
  }
  import(actor:Actor,raw:unknown,key:string): {receipt:ImportReceipt;replayed:boolean} {
    exactObject(raw,['manifest','objects']);const manifest=parseManifest(raw.manifest);need(identifier(key),'IDEMPOTENCY_KEY_REQUIRED');
    need(Array.isArray(raw.objects) && raw.objects.length<=INGEST_LIMITS.objects,'OBJECT_COUNT_LIMIT');
    const bytes=new Map<string,Buffer>();let total=0;
    for(const entry of raw.objects) {
      exactObject(entry,['path','contentBase64']);safeImportPath(entry.path);
      need(!bytes.has(entry.path) && manifest.objects.some(o=>o.path===entry.path),'UNLISTED_OR_DUPLICATE_OBJECT');
      need(typeof entry.contentBase64==='string' && entry.contentBase64.length<=Math.ceil(INGEST_LIMITS.objectBytes/3)*4,'OBJECT_SIZE_LIMIT');
      const content=Buffer.from(entry.contentBase64,'base64');need(content.toString('base64')===entry.contentBase64,'INVALID_BASE64');total+=content.length;bytes.set(entry.path,content);
    }
    need(total<=INGEST_LIMITS.totalBytes,'PACKAGE_SIZE_LIMIT');
    const payloadHash=hash({manifest,presentPaths:[...bytes.keys()].sort()});
    return this.store.tx(() => {
      this.store.authorize(actor,manifest.projectId,['enterprise_admin','collector','fde']);
      const run=this.store.get(actor,manifest.projectId,'run',manifest.runId) as AgentRun;
      const workflow=this.store.get(actor,manifest.projectId,'workflow',run.workflowId) as Workflow;
      need(manifest.dataAuthorizationRef===workflow.dataAuthorizationRef,'AUTHORIZATION_MISMATCH',403);
      need(manifest.dataClass==='synthetic' ? run.environment!=='approved_redacted' : run.environment==='approved_redacted','DATA_CLASS_MISMATCH');
      const objects:ImportReceipt['objects']=[];
      for(const descriptor of manifest.objects) {
        const source=this.source(actor,manifest.projectId,descriptor.sourceId), now=new Date().toISOString();
        need(!source.revokedAt && source.validFrom<=now && (!source.validUntil || source.validUntil>now),'SOURCE_INACTIVE',409);
        need(source.allowedWorkflowIds.includes(run.workflowId),'SOURCE_SCOPE_DENIED',403);
        need(manifest.dataClass==='synthetic' || source.captureMethod!=='synthetic','SOURCE_DATA_CLASS_MISMATCH');
        const content=bytes.get(descriptor.path);if(!content)continue;
        need(content.length===descriptor.byteLength && byteDigest(content)===descriptor.sha256,'OBJECT_DIGEST_MISMATCH',422);
        let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{need(false,'INVALID_UTF8');}
        if(descriptor.mediaType!=='text/plain') {
          try {
            const parsed=descriptor.mediaType==='application/json' ? parseStrictJSON(decoded!) : null;
            const rows=descriptor.mediaType==='application/json' ? (Array.isArray(parsed)?parsed:[parsed]) : decoded!.split(/\r?\n/).filter(line=>line.trim()).map(line=>parseStrictJSON(line));
            let nodes=0;const countNodes=(v:unknown):void=>{if(v && typeof v==='object'){nodes++;need(nodes<=INGEST_LIMITS.records,'RECORD_COUNT_LIMIT');for(const child of Object.values(v))countNodes(child);}};
            rows.forEach(countNodes);need(rows.length>0 && rows.length<=INGEST_LIMITS.records,'RECORD_COUNT_LIMIT');
            // Optional scope assertions in original JSON must agree; nested payload is opaque evidence, not executable metadata.
            for(const row of rows) if(row && typeof row==='object' && !Array.isArray(row)) {
              for(const [field,value] of Object.entries({tenantId:actor.tenantId,projectId:manifest.projectId,runId:manifest.runId,sourceId:descriptor.sourceId})) need(!Object.hasOwn(row,field) || row[field]===value,'ORIGINAL_SCOPE_MISMATCH',422);
            }
          }catch(error){if(error instanceof Error && 'statusCode' in error)throw error;need(false,'INVALID_ORIGINAL_JSON',422);}
        }
        let signatureStatus:'valid'|'unsigned'='unsigned';
        if(source.publicKey!==null) {need(descriptor.signature!==null && verify(null,objectSigningBytes(actor.tenantId,manifest,descriptor),source.publicKey,Buffer.from(descriptor.signature,'hex')),'SIGNATURE_INVALID',422);signatureStatus='valid';}
        else need(descriptor.signature===null,'UNREGISTERED_SIGNATURE_KEY',422);
        const trust = manifest.dataClass==='synthetic' ? 'synthetic' : source.captureMethod==='gateway_receipt' ? (signatureStatus==='valid'?'gateway_received':'unverified') : source.captureMethod==='attested' ? 'attested' : signatureStatus==='valid' ? 'source_signed' : 'unverified';
        objects.push({...descriptor,signatureStatus,trust});
      }
      // Check byte integrity even on retries; never accept altered bytes under an old manifest/key.
      const priorKey=this.store.db.prepare('SELECT digest,import_id FROM incident_import_keys WHERE tenant=? AND project=? AND actor=? AND key=?').get(actor.tenantId,manifest.projectId,actor.actorId,key);
      if(priorKey) {need(priorKey.digest===payloadHash,'IDEMPOTENCY_CONFLICT',409);return {receipt:this.get(actor,manifest.projectId,String(priorKey.import_id)),replayed:true};}
      const priorPackage=this.store.db.prepare('SELECT id,digest FROM incident_imports WHERE tenant=? AND project=? AND package_id=?').get(actor.tenantId,manifest.projectId,manifest.packageId);
      if(priorPackage) {need(priorPackage.digest===payloadHash,'PACKAGE_CONFLICT',409);this.saveKey(actor,manifest.projectId,key,payloadHash,String(priorPackage.id));return {receipt:this.get(actor,manifest.projectId,String(priorPackage.id)),replayed:true};}
      if(manifest.supersedesImportId) {const old=this.get(actor,manifest.projectId,manifest.supersedesImportId);need(old.runId===manifest.runId,'SUPERSEDES_RUN_MISMATCH',409);}
      const receipt:ImportReceipt={schemaVersion:1,importId:randomUUID(),tenantId:actor.tenantId,projectId:manifest.projectId,runId:manifest.runId,packageId:manifest.packageId,receivedAt:new Date().toISOString(),manifestDigest:hash(manifest),manifest,status:objects.length===manifest.objects.length?'accepted':'quarantined',missingPaths:manifest.objects.filter(o=>!bytes.has(o.path)).map(o=>o.path),objects,limitations:['Stored bytes and signature checks do not establish truth, completeness, causation or coverage.','Authorization reference is a local administrative declaration, not independent verification.'],supersedesImportId:manifest.supersedesImportId};
      for(const descriptor of objects) {
        const storedDescriptor=JSON.stringify({runId:manifest.runId,...descriptor});
        const old=this.store.db.prepare('SELECT descriptor,content FROM incident_objects WHERE tenant=? AND project=? AND id=?').get(actor.tenantId,manifest.projectId,descriptor.objectId);
        if(old) need(hash(JSON.parse(String(old.descriptor)))===hash(JSON.parse(storedDescriptor)) && Buffer.from(old.content as Uint8Array).equals(bytes.get(descriptor.path)!),'OBJECT_ID_CONFLICT',409);
        else this.store.db.prepare('INSERT INTO incident_objects VALUES(?,?,?,?,?)').run(actor.tenantId,manifest.projectId,descriptor.objectId,storedDescriptor,bytes.get(descriptor.path)!);
      }
      this.store.db.prepare('INSERT INTO incident_imports VALUES(?,?,?,?,?,?,?)').run(receipt.importId,actor.tenantId,manifest.projectId,manifest.runId,manifest.packageId,payloadHash,JSON.stringify(receipt));
      this.saveKey(actor,manifest.projectId,key,payloadHash,receipt.importId);this.store.audit(actor.actorId,'import_evidence',receipt.importId);
      return {receipt,replayed:false};
    });
  }
  private saveKey(actor:Actor,project:string,key:string,digest:string,id:string) {this.store.db.prepare('INSERT INTO incident_import_keys VALUES(?,?,?,?,?,?)').run(actor.tenantId,project,actor.actorId,key,digest,id);}
  get(actor:Actor,project:string,id:string):ImportReceipt {
    this.store.authorize(actor,project);need(identifier(id));const row=this.store.db.prepare('SELECT payload FROM incident_imports WHERE id=? AND tenant=? AND project=?').get(id,actor.tenantId,project);need(row,'NOT_FOUND',404);return JSON.parse(String(row.payload));
  }
  /** Current evidence use is stricter than authorized historical byte retrieval. */
  usableOriginal(actor:Actor,project:string,importId:string,objectId:string) {
    const result=this.original(actor,project,importId,objectId);
    need(!this.source(actor,project,result.descriptor.sourceId).revokedAt,'SOURCE_REVOKED',409);
    return result;
  }
  original(actor:Actor,project:string,importId:string,objectId:string) {
    const receipt=this.get(actor,project,importId);need(identifier(objectId));const descriptor=receipt.objects.find(o=>o.objectId===objectId);need(descriptor,'NOT_FOUND',404);
    const row=this.store.db.prepare('SELECT content FROM incident_objects WHERE tenant=? AND project=? AND id=?').get(actor.tenantId,project,objectId);need(row,'ORIGINAL_UNAVAILABLE',409);
    const content=Buffer.from(row.content as Uint8Array);need(content.length===descriptor.byteLength && byteDigest(content)===descriptor.sha256,'STORED_ORIGINAL_CORRUPT',409);
    this.store.audit(actor.actorId,'read_original',objectId);return {content,descriptor};
  }
}
