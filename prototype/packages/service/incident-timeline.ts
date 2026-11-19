import { canonicalize, parseStrictJSON } from '../domain/evidence.ts';
import { identifier, timestamp, requireIncident as need, type Actor, type AgentRun } from '../domain/incident-schema.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentIngest, byteDigest, type ImportReceipt } from './incident-ingest.ts';
import { IncidentApproval } from './incident-approval.ts';

export type TimelineEvent = {
  eventId:string; sourceId:string; sourceSequence:string|null; eventType:string;
  occurredAt:string|null; capturedAt:string|null; receivedAt:string; previousDigest:string|null;
  supersedes:string|null; versionRefs:string[]; approvalRef:string|null;
  actionDigest?:string;
  digest:string; trust:string; importId:string; objectId:string; row:number;
  adapter:'event-v1'|'n04-worker'|'n04-gate'; warnings:string[];
};
const nullableId=(v:unknown)=>v===null||identifier(v);
const seq=(v:unknown)=>v===null||(typeof v==='string'&&/^(0|[1-9]\d{0,77})$/.test(v));
/** Digest of the canonical original event record, including its previousDigest. */
export const eventDigest=(v:unknown)=>byteDigest(canonicalize(JSON.stringify(v)));
function normalize(raw:any, receipt:ImportReceipt, object:ImportReceipt['objects'][number], row:number):TimelineEvent|null {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const common={sourceId:object.sourceId,receivedAt:receipt.receivedAt,trust:object.trust,importId:receipt.importId,objectId:object.objectId,row,digest:eventDigest(raw),warnings:[] as string[]};
  if(raw.protocol==='INCIDENT-EVENT-v1'||raw.protocol==='INCIDENT-EVENT-v2') {
    const keys=['protocol','eventId','sourceSequence','eventType','occurredAt','capturedAt','previousDigest','supersedes','versionRefs','approvalRef',...(raw.protocol==='INCIDENT-EVENT-v2'?['actionDigest']:[])];
    if(raw.protocol==='INCIDENT-EVENT-v2')need(typeof raw.actionDigest==='string'&&/^[0-9a-f]{64}$/.test(raw.actionDigest),'INVALID_ACTION_DIGEST');
    need(Object.keys(raw).every(k=>keys.includes(k))&&keys.every(k=>Object.hasOwn(raw,k)),'INVALID_EVENT_FIELDS');
    need(identifier(raw.eventId)&&identifier(raw.eventType)&&seq(raw.sourceSequence)&&timestamp(raw.occurredAt)&&timestamp(raw.capturedAt)&&nullableId(raw.supersedes)&&nullableId(raw.approvalRef),'INVALID_EVENT');
    need(raw.previousDigest===null||(typeof raw.previousDigest==='string'&&/^[0-9a-f]{64}$/.test(raw.previousDigest)),'INVALID_EVENT_DIGEST');
    need(Array.isArray(raw.versionRefs)&&raw.versionRefs.length<=100&&raw.versionRefs.every((x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=256),'INVALID_EVENT_VERSIONS');
    return {...common,...Object.fromEntries(keys.filter(k=>k!=='protocol').map(k=>[k,raw[k]])),adapter:'event-v1'} as TimelineEvent;
  }
  if(raw.protocol==='N04-WORKER-RESULT-v1') {
    need(object.trust==='synthetic'&&['baseline-test','candidate-test','deploy','monitor','rollback'].includes(raw.phase)&&raw.startedAt!==null&&timestamp(raw.startedAt)&&raw.finishedAt!==null&&timestamp(raw.finishedAt),'INVALID_N04_EVENT');
    return {...common,eventId:object.objectId,sourceSequence:null,eventType:raw.phase,occurredAt:raw.startedAt,capturedAt:raw.finishedAt,previousDigest:null,supersedes:null,versionRefs:typeof raw.codeDigest==='string'?[`sha256:${raw.codeDigest}`]:[],approvalRef:null,adapter:'n04-worker'};
  }
  if(raw.protocol==='N04-EXECUTION-GATE-v1') {
    need(object.trust==='synthetic'&&raw.recordedAt!==null&&timestamp(raw.recordedAt)&&raw.perRevisionHumanApproval===null,'INVALID_N04_GATE');
    return {...common,eventId:object.objectId,sourceSequence:null,eventType:'synthetic-execution-gate',occurredAt:raw.recordedAt,capturedAt:null,previousDigest:null,supersedes:null,versionRefs:typeof raw.targetDigest==='string'?[`sha256:${raw.targetDigest}`]:[],approvalRef:null,adapter:'n04-gate',warnings:['NOT_HUMAN_REVISION_APPROVAL']};
  }
  return null;
}

export function analyzeEvents(events:TimelineEvent[]):TimelineEvent[] {
  const output=structuredClone(events), byId=new Map<string,TimelineEvent[]>();
  const warn=(e:TimelineEvent,w:string)=>{if(!e.warnings.includes(w))e.warnings.push(w);};
  for(const e of output) {
    const key=`${e.sourceId}/${e.eventId}`;byId.set(key,[...(byId.get(key)??[]),e]);
    if(e.occurredAt===null||e.capturedAt===null)warn(e,'CLOCK_UNKNOWN');
    if((e.occurredAt&&e.capturedAt&&e.occurredAt>e.capturedAt)||(e.capturedAt&&e.capturedAt>e.receivedAt)||(e.occurredAt&&e.occurredAt>e.receivedAt))warn(e,'CLOCK_CONFLICT');
    if(e.sourceSequence===null)warn(e,'SEQUENCE_UNKNOWN');
  }
  for(const group of byId.values())if(group.length>1)for(const e of group)warn(e,new Set(group.map(x=>x.digest)).size===1?'DUPLICATE_EVENT':'EVENT_ID_CONFLICT');
  for(const e of output) {
    if(e.supersedes) {
      const target=byId.get(`${e.sourceId}/${e.supersedes}`);
      if(!target)warn(e,'CORRECTION_TARGET_MISSING');
      else if(e.supersedes===e.eventId||target.length!==1||byId.get(`${e.sourceId}/${e.eventId}`)!.length!==1)warn(e,'CORRECTION_AMBIGUOUS');
      else {
        const visited=new Set([e.eventId]);let current:TimelineEvent|undefined=e,cycle=false;
        while(current?.supersedes){if(visited.has(current.supersedes)){cycle=true;break;}visited.add(current.supersedes);current=byId.get(`${e.sourceId}/${current.supersedes}`)?.[0];}
        if(cycle)warn(e,'CORRECTION_CYCLE');else {warn(e,'CORRECTION_RECORD');warn(target[0]!,'HAS_CORRECTION');}
      }
    }
    const source=output.filter(x=>x.sourceId===e.sourceId);
    if(e.sourceSequence!==null) {
      const n=BigInt(e.sourceSequence),same=source.filter(x=>x.sourceSequence===e.sourceSequence);
      if(same.length>1)warn(e,'SEQUENCE_CONFLICT');
      const previous=source.filter(x=>x.sourceSequence!==null&&BigInt(x.sourceSequence)===n-1n);
      if(n>1n&&!previous.length)warn(e,'SEQUENCE_GAP');
      if(e.previousDigest!==null) {
        if(previous.length!==1)warn(e,'CHAIN_PREDECESSOR_UNAVAILABLE');
        else if(previous[0]!.digest!==e.previousDigest)warn(e,'CHAIN_MISMATCH');
      }else warn(e,'CHAIN_UNKNOWN');
      if(previous.some(x=>x.occurredAt&&e.occurredAt&&x.occurredAt>e.occurredAt))warn(e,'SOURCE_CLOCK_REVERSED');
    }else if(e.previousDigest!==null)warn(e,'CHAIN_PREDECESSOR_UNAVAILABLE');
    const occurred=e.occurredAt;
    if(occurred&&source.some(x=>x.receivedAt<e.receivedAt&&x.occurredAt&&x.occurredAt>occurred))warn(e,'LATE_ARRIVAL');
    e.warnings.sort();
  }
  const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
  return output.sort((a,b)=>cmp(a.occurredAt??a.receivedAt,b.occurredAt??b.receivedAt)||cmp(a.sourceId,b.sourceId)||cmp(a.eventId,b.eventId)||cmp(a.importId,b.importId)||cmp(a.objectId,b.objectId)||a.row-b.row||cmp(a.digest,b.digest));
}

export function incidentTimeline(store:IncidentStore,actor:Actor,projectId:string,runId:string) {
  // One read snapshot prevents a concurrent import appearing only in part of a response.
  return store.tx(()=>{
    const run=store.get(actor,projectId,'run',runId) as AgentRun,ingest=new IncidentIngest(store);
    const receipts=store.db.prepare('SELECT payload FROM incident_imports WHERE tenant=? AND project=? AND run_id=? ORDER BY id').all(actor.tenantId,projectId,runId).map(r=>JSON.parse(String(r.payload)) as ImportReceipt);
    need(receipts.length<=100,'TIMELINE_IMPORT_LIMIT',413);
    const events:TimelineEvent[]=[],materials:{importId:string;objectId:string;path:string;status:string;detail?:string}[]=[];
    for(const receipt of receipts) {
      for(const missing of receipt.manifest.objects.filter(o=>receipt.missingPaths.includes(o.path)))materials.push({importId:receipt.importId,objectId:missing.objectId,path:missing.path,status:'missing'});
      for(const object of receipt.objects) {
        const ref={importId:receipt.importId,objectId:object.objectId,path:object.path};
        try {
          const bytes=ingest.usableOriginal(actor,projectId,receipt.importId,object.objectId).content;
          if(object.mediaType==='text/plain'){materials.push({...ref,status:'supporting-material'});continue;}
          const parsed=object.mediaType==='application/json'?parseStrictJSON(bytes.toString('utf8')):bytes.toString('utf8').split(/\r?\n/).filter(x=>x.trim()).map(x=>parseStrictJSON(x));
          const rows=Array.isArray(parsed)?parsed:[parsed];let found=0;
          rows.forEach((raw,i)=>{try{const event=normalize(raw,receipt,object,i+1);if(event){events.push(event);found++;}}catch{materials.push({...ref,status:'invalid-event',detail:`row ${i+1}`});}});
          materials.push({...ref,status:found?'parsed-events':'supporting-material'});
        }catch{materials.push({...ref,status:'unavailable-or-corrupt'});}
      }
    }
    need(events.length<=5000,'TIMELINE_EVENT_LIMIT',413);
    const approvals=new IncidentApproval(store);
    return {schemaVersion:1,run,events:analyzeEvents(events).map(e=>({...e,approvalCheck:approvals.check(actor,run,e)})),materials,imports:receipts.map(r=>({importId:r.importId,status:r.status,receivedAt:r.receivedAt,supersedesImportId:r.supersedesImportId})),missingCapture:run.captureCoverage.missing,limitations:['Time order is not causation. Source sequence and digest links do not prove complete capture.','Binding checks verify local recorded authorization and byte versions, not historical execution truth or insurance approval.','N04 adapters expose synthetic observations, not independent human revision approval.']};
  });
}
