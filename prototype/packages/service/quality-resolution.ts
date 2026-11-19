import {keccak256,stringToHex} from 'viem';
import {Store,Fault,hash,json} from './store.ts';
import {Chain} from './chain.ts';
import {historicalDecision,qualityStatus} from './quality.ts';
import {zeroHash} from '../domain/typed-data.ts';

/** Two independent human opinions, pinned to current financial state. This never grants execution rights. */
export async function resolveQuality(s:Store,chain:Chain,actor:any,input:any){
 if(actor.role!=='SUPERVISOR')throw new Fault(403,'SUPERVISOR_REQUIRED');
 if(!input||Object.keys(input).sort().join()!=='caseId,id,reason,reviewId,type'||!['id','caseId','reviewId'].every(k=>/^0x[a-f0-9]{64}$/.test(input[k]))||!['corrected','false_alarm'].includes(input.type)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>10000)throw new Fault(400,'RESOLUTION_SCHEMA');
 const c=s.get('SELECT * FROM quality_cases WHERE id=? AND tenant=?',input.caseId,actor.tenant);if(!c)throw new Fault(404,'NOT_FOUND');
 const fingerprint=hash({actor:actor.address,input}),prior=s.get('SELECT * FROM quality_resolutions WHERE id=?',input.id);
 if(prior){if(prior.tenant!==actor.tenant||prior.payload_hash!==fingerprint)throw new Fault(409,'RESOLUTION_ID_CONFLICT');return {id:prior.id};}
 await chain.check();const head=await chain.client.getBlock(),i=await chain.read('getIncident',[c.incident],head.number),policy=await chain.read('getPolicy',[i.policyId],head.number);
 const source=JSON.parse(c.payload);if((await chain.block(BigInt(source.block))).hash!==source.blockHash)throw new Fault(409,'CASE_SOURCE_REORGED');
 const {i:decision}=await historicalDecision(chain,c.incident,String(i.version),head);
 const forbidden=[policy.quote.insured,policy.fde,decision.assessment.assessor,decision.decision.approver,(decision.supervisor as any).supervisor].map((a:string)=>a.toLowerCase());
 if(policy.quote.enterpriseId!==actor.tenant||forbidden.includes(actor.address)||!await chain.read('hasRole',[keccak256(stringToHex('SUPERVISOR')),actor.address],head.number))throw new Fault(403,'INDEPENDENT_SUPERVISOR_REQUIRED');
 const reviews=await qualityStatus(s,chain,actor.tenant),review=reviews.find(r=>r.id===input.reviewId),trigger=reviews.find(r=>r.id===c.trigger_id);
 if(!review||!trigger||review.proof_state!=='canonical'||trigger.proof_state!=='canonical'||review.id===trigger.id||review.actor===actor.address||review.payload.outcome!=='correct'||review.incident!==c.incident||review.payload.decisionVersion!==String(i.version)||review.payload.decisionDigest!==i.decisionDigest||s.get('SELECT rowid n FROM quality_reviews WHERE id=?',review.id).n<=s.get('SELECT rowid n FROM quality_reviews WHERE id=?',trigger.id).n)throw new Fault(409,'INDEPENDENT_CURRENT_REVIEW_REQUIRED');
 const newer=()=>s.all('SELECT payload FROM quality_reviews WHERE tenant=? AND incident=? AND rowid>(SELECT rowid FROM quality_reviews WHERE id=?)',actor.tenant,c.incident,review.id).some(r=>JSON.parse(r.payload).decisionVersion===String(i.version));
 if(newer())throw new Fault(409,'REVIEW_SUPERSEDED');
 if(i.frozen||i.activeDispute!==zeroHash||i.Q>0n)throw new Fault(409,'UNRESOLVED_INCIDENT');
 if(input.type==='corrected'&&(i.version<=BigInt(c.decision_version)||i.D>0n))throw new Fault(409,'CORRECTION_NOT_COMPLETED');
 if(input.type==='false_alarm'&&i.version!==BigInt(c.decision_version))throw new Fault(409,'FALSE_ALARM_VERSION_CHANGED');
 const ledgerHash=await chain.read('ledgerHash',[i.policyId,c.incident],head.number),payload={...input,incidentId:c.incident,decisionVersion:i.version,decisionDigest:i.decisionDigest,ledgerHash,policyId:i.policyId,block:head.number,blockHash:head.hash,reviewBlock:review.payload.block,reviewBlockHash:review.payload.blockHash};
 if((await chain.block(head.number)).hash!==head.hash)throw new Fault(409,'CHAIN_CHANGED');
 return s.tx(()=>{const concurrent=s.get('SELECT payload_hash FROM quality_resolutions WHERE id=?',input.id);if(concurrent){if(concurrent.payload_hash!==fingerprint)throw new Fault(409,'RESOLUTION_ID_CONFLICT');return {id:input.id};}
  if(newer())throw new Fault(409,'REVIEW_SUPERSEDED');
  s.run('INSERT INTO quality_resolutions VALUES(?,?,?,?,?,?,?)',input.id,c.id,actor.tenant,actor.address,json(payload),fingerprint,new Date().toISOString());s.audit(actor.address,'quality_resolution',input.id);return {id:input.id};});
}

export async function resolutionCases(s:Store,chain:Chain,tenant:string,cases:any[]){
 for(const c of cases){
  const row=s.get('SELECT * FROM quality_resolutions WHERE case_id=? AND tenant=? ORDER BY rowid DESC LIMIT 1',c.id,tenant);if(!row)continue;
  const p=JSON.parse(row.payload);c.resolution={id:row.id,actor:row.actor,payload:p,state:'unavailable'};
  try{await chain.check();const head=await chain.client.getBlock();
   const canonical=(await chain.block(BigInt(p.block))).hash===p.blockHash&&(await chain.block(BigInt(p.reviewBlock))).hash===p.reviewBlockHash;
   const current=await chain.read('ledgerHash',[p.policyId,p.incidentId],head.number);
   const incident=await chain.read('getIncident',[p.incidentId],head.number);
   const settled=!incident.frozen&&incident.activeDispute===zeroHash&&incident.Q===0n&&(p.type!=='corrected'||incident.D===0n);
   const newer=s.all('SELECT payload FROM quality_reviews WHERE tenant=? AND incident=? AND rowid>(SELECT rowid FROM quality_reviews WHERE id=?)',tenant,p.incidentId,p.reviewId).some(r=>JSON.parse(r.payload).decisionVersion===p.decisionVersion);
   c.resolution.state=canonical&&current===p.ledgerHash&&settled&&!newer?'current':'recheck_required';
   if((await chain.block(head.number)).hash!==head.hash)c.resolution.state='unavailable';
  }catch{}
  if(c.resolution.state==='current')c.state='resolved';else c.state=c.resolution.state==='unavailable'?'unavailable':'recheck_required';
 }
 return cases;
}
