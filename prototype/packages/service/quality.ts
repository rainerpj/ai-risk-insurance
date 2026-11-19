import {keccak256,stringToHex,parseAbiItem,decodeFunctionData} from 'viem';
import {Chain,grantAbi,coreAbi} from './chain.ts';
import {Store,Fault,hash,json} from './store.ts';
import {manualTemplate} from './manual-template.ts';
import {domain,digest} from '../domain/typed-data.ts';
const outcomes=['correct','wrong_payment','underpayment','missed_escalation','wrong_denial'] as const;
const decisionEvent=parseAbiItem('event DecisionRegistered(bytes32 indexed incidentId, bytes32 indexed decisionId, uint64 version, bytes32 digest, uint256 N, uint256 D, uint256 Q)');
export async function historicalDecision(chain:Chain,incidentId:string,version:string,head:any){
 const logs:any[]=await chain.client.getLogs({address:chain.core,event:decisionEvent,args:{incidentId},fromBlock:0n,toBlock:head.number});
 const matches=logs.filter(l=>l.args.version.toString()===version);
 if(matches.length!==1)throw new Fault(409,'DECISION_HISTORY_UNAVAILABLE');
 const log=matches[0],tx=await chain.client.getTransaction({hash:log.transactionHash});
 if(tx.to?.toLowerCase()!==chain.core.toLowerCase()||tx.blockHash!==log.blockHash)throw new Fault(409,'DECISION_TRANSACTION_UNAVAILABLE');
 const call=decodeFunctionData({abi:coreAbi,data:tx.input});
 if(call.functionName!=='registerDecision')throw new Fault(409,'DECISION_TRANSACTION_UNAVAILABLE');
 const d:any=call.args![0],assessment:any=call.args![3];
 if(d.incidentId!==incidentId||d.version.toString()!==version||d.decisionId!==log.args.decisionId||digest('ClaimDecision',Object.fromEntries(Object.entries(d).map(([k,v])=>[k,typeof v==='number'?BigInt(v):v])),domain(chain.core,chain.deploymentId))!==log.args.digest)throw new Fault(409,'DECISION_TRANSACTION_MISMATCH');
 const i={version:d.version,policyId:d.policyId,decision:d,assessment,supervisor:call.args![6],decisionDigest:log.args.digest};
 let g:any=null;
 if([1,2].includes(Number(d.channel))){
  const registry=await chain.read('grantRegistry',[],log.blockNumber);
  const changes:any[]=await chain.client.getLogs({address:registry,event:parseAbiItem('event GrantChanged(bytes32 indexed grantId,uint64 epoch,uint64 budgetVersion,bool enabled)'),args:{grantId:d.grantId},fromBlock:0n,toBlock:log.blockNumber});
  const before=changes.filter(e=>e.blockNumber<log.blockNumber||e.logIndex<log.logIndex).sort((a,b)=>a.blockNumber===b.blockNumber?a.logIndex-b.logIndex:a.blockNumber<b.blockNumber?-1:1);
  const change=before.at(-1);if(!change||change.args.epoch!==d.grantEpoch)throw new Fault(409,'GRANT_HISTORY_UNAVAILABLE');
  const config=await chain.client.getTransaction({hash:change.transactionHash});
  if(config.to?.toLowerCase()!==registry.toLowerCase()||config.blockHash!==change.blockHash)throw new Fault(409,'GRANT_TRANSACTION_UNAVAILABLE');
  const decoded=decodeFunctionData({abi:grantAbi,data:config.input});
  if(!['configure','configureRecovered'].includes(decoded.functionName)||decoded.args![0]!==d.grantId)throw new Fault(409,'GRANT_TRANSACTION_MISMATCH');
  g={...(decoded.args![1] as any),epoch:change.args.epoch};
  if(!g.enabled||g.budgetVersion!==change.args.budgetVersion||g.budgetVersion!==d.budgetVersion||g.channel!==d.channel||g.authorizer.toLowerCase()!==d.approver.toLowerCase()||g.reviewer.toLowerCase()!==assessment.assessor.toLowerCase())throw new Fault(409,'GRANT_TRANSACTION_MISMATCH');
  if((await chain.block(change.blockNumber)).hash!==change.blockHash)throw new Fault(409,'CHAIN_CHANGED');
 }
 if((await chain.block(log.blockNumber)).hash!==log.blockHash)throw new Fault(409,'CHAIN_CHANGED');
 return {i,g,log};
}
export async function discoverTemplateCases(chain:Chain,head:any,triggerId:string,g:any){
 const cases:any[]=[];
 const related:any[]=await chain.client.getLogs({address:chain.core,event:decisionEvent,fromBlock:0n,toBlock:head.number});
 for(const event of related){
  const h=await historicalDecision(chain,event.args.incidentId,event.args.version.toString(),head);
  if(!h.g)continue;
  if(h.g.templateId!==g.templateId)continue;
  const policy=await chain.read('getPolicy',[h.i.policyId],event.blockNumber);
  cases.push({id:keccak256(stringToHex(`${triggerId}:${event.args.incidentId}:${event.args.version}`)),incident:event.args.incidentId,version:event.args.version.toString(),tenant:policy.quote.enterpriseId,
   payload:{templateId:h.g.templateId,ruleVersion:h.g.ruleVersion,modelVersion:h.g.modelVersion,sameVersion:h.g.ruleVersion===g.ruleVersion&&h.g.modelVersion===g.modelVersion,block:event.blockNumber,blockHash:event.blockHash}});
 }
 return cases;
}
/** Human audit only. An anomaly queues an irreversible-to-this-service safety pause, never a clawback. */
export async function recordQuality(s:Store,chain:Chain,actor:any,input:any,governor?:string){
 if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(actor.role))throw new Fault(403,'ROLE_DENIED');
 const {id,incidentId,decisionVersion,outcome,reason}=input??{};
 if(Object.keys(input??{}).sort().join(',')!=='decisionVersion,id,incidentId,outcome,reason'||
  !/^0x[0-9a-f]{64}$/.test(id)||!/^0x[0-9a-f]{64}$/.test(incidentId)||!outcomes.includes(outcome)||
  typeof decisionVersion!=='string'||!/^\d+$/.test(decisionVersion)||typeof reason!=='string'||!reason.trim()||reason.length>10000)throw new Fault(400,'INVALID_QUALITY_REVIEW');
 const old=s.get('SELECT * FROM quality_reviews WHERE id=?',id),ph=hash({actor:actor.address,input});
 if(old){if(old.tenant!==actor.tenant)throw new Fault(404,'NOT_FOUND');if(old.payload_hash!==ph)throw new Fault(409,'ID_CONFLICT');return {id,pauseJob:old.pause_job};}
 await chain.check();const head=await chain.client.getBlock(),current=await chain.read('getIncident',[incidentId],head.number),p=await chain.read('getPolicy',[current.policyId],head.number);
 if(!current.version||p.quote.enterpriseId!==actor.tenant)throw new Fault(404,'NOT_FOUND');
 const {i,g,log}=await historicalDecision(chain,incidentId,decisionVersion,head);
 if([p.quote.insured,p.fde,i.decision.approver,i.assessment.assessor,(i.supervisor as any).supervisor].map((a:string)=>a.toLowerCase()).includes(actor.address)||
  !await chain.read('hasRole',[keccak256(stringToHex(actor.role)),actor.address],head.number))throw new Fault(403,'INDEPENDENT_REVIEW_REQUIRED');
 const automatic=[1,2].includes(Number(i.decision.channel));
 const anomaly=outcome!=='correct';
 if(anomaly&&automatic&&(!governor||!await chain.read('hasRole',[keccak256(stringToHex('GOVERNOR')),governor],head.number)))throw new Fault(503,'SAFETY_GOVERNOR_REQUIRED');
 if(anomaly&&automatic)chain.wallet(governor!); // Fail before accepting feedback if the local safety executor cannot sign.
 const cases=anomaly&&automatic?await discoverTemplateCases(chain,head,id,g):[];
 if((await chain.block(head.number)).hash!==head.hash)throw new Fault(409,'CHAIN_CHANGED');
 const pauseJob=anomaly&&automatic?keccak256(stringToHex('quality-pause:'+s.getMeta('scope')+':'+id)):null;
 const payload={...input,channel:Number(i.decision.channel),templateId:g?.templateId??manualTemplate(s,actor.tenant,i.decision),ruleVersion:g?.ruleVersion??null,modelVersion:g?.modelVersion??null,grantId:i.decision.grantId,grantEpoch:g?.epoch??0n,decisionBlock:log.blockNumber,decisionBlockHash:log.blockHash,decisionDigest:i.decisionDigest,block:head.number,blockHash:head.hash,P:current.P,R:current.R,D:current.D};
 return s.tx(()=>{
  const existing=s.get('SELECT * FROM quality_reviews WHERE id=?',id);if(existing){if(existing.payload_hash!==ph)throw new Fault(409,'ID_CONFLICT');return {id,pauseJob:existing.pause_job};}
  if(pauseJob){const args=[g.templateId,true,keccak256(stringToHex(reason))],action='safetyPauseTemplate';
   s.run("INSERT INTO outbox(id,tenant,actor,action,payload,payload_hash,state) VALUES(?,?,?,?,?,?,'queued')",pauseJob,actor.tenant,governor!.toLowerCase(),action,json(args),hash({action,args,actor:governor!.toLowerCase()}));}
  s.run('INSERT INTO quality_reviews VALUES(?,?,?,?,?,?,?,?)',id,actor.tenant,incidentId,actor.address,json(payload),ph,pauseJob,new Date().toISOString());
  for(const c of cases)s.run('INSERT INTO quality_cases VALUES(?,?,?,?,?,?)',c.id,id,c.tenant,c.incident,c.version,json(c.payload));
  if(anomaly&&!automatic)s.run('INSERT INTO quality_cases VALUES(?,?,?,?,?,?)',keccak256(stringToHex('manual-quality:'+id)),id,actor.tenant,incidentId,decisionVersion,json({templateId:payload.templateId,ruleVersion:null,modelVersion:null,sameVersion:true,channel:0,block:log.blockNumber,blockHash:log.blockHash}));
  s.audit(actor.address,'quality_review',id);return {id,pauseJob};
 });
}
export async function qualityCases(s:Store,chain:Chain,tenant:string){
 // Catch decisions mined between the original feedback snapshot and its pause transaction.
 await chain.check();const scanHead=await chain.client.getBlock(),discovered:any[]=[];
 for(const trigger of s.all('SELECT * FROM quality_reviews WHERE pause_job IS NOT NULL')){
  const proof=JSON.parse(trigger.payload);
  if(proof.decisionBlock===undefined||BigInt(proof.block)>scanHead.number||BigInt(proof.decisionBlock)>scanHead.number)continue;
  if((await chain.block(BigInt(proof.block))).hash!==proof.blockHash||(await chain.block(BigInt(proof.decisionBlock))).hash!==proof.decisionBlockHash)continue;
  for(const item of await discoverTemplateCases(chain,scanHead,trigger.id,proof))discovered.push({...item,trigger:trigger.id});
 }
 if((await chain.block(scanHead.number)).hash!==scanHead.hash)throw new Fault(409,'CHAIN_CHANGED');
 s.tx(()=>{for(const c of discovered)s.run('INSERT INTO quality_cases VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',c.id,c.trigger,c.tenant,c.incident,c.version,json(c.payload));});
 const rows=s.all('SELECT * FROM quality_cases WHERE tenant=? ORDER BY rowid',tenant),reviews=await qualityStatus(s,chain,tenant);
 for(const row of rows){row.payload=JSON.parse(row.payload);row.state='pending';
  const followup=reviews.find(r=>r.incident===row.incident&&r.payload.decisionVersion===row.decision_version&&r.id!==row.trigger_id&&r.proof_state==='canonical'&&
   s.get('SELECT rowid n FROM quality_reviews WHERE id=?',r.id).n>s.get('SELECT rowid n FROM quality_reviews WHERE id=?',row.trigger_id).n);
  if(followup){row.state='reviewed';row.review_id=followup.id;row.outcome=followup.payload.outcome;}
  try{const head=await chain.client.getBlock();if(BigInt(row.payload.block)>head.number||(await chain.block(BigInt(row.payload.block))).hash!==row.payload.blockHash)row.state='recheck_required';}catch{row.state='unavailable';}
 }
 return rows;
}
export function qualityReviews(s:Store,tenant:string){return s.all('SELECT q.*,o.state AS pause_state FROM quality_reviews q LEFT JOIN outbox o ON q.pause_job=o.id WHERE q.tenant=? ORDER BY q.rowid DESC',tenant).map(r=>({...r,payload:JSON.parse(r.payload)}));}
/** Verify both historical decision and observation snapshots. A safety pause is never automatically undone. */
export async function qualityStatus(s:Store,chain:Chain,tenant:string){
 const reviews=qualityReviews(s,tenant);
 for(const r of reviews){
  r.proof_state='unavailable';
  try{await chain.check();const head=await chain.client.getBlock();
   const points=[[r.payload.block,r.payload.blockHash],...(r.payload.decisionBlock!==undefined?[[r.payload.decisionBlock,r.payload.decisionBlockHash]]:[])];
   let orphaned=false;for(const [height,hash] of points)if(BigInt(height)>head.number||(await chain.block(BigInt(height))).hash!==hash)orphaned=true;
   r.proof_state=orphaned?'recheck_required':r.payload.decisionBlock===undefined?'legacy_proof_requires_review':'canonical';
   if((await chain.block(head.number)).hash!==head.hash)r.proof_state='unavailable';
  }catch{r.proof_state='unavailable';}
 }
 return reviews;
}
