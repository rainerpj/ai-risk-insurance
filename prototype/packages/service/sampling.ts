import {Chain} from './chain.ts';
import {Store,hash,json} from './store.ts';
import {historicalDecision,qualityStatus} from './quality.ts';

export const samplingPolicy={version:'initial-full-review-v1',percent:100,mode:'all-confirmed-automatic-decisions'} as const;
/** Initial pilot: all automatic decisions. No endpoint may silently lower the sampling ratio. */
export async function refreshSampling(s:Store,chain:Chain){
 if(s.getMeta('halted')||s.getMeta('indexError'))throw Error('SAMPLING_INDEX_UNAVAILABLE');
 const config=s.getMeta('indexConfig'),confirmed=s.getMeta('confirmed');if(!config||confirmed===undefined)throw Error('SAMPLING_INDEX_NOT_READY');
 await chain.check();const height=BigInt(confirmed),head=await chain.block(height),indexed=s.get('SELECT hash FROM blocks WHERE number=? AND canonical=1',Number(height));
 if(!indexed||indexed.hash!==head.hash)throw Error('SAMPLING_CHECKPOINT_CHANGED');
 const found:any[]=[];
 for(const row of s.all("SELECT * FROM events WHERE canonical=1 AND name='DecisionRegistered' AND number<=? ORDER BY number,log_index",Number(height))){
  const e=JSON.parse(row.payload),h=await historicalDecision(chain,e.incidentId,e.version,head);if(!h.g)continue;
  if(h.log.blockHash!==row.block_hash||h.log.transactionHash!==row.tx_hash||Number(h.log.logIndex)!==row.log_index)throw Error('SAMPLING_SOURCE_CHANGED');
  const policy=await chain.read('getPolicy',[h.i.policyId],head.number);
  const payload={policyId:h.i.policyId,channel:Number(h.i.decision.channel),templateId:h.g.templateId,ruleVersion:h.g.ruleVersion,modelVersion:h.g.modelVersion,decisionDigest:h.i.decisionDigest,block:row.number,blockHash:row.block_hash,transactionHash:row.tx_hash,logIndex:row.log_index,policy:samplingPolicy};
  found.push({id:hash({scope:s.getMeta('scope'),block:row.block_hash,tx:row.tx_hash,log:row.log_index}),tenant:policy.quote.enterpriseId,incident:e.incidentId,version:String(e.version),payload});
 }
 if((await chain.block(height)).hash!==head.hash)throw Error('SAMPLING_CHECKPOINT_CHANGED');
 s.tx(()=>{
  s.run('UPDATE quality_samples SET canonical=0');
  for(const r of found){
   const prior=s.get('SELECT id FROM quality_samples WHERE id=?',r.id);
   s.run('INSERT INTO quality_samples VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET canonical=1',r.id,r.tenant,r.incident,r.version,json(r.payload),new Date().toISOString());
   if(!prior)s.audit('quality-sampler','sample_selected',r.id);
  }
  s.meta('samplingCheckpoint',json({height:height.toString(),hash:head.hash,indexConfig:JSON.parse(config),policy:samplingPolicy}));s.meta('samplingError','');
 });
}
export async function samplingStatus(s:Store,chain:Chain,tenant:string){
 const saved=s.getMeta('samplingCheckpoint'),checkpoint=saved?JSON.parse(saved):null;
 let available=!!checkpoint&&!s.getMeta('indexError')&&!s.getMeta('halted')&&!s.getMeta('samplingError');
 try{await chain.check();if(checkpoint&&(await chain.block(BigInt(checkpoint.height))).hash!==checkpoint.hash)available=false;}catch{available=false;}
 const reviews=available?await qualityStatus(s,chain,tenant):[],rows=s.all('SELECT * FROM quality_samples WHERE tenant=? ORDER BY rowid DESC',tenant);
 for(const row of rows){
  row.payload=JSON.parse(row.payload);row.reviewId=null;row.outcome=null;row.state=available?(row.canonical?'pending':'recheck_required'):'unavailable';
  if(row.state!=='pending')continue;
  try{if((await chain.block(BigInt(row.payload.block))).hash!==row.payload.blockHash){row.state='recheck_required';continue;}}catch{row.state='unavailable';continue;}
  const review=reviews.find(r=>r.proof_state==='canonical'&&r.incident===row.incident&&r.payload.decisionVersion===row.decision_version&&r.payload.decisionDigest===row.payload.decisionDigest&&r.payload.decisionBlockHash===row.payload.blockHash);
  if(review){row.state='reviewed';row.reviewId=review.id;row.outcome=review.payload.outcome;}
 }
 if(available)try{if((await chain.block(BigInt(checkpoint.height))).hash!==checkpoint.hash)available=false;}catch{available=false;}
 if(!available)for(const row of rows){row.state='unavailable';row.reviewId=null;row.outcome=null;}
 return {state:available?'available':saved?'unavailable':'not_ready',policy:samplingPolicy,checkpoint,coverage:'all automatic decision versions within the confirmed index range; not all notices or manual claims',counts:{selected:rows.filter(r=>r.canonical).length,pending:rows.filter(r=>r.state==='pending').length,reviewed:rows.filter(r=>r.state==='reviewed').length,recheckRequired:rows.filter(r=>r.state==='recheck_required').length,unavailable:rows.filter(r=>r.state==='unavailable').length},cases:rows};
}
