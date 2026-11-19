import { randomUUID } from 'node:crypto';
import { canonicalize } from '../domain/evidence.ts';
import { IncidentFault,exactObject,identifier,requireIncident as need,type Actor,type AgentRun } from '../domain/incident-schema.ts';
import { parseRoi,calculateRoi,type RoiInput } from '../domain/incident-roi.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentIngest,byteDigest } from './incident-ingest.ts';
export class IncidentRoi {
 constructor(readonly store:IncidentStore){}
 private history(actor:Actor,project:string,workflowId:string,period?:string){this.store.get(actor,project,'workflow',workflowId);return this.store.db.prepare("SELECT payload FROM records WHERE tenant_id=? AND project_id=? AND kind='roi_period' ORDER BY seq").all(actor.tenantId,project).map(r=>JSON.parse(String(r.payload))).filter(r=>r.workflowId===workflowId&&(!period||r.period===period));}
 private evaluate(actor:Actor,project:string,workflowId:string,input:RoiInput){const normalized=structuredClone(input),checks=new Map<string,any>(),ingest=new IncidentIngest(this.store);
  for(const group of normalized.groups)for(const line of [...group.scenarios.flatMap(s=>s.lines),...group.platform.costs,...group.platform.revenues]){line.sourceRefs=line.sourceRefs.map(ref=>{if(!checks.has(ref)){const [importId,objectId]=ref.split('/'),receipt=ingest.get(actor,project,importId!);const run=this.store.get(actor,project,'run',receipt.runId) as AgentRun;need(run.workflowId===workflowId&&receipt.status==='accepted','ROI_SOURCE_SCOPE',422);const source=ingest.original(actor,project,importId!,objectId!),registration=ingest.source(actor,project,source.descriptor.sourceId);need(!registration.revokedAt,'ROI_SOURCE_REVOKED',409);checks.set(ref,{ref,sha256:source.descriptor.sha256,trust:source.descriptor.trust,dataClass:receipt.manifest.dataClass});}return checks.get(ref).sha256;});}
  return {calculation:calculateRoi(normalized),sourceChecks:[...checks.values()],independentlyVerified:false};
 }
 put(actor:Actor,workflowId:string,period:string,raw:unknown,key:string){need(/^\d{4}-(0[1-9]|1[0-2])$/.test(period),'INVALID_PERIOD');exactObject(raw,['projectId','expectedVersion','input']);need(identifier(raw.projectId)&&identifier(key)&&Number.isSafeInteger(raw.expectedVersion)&&Number(raw.expectedVersion)>=0);const input=parseRoi(raw.input),project=raw.projectId,digest=byteDigest(canonicalize(JSON.stringify({workflowId,period,...raw})));
  return this.store.tx(()=>{this.store.authorize(actor,project,['enterprise_admin']);const history=this.history(actor,project,workflowId,period),prior=this.store.db.prepare('SELECT payload_hash,record_id FROM requests WHERE tenant_id=? AND project_id=? AND actor_id=? AND operation=? AND key=?').get(actor.tenantId,project,actor.actorId,'roi_period',key);if(prior){need(prior.payload_hash===digest,'IDEMPOTENCY_CONFLICT',409);const row=this.store.db.prepare('SELECT payload FROM records WHERE id=?').get(String(prior.record_id))!;return {record:JSON.parse(String(row.payload)),replayed:true};}
   need((history.at(-1)?.version??0)===raw.expectedVersion,'ROI_VERSION_CONFLICT',409);const evaluation=this.evaluate(actor,project,workflowId,input),record={recordId:randomUUID(),workflowId,period,modelVersion:'partner-roi-v1',currencyConversion:false,version:Number(raw.expectedVersion)+1,actorId:actor.actorId,createdAt:new Date().toISOString(),input,...evaluation};
   this.store.db.prepare('INSERT INTO records(id,kind,tenant_id,project_id,payload) VALUES(?,?,?,?,?)').run(record.recordId,'roi_period',actor.tenantId,project,JSON.stringify(record));this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run(actor.tenantId,project,actor.actorId,'roi_period',key,digest,record.recordId);this.store.audit(actor.actorId,'register_roi_period',record.recordId);return {record,replayed:false};
  });
 }
 get(actor:Actor,project:string,workflowId:string){return this.store.tx(()=>{
  const history=this.history(actor,project,workflowId),latest=new Map<string,any>();for(const r of history)latest.set(r.period,r);
  const periods=[...latest.values()].map(r=>{
   try{return {...r,...this.evaluate(actor,project,workflowId,r.input),sourceStatus:'available',sourceError:null};}
   catch(error){
    // Only evidence failures are isolated; authorization, database and programming errors still fail the request.
    if(!(error instanceof IncidentFault)||!['ROI_SOURCE_SCOPE','ROI_SOURCE_REVOKED','ORIGINAL_UNAVAILABLE','STORED_ORIGINAL_CORRUPT','NOT_FOUND'].includes(error.message))throw error;
    return {...r,calculation:null,sourceChecks:[],independentlyVerified:false,sourceStatus:'unavailable',sourceError:error.message};
   }
  });
  this.store.audit(actor.actorId,'read_roi_periods',workflowId);return {periods,history,historyIsSnapshot:true};
 });}
}
