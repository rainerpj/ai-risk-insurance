import {keccak256,stringToHex} from 'viem';
import {Store,Fault,hash,json} from './store.ts';
import {Chain} from './chain.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {qualityStatus,historicalDecision} from './quality.ts';
import {verifyRoutingProof} from './routing-proof.ts';
import type {OperationsOptions} from './operations.ts';
const roles=['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'];
const outcomes=['no_issue_observed','missed_escalation','unpaid_obligation','unverifiable'];
/** Snapshot all local inputs and participants; new documents or draft signatures require a new review. */
export function intakeQualitySource(s:Store,tenant:string,noticeId:string){
 const n=s.get('SELECT payload_hash,binding,owner FROM notices WHERE id=? AND tenant=?',noticeId,tenant);
 if(!n)throw new Fault(404,'NOT_FOUND');
 const drafts=s.all('SELECT id,payload,signatures FROM drafts WHERE tenant=? ORDER BY id',tenant).filter(r=>JSON.parse(r.payload).noticeIds?.includes(noticeId));
 const evidence=s.all('SELECT id,digest FROM evidence WHERE notice_id=? AND tenant=? ORDER BY id',noticeId,tenant);
 const excluded=new Set<string>([n.owner.toLowerCase()]);
 for(const r of drafts){const d=JSON.parse(r.payload),sig=JSON.parse(r.signatures);for(const a of [d.assessment?.assessor,d.d?.approver,sig.supervisor?.supervisor])if(a)excluded.add(a.toLowerCase());}
 return {digest:hash({notice:n,evidence,drafts}),excluded};
}
const source=intakeQualitySource;
function newerOpinion(s:Store,tenant:string,p:any){
 const table=p.type==='false_alarm'?'intake_quality':'quality_reviews',key=p.type==='false_alarm'?'notice_id':'incident',value=p.type==='false_alarm'?p.noticeId:p.incidentId;
 return !!s.get(`SELECT id FROM ${table} WHERE tenant=? AND ${key}=? AND rowid>(SELECT rowid FROM ${table} WHERE id=?) LIMIT 1`,tenant,value,p.reviewId);
}
export async function resolveIntakeQuality(s:Store,chain:Chain,actor:any,input:any){
 if(actor.role!=='SUPERVISOR')throw new Fault(403,'SUPERVISOR_REQUIRED');
 if(!input||Object.keys(input).sort().join()!=='id,reason,reviewId,triggerId,type'||!['id','triggerId','reviewId'].every(k=>typeof input[k]==='string'&&/^0x[a-f0-9]{64}$/.test(input[k]))||!['false_alarm','corrected'].includes(input.type)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>10000)throw new Fault(400,'INTAKE_RESOLUTION_SCHEMA');
 const trigger=s.get('SELECT * FROM intake_quality WHERE id=? AND tenant=?',input.triggerId,actor.tenant);if(!trigger)throw new Fault(404,'NOT_FOUND');
 const t=JSON.parse(trigger.payload),address=actor.address.toLowerCase(),local=source(s,actor.tenant,trigger.notice_id);
 if(t.disposition!=='pending_independent_resolution')throw new Fault(409,'ANOMALY_REQUIRED');
 await chain.check();const head=await chain.client.getBlock(),notice=await chain.read('getNotice',[trigger.notice_id],head.number),policy=await chain.read('getPolicy',[t.policyId],head.number);
 if(!notice.anchoredAt||notice.digest!==t.noticeDigest||policy.quote.enterpriseId!==actor.tenant)throw new Fault(409,'NOTICE_PROOF_CHANGED');
 for(const a of [policy.quote.insured,policy.fde,trigger.actor])local.excluded.add(a.toLowerCase());
 if(local.excluded.has(address)||!await chain.read('hasRole',[keccak256(stringToHex('SUPERVISOR')),address],head.number))throw new Fault(403,'INDEPENDENT_SUPERVISOR_REQUIRED');
 const fingerprint=hash({actor:address,input}),prior=s.get('SELECT * FROM intake_resolutions WHERE id=?',input.id);
 if(prior){if(prior.tenant!==actor.tenant||prior.payload_hash!==fingerprint)throw new Fault(409,'RESOLUTION_ID_CONFLICT');return {id:prior.id};}
 if(BigInt(t.block)>head.number||(await chain.block(BigInt(t.block))).hash!==t.blockHash)throw new Fault(409,'TRIGGER_REORGED');
 let review:any,ledgerHash:string|null=null,incidentId:string|null=null;
 if(input.type==='false_alarm'){
  if(notice.incidentId!==zeroHash||local.digest!==t.sourceHash)throw new Fault(409,'FALSE_ALARM_SOURCE_CHANGED');
  review=(await intakeQualityStatus(s,chain,actor.tenant)).find(r=>r.id===input.reviewId);
  if(!review||review.notice_id!==trigger.notice_id||review.proof_state!=='canonical'||review.payload.outcome!=='no_issue_observed'||review.payload.sourceHash!==local.digest||s.get('SELECT rowid n FROM intake_quality WHERE id=?',review.id).n<=s.get('SELECT rowid n FROM intake_quality WHERE id=?',trigger.id).n)throw new Fault(409,'INDEPENDENT_CURRENT_REVIEW_REQUIRED');
 }else{
  if(notice.incidentId===zeroHash)throw new Fault(409,'CORRECTION_NOT_COMPLETED');
  incidentId=notice.incidentId;const i=await chain.read('getIncident',[incidentId],head.number),h=await historicalDecision(chain,incidentId!,String(i.version),head);
  for(const a of [h.i.assessment.assessor,h.i.decision.approver,(h.i.supervisor as any).supervisor])local.excluded.add(a.toLowerCase());
  if(local.excluded.has(address))throw new Fault(403,'INDEPENDENT_SUPERVISOR_REQUIRED');
  if(Number(i.decision.channel)!==0||i.D>0n||i.Q>0n||i.frozen||i.activeDispute!==zeroHash||h.log.blockNumber<=BigInt(t.block))throw new Fault(409,'CORRECTION_NOT_COMPLETED');
  review=(await qualityStatus(s,chain,actor.tenant)).find(r=>r.id===input.reviewId);
  if(!review||review.incident!==incidentId||review.proof_state!=='canonical'||review.payload.outcome!=='correct'||review.payload.decisionDigest!==i.decisionDigest||review.payload.decisionVersion!==String(i.version)||BigInt(review.payload.block)<=BigInt(t.block))throw new Fault(409,'INDEPENDENT_CURRENT_REVIEW_REQUIRED');
  ledgerHash=await chain.read('ledgerHash',[t.policyId,incidentId],head.number);
 }
 if([address,trigger.actor].includes(review.actor))throw new Fault(409,'INDEPENDENT_CURRENT_REVIEW_REQUIRED');
 const payload={...input,noticeId:trigger.notice_id,policyId:t.policyId,sourceHash:local.digest,noticeDigest:notice.digest,incidentId,ledgerHash,block:head.number,blockHash:head.hash,reviewBlock:review.payload.block,reviewBlockHash:review.payload.blockHash};
 if(newerOpinion(s,actor.tenant,payload))throw new Fault(409,'REVIEW_SUPERSEDED');
 if((await chain.block(head.number)).hash!==head.hash)throw new Fault(409,'CHAIN_CHANGED');
 return s.tx(()=>{const old=s.get('SELECT * FROM intake_resolutions WHERE id=?',input.id);if(old){if(old.payload_hash!==fingerprint||old.tenant!==actor.tenant)throw new Fault(409,'RESOLUTION_ID_CONFLICT');return {id:old.id};}
  if(source(s,actor.tenant,trigger.notice_id).digest!==local.digest)throw new Fault(409,'INTAKE_SOURCE_CHANGED');
  if(newerOpinion(s,actor.tenant,payload))throw new Fault(409,'REVIEW_SUPERSEDED');
  s.run('INSERT INTO intake_resolutions VALUES(?,?,?,?,?,?,?)',input.id,trigger.id,actor.tenant,address,json(payload),fingerprint,new Date().toISOString());s.audit(address,'intake_resolution',input.id);return {id:input.id};});
}
export async function recordIntakeQuality(s:Store,chain:Chain,actor:any,input:any,options:OperationsOptions={}){
 if(!roles.includes(actor.role))throw new Fault(403,'ROLE_DENIED');
 if(!input||Object.keys(input).sort().join()!=='id,noticeId,outcome,reason'||!['id','noticeId'].every(k=>typeof input[k]==='string'&&/^0x[a-f0-9]{64}$/.test(input[k]))||!outcomes.includes(input.outcome)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>10000)throw new Fault(400,'INTAKE_QUALITY_SCHEMA');
 const local=source(s,actor.tenant,input.noticeId),address=actor.address.toLowerCase();
 await chain.check();const head=await chain.client.getBlock();
 if(!await chain.read('hasRole',[keccak256(stringToHex(actor.role)),address],head.number))throw new Fault(403,'INDEPENDENT_REVIEW_REQUIRED');
 const ph=hash({actor:address,input}),old=s.get('SELECT * FROM intake_quality WHERE id=?',input.id);
 if(old){if(old.tenant!==actor.tenant)throw new Fault(404,'NOT_FOUND');if(old.payload_hash!==ph)throw new Fault(409,'ID_CONFLICT');return {id:old.id};}
 const notice=await chain.read('getNotice',[input.noticeId],head.number);
 if(!notice.anchoredAt)throw new Fault(409,'NOTICE_IDENTITY_UNVERIFIED');
 if(notice.incidentId!==zeroHash)throw new Fault(409,'USE_DECISION_QUALITY_REVIEW');
 const policy=await chain.read('getPolicy',[notice.data.policyId],head.number);
 if(!policy.issuedAt||policy.quote.enterpriseId!==actor.tenant)throw new Fault(404,'NOT_FOUND');
 for(const a of [policy.quote.insured,policy.fde])local.excluded.add(a.toLowerCase());
 if(local.excluded.has(address))throw new Fault(403,'INDEPENDENT_REVIEW_REQUIRED');
 const routes:any[]=[];
 if(options.intakePortal?.routing){
  const response=await options.intakePortal.routing(actor.tenant);
  if(response.scope!==s.getMeta('scope')||response.tenant!==actor.tenant||!Array.isArray(response.observations))throw new Fault(503,'ROUTING_OBSERVER_SCOPE');
  for(const proof of response.observations.filter((r:any)=>r.payload?.noticeId===input.noticeId)){
   const route=await verifyRoutingProof(chain,s.getMeta('scope')!,actor.tenant,input.noticeId,proof);
   if(BigInt(route.block)>head.number)throw new Fault(409,'ROUTING_PROOF_AHEAD');
   if([route.reviewer,route.authorizer].includes(address))throw new Fault(403,'INDEPENDENT_REVIEW_REQUIRED');
   routes.push(proof);
  }
 }
 const anomaly=['missed_escalation','unpaid_obligation'].includes(input.outcome),templates=[...new Set<string>(routes.map(r=>r.payload.templateId))];
 const pauseJobs=anomaly?templates.map(templateId=>({templateId,id:keccak256(stringToHex('intake-pause:'+s.getMeta('scope')+':'+input.id+':'+templateId))})):[];
 if(pauseJobs.length){if(!options.safetyGovernor||!await chain.read('hasRole',[keccak256(stringToHex('GOVERNOR')),options.safetyGovernor],head.number))throw new Fault(503,'SAFETY_GOVERNOR_REQUIRED');chain.wallet(options.safetyGovernor);}
 if((await chain.block(head.number)).hash!==head.hash)throw new Fault(409,'CHAIN_CHANGED');
 const payload={...input,sourceHash:local.digest,block:head.number,blockHash:head.hash,noticeDigest:notice.digest,policyId:notice.data.policyId,channel:null,templateId:null,routingProofs:routes,pauseJobs,
  disposition:['missed_escalation','unpaid_obligation'].includes(input.outcome)?'pending_independent_resolution':'observation_only',
  limitation:'notice-level human finding; no claim approval, denial, payment, incident denominator or automatic template attribution'};
 return s.tx(()=>{
  const concurrent=s.get('SELECT * FROM intake_quality WHERE id=?',input.id);
  if(concurrent){if(concurrent.tenant!==actor.tenant)throw new Fault(404,'NOT_FOUND');if(concurrent.payload_hash!==ph)throw new Fault(409,'ID_CONFLICT');return {id:concurrent.id};}
  if(source(s,actor.tenant,input.noticeId).digest!==local.digest)throw new Fault(409,'INTAKE_SOURCE_CHANGED');
  for(const job of pauseJobs){const args=[job.templateId,true,keccak256(stringToHex(input.reason))],action='safetyPauseTemplate',governor=options.safetyGovernor!.toLowerCase();s.run("INSERT INTO outbox(id,tenant,actor,action,payload,payload_hash,state) VALUES(?,?,?,?,?,?,'queued')",job.id,actor.tenant,governor,action,json(args),hash({action,args,actor:governor}));}
  s.run('INSERT INTO intake_quality VALUES(?,?,?,?,?,?,?)',input.id,input.noticeId,actor.tenant,address,json(payload),ph,new Date().toISOString());s.audit(address,'intake_quality',input.id);return {id:input.id};
 });
}
export async function intakeQualityStatus(s:Store,chain:Chain,tenant:string){
 const rows=s.all('SELECT id,notice_id,actor,payload,created_at FROM intake_quality WHERE tenant=? ORDER BY rowid DESC',tenant).map(r=>{const payload=JSON.parse(r.payload);return {...r,payload,proof_state:'unavailable',currentlyPending:null as boolean|null,resolution:null as any,pauseStates:(payload.pauseJobs??[]).map((j:any)=>({...j,state:s.get('SELECT state FROM outbox WHERE id=? AND tenant=?',j.id,tenant)?.state??'unavailable'}))};});
 try{
  await chain.check();const head=await chain.client.getBlock();
  for(const r of rows){
   const p=r.payload;
   if(BigInt(p.block)>head.number||(await chain.block(BigInt(p.block))).hash!==p.blockHash){r.proof_state='recheck_required';continue;}
   if(source(s,tenant,r.notice_id).digest!==p.sourceHash){r.proof_state='source_changed';continue;}
   const current=await chain.read('getNotice',[r.notice_id],head.number);
   if(current.digest!==p.noticeDigest){r.proof_state='recheck_required';continue;}
   r.proof_state='canonical';r.currentlyPending=current.incidentId===zeroHash;
  }
  for(const r of rows){
   const saved=s.get('SELECT * FROM intake_resolutions WHERE trigger_id=? AND tenant=? ORDER BY rowid DESC LIMIT 1',r.id,tenant);if(!saved)continue;
   const p=JSON.parse(saved.payload);r.resolution={id:saved.id,actor:saved.actor,payload:p,state:'recheck_required'};
   const canonical=BigInt(p.block)<=head.number&&BigInt(p.reviewBlock)<=head.number&&(await chain.block(BigInt(p.block))).hash===p.blockHash&&(await chain.block(BigInt(p.reviewBlock))).hash===p.reviewBlockHash;
   const notice=await chain.read('getNotice',[r.notice_id],head.number);
   const incident=p.type==='corrected'?await chain.read('getIncident',[p.incidentId],head.number):null;
   const unchanged=p.type==='false_alarm'?notice.incidentId===zeroHash:notice.incidentId===p.incidentId&&incident.D===0n&&incident.Q===0n&&!incident.frozen&&incident.activeDispute===zeroHash&&(await chain.read('ledgerHash',[p.policyId,p.incidentId],head.number))===p.ledgerHash;
   if(canonical&&unchanged&&notice.digest===p.noticeDigest&&source(s,tenant,r.notice_id).digest===p.sourceHash&&!newerOpinion(s,tenant,p))r.resolution.state='current';
  }
  if((await chain.block(head.number)).hash!==head.hash)throw Error('CHAIN_CHANGED');
 }catch{for(const r of rows){r.proof_state='unavailable';r.currentlyPending=null;if(r.resolution)r.resolution.state='unavailable';}}
 return rows;
}
export async function pendingIntakeQuality(s:Store,chain:Chain,tenant:string,noticeIds:string[],confirmedHeight:string){
 const rows=await intakeQualityStatus(s,chain,tenant),pending=new Set(noticeIds),latest=new Map<string,any>();
 for(const r of rows)if(pending.has(r.notice_id)&&!latest.has(r.notice_id))latest.set(r.notice_id,r);
 const verified=[...latest.values()].filter(r=>r.proof_state==='canonical'&&r.currentlyPending&&BigInt(r.payload.block)<=BigInt(confirmedHeight)&&r.payload.outcome!=='unverifiable');
 const counts=Object.fromEntries(outcomes.map(outcome=>[outcome,verified.filter(r=>r.payload.outcome===outcome).length]));
 return {basis:'latest independent intake review at or before confirmed workload checkpoint; notice IDs, not incidents or decision versions',noticeIds:pending.size,
  reviewedNotices:verified.length,unreviewedOrUnverifiable:pending.size-verified.length,outcomes:counts,
  rate:null,channel:null,templateId:null,
  unresolvedFindings:rows.filter(r=>r.payload.disposition==='pending_independent_resolution'&&r.resolution?.state!=='current').length,
  limitation:'all anomaly records remain unresolved until a separately verified disposition; later opinions and binding do not resolve them; no invented channel/template attribution'};
}

