import {Store} from './store.ts';
import {Chain} from './chain.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {metricDistribution} from './metrics.ts';
import {historicalDecision} from './quality.ts';
import {manualTemplate} from './manual-template.ts';
import {pendingIntakeCosts} from './intake-metrics.ts';
import {pendingIntakeQuality} from './intake-quality.ts';

/** Notice counts are not incident counts. Never infer incident identity from a free-text declaration. */
export async function workloadMetrics(s:Store,chain:Chain,tenant:string,observedAt=Date.now()){
 const locals=s.all('SELECT id,received_at FROM notices WHERE tenant=?',tenant);
 const unavailable=(state:string)=>({state,localAccepted:locals.length,counts:null,pending:null,channels:null,templates:null,incidentDenominator:null,closure:null,automaticClosureRate:null});
 const height=s.getMeta('confirmed'),proof=s.getMeta('projectionHash'),config=s.getMeta('indexConfig');
 if(height===undefined||!proof||!config)return unavailable('not_ready');
 if(s.getMeta('indexError')||s.getMeta('halted'))return unavailable('unavailable');
 try{
  await chain.check();const head=await chain.block(BigInt(height));if(head.hash!==proof)return unavailable('unavailable');
  const notices=s.all("SELECT id,payload FROM views WHERE kind='notice' AND tenant=?",tenant),incidents=s.all("SELECT id,payload FROM views WHERE kind='incident' AND tenant=?",tenant);
  const confirmed=new Map(notices.map(n=>[n.id,JSON.parse(n.payload)])),all=new Set([...locals.map(n=>n.id),...confirmed.keys()]);
  const byIncident=new Map(incidents.map(i=>[i.id,JSON.parse(i.payload)]));
  const closures=new Map(s.all('SELECT * FROM claim_closures WHERE tenant=? AND active=1',tenant).map(c=>[c.incident,c]));
  const closureCounts=(ids:string[])=>({closed:ids.filter(id=>closures.has(id)).length,automaticClosed:ids.filter(id=>closures.get(id)?.automatic===1).length,automaticUnknown:ids.filter(id=>closures.get(id)?.automatic===null).length});
  const observations=s.all("SELECT e.payload,o.confirmed_observed_at FROM events e JOIN decision_observations o ON e.block_hash=o.block_hash AND e.tx_hash=o.tx_hash AND e.log_index=o.log_index WHERE e.canonical=1 AND e.name='DecisionRegistered' AND e.number<=?",Number(height));
  const times=new Map<string,number>();for(const row of observations){const e=JSON.parse(row.payload);times.set(e.incidentId+':'+e.version,row.confirmed_observed_at);}
  const timingStarted=Number(s.getMeta('timingStartedAt'));
  const elapsed=(id:string,end:number|undefined)=>{
   const receipts=locals.filter(n=>confirmed.get(n.id)?.incidentId===id).map(n=>Date.parse(n.received_at));
   if(!receipts.length||receipts.some(t=>!Number.isSafeInteger(t)))return null;
   const start=Math.min(...receipts);
   if(!Number.isSafeInteger(timingStarted)||start<timingStarted||end===undefined||end<start)return null;
   return BigInt(end-start);
  };
  const duration=(id:string,i:any)=>elapsed(id,times.get(id+':'+i.version));
  let bound=0,unbound=0,localOnly=0;
  for(const id of all){const n=confirmed.get(id);if(!n){localOnly++;continue;}if(n.incidentId===zeroHash){unbound++;continue;}if(!byIncident.has(n.incidentId))return unavailable('unavailable');bound++;}
  // Pending notices may merge into one incident. Do not classify them by a future decision or omit them as successful cases.
  const receipts=new Map(locals.map(n=>[n.id,Date.parse(n.received_at)]));
  const pendingIds=[...all].filter(id=>!confirmed.has(id)||confirmed.get(id).incidentId===zeroHash);
  const validClock=Number.isSafeInteger(observedAt)&&observedAt>=0&&observedAt<=8640000000000000;
  const ages=pendingIds.map(id=>{const start=receipts.get(id);return validClock&&start!==undefined&&Number.isSafeInteger(start)&&start>=0&&start<=observedAt?BigInt(observedAt-start):null;});
  const pending={noticeIds:pendingIds.length,localOnlyNotices:localOnly,unboundConfirmedNotices:unbound,
   observedAt:validClock?new Date(observedAt).toISOString():null,
   waitingMs:{...metricDistribution(ages.filter((v):v is bigint=>v!==null)),unknown:ages.filter(v=>v===null).length},
   incidentCount:null,channel:null,templateId:null,qualityRate:null,intakeCosts:pendingIntakeCosts(s,tenant,pendingIds),intakeQuality:await pendingIntakeQuality(s,chain,tenant,pendingIds,height),
   basis:'unbound confirmed or local-only notice IDs; waiting since local durable receipt, includes downtime; no inferred incident, channel, template or quality outcome'};
  const closureStats=(ids:string[])=>{
   const counts=closureCounts(ids),measured=ids.filter(id=>closures.has(id)).map(id=>elapsed(id,closures.get(id).observed_at));
   return {...counts,automaticClosureRate:localOnly+unbound===0&&counts.automaticUnknown===0&&ids.length>0?{numerator:counts.automaticClosed,denominator:ids.length}:null,
    closureObservedMs:{...metricDistribution(measured.filter((v):v is bigint=>v!==null)),unknown:measured.filter(v=>v===null).length,basis:'earliest local receipt to first confirmed observation of current settlement closure; includes downtime; open incidents excluded'}};
  };
  const channels=[0,1,2].map(channel=>{
   const rows=[...byIncident.values()].filter(i=>Number(i.decision.channel)===channel);
   const measured=[...byIncident.entries()].filter(([,i])=>Number(i.decision.channel)===channel).map(([id,i])=>duration(id,i));
   return {channel,incidents:rows.length,...closureStats([...byIncident.keys()].filter(id=>Number(byIncident.get(id).decision.channel)===channel)),decisionObservedMs:{...metricDistribution(measured.filter((v):v is bigint=>v!==null)),unknown:measured.filter(v=>v===null).length,basis:'earliest local receipt to first confirmed observation of current decision version; includes downtime; not payment or closure duration'},withDue:rows.filter(i=>BigInt(i.D)>0n).length,withRecoveryDue:rows.filter(i=>BigInt(i.Q)>0n).length,frozen:rows.filter(i=>i.frozen).length,manualHold:rows.filter(i=>i.manualHold).length,activeDispute:rows.filter(i=>i.activeDispute!==zeroHash).length};
  });
  const grouped=new Map<string,{channel:number;templateId:string|null;incidents:number;ids:string[];times:(bigint|null)[]}>();
  for(const [id,i] of byIncident){
   const channel=Number(i.decision.channel);
   // Manual classification must match the signed reason; never infer it from a later Grant.
   let templateId:string|null=manualTemplate(s,tenant,i.decision);
   if(channel===1||channel===2){const historical=await historicalDecision(chain,id,String(i.version),head);
    if(historical.i.decisionDigest!==i.decisionDigest||historical.g?.enterpriseId!==tenant)throw Error('WORKLOAD_HISTORY_MISMATCH');
    templateId=historical.g.templateId;
   }
   const key=JSON.stringify([channel,templateId]),group=grouped.get(key)??{channel,templateId,incidents:0,ids:[],times:[]};
   group.incidents++;group.ids.push(id);group.times.push(duration(id,i));grouped.set(key,group);
  }
  const templates=[...grouped.values()].map(g=>({channel:g.channel,templateId:g.templateId,attribution:g.templateId?(g.channel===0?'signed-manual-reason':'decision-time-grant'):'manual-template-unrecorded',incidents:g.incidents,...closureStats(g.ids),
   decisionObservedMs:{...metricDistribution(g.times.filter((v):v is bigint=>v!==null)),unknown:g.times.filter(v=>v===null).length}}));
  if(s.getMeta('confirmed')!==height||s.getMeta('projectionHash')!==proof||(await chain.block(BigInt(height))).hash!==proof)return unavailable('unavailable');
  const closure=closureStats([...byIncident.keys()]);
  return {state:'available',checkpoint:{height,hash:proof,...JSON.parse(config)},localAccepted:locals.length,
   basis:'union of durable local notice IDs and confirmed indexed notice IDs; bound incidents deduplicated by chain ID',
   counts:{noticeIds:all.size,confirmedNotices:notices.length,localOnlyNotices:localOnly,unboundConfirmedNotices:unbound,boundNotices:bound,decidedIncidents:incidents.length},
   incidentDenominator:localOnly+unbound===0?incidents.length:null,pending,channels,templates,closure,
   automaticClosureRate:localOnly+unbound===0&&closure.automaticUnknown===0&&incidents.length>0?{numerator:closure.automaticClosed,denominator:incidents.length}:null,
   closureBasis:'confirmed-settlement-v1: D=Q=0, no freeze or active dispute; automatic requires complete automatic decision history and no manualHold; later state changes invalidate; no capacity release',
   limitations:'pending notices may merge; rate denominator is all deduplicated decided incidents only when no unbound/local-only notices remain; classification missing history is unknown'};
 }catch{return unavailable('unavailable');}
}

