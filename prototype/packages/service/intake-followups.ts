import {Store,json} from './store.ts';
import {Chain} from './chain.ts';
import {discoverTemplateCases,qualityStatus} from './quality.ts';
import {verifyRoutingProof} from './routing-proof.ts';

/** Scan every historical decision of affected templates, including decisions mined after the original feedback. */
export async function intakeFollowups(s:Store,chain:Chain,tenant:string){
 await chain.check();const head=await chain.client.getBlock(),discovered:any[]=[],validTriggers=new Set<string>();
 for(const trigger of s.all('SELECT * FROM intake_quality ORDER BY rowid')){
  const p=JSON.parse(trigger.payload);if(p.disposition!=='pending_independent_resolution'||!p.routingProofs?.length)continue;
  if(BigInt(p.block)>head.number||(await chain.block(BigInt(p.block))).hash!==p.blockHash)continue;
  for(const proof of p.routingProofs){
   const route=await verifyRoutingProof(chain,s.getMeta('scope')!,trigger.tenant,trigger.notice_id,proof);
   for(const c of await discoverTemplateCases(chain,head,trigger.id,route))discovered.push({...c,trigger:trigger.id});
  }
  validTriggers.add(trigger.id);
 }
 if((await chain.block(head.number)).hash!==head.hash)throw Error('CHAIN_CHANGED');
 s.tx(()=>{for(const c of discovered)s.run('INSERT INTO intake_followups VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',c.id,c.trigger,c.tenant,c.incident,c.version,json(c.payload));});
 const rows=s.all('SELECT * FROM intake_followups WHERE tenant=? ORDER BY rowid',tenant),reviews=await qualityStatus(s,chain,tenant);
 for(const row of rows){
  row.payload=JSON.parse(row.payload);row.state='pending';row.review_id=null;
  const p=row.payload,trigger=s.get('SELECT actor,created_at FROM intake_quality WHERE id=?',row.trigger_id);
  if(!validTriggers.has(row.trigger_id)||BigInt(p.block)>head.number||(await chain.block(BigInt(p.block))).hash!==p.blockHash){row.state='recheck_required';continue;}
  const latest=reviews.find(r=>r.incident===row.incident&&r.payload.decisionVersion===row.decision_version&&r.created_at>=trigger.created_at);
  if(latest){row.review_id=latest.id;row.state=latest.proof_state==='canonical'&&latest.actor!==trigger.actor?(latest.payload.outcome==='correct'?'reviewed':'anomaly_requires_resolution'):'recheck_required';}
 }
 if((await chain.block(head.number)).hash!==head.hash)throw Error('CHAIN_CHANGED');
 return {checkpoint:{height:head.number.toString(),hash:head.hash},cases:rows,limitation:'reviewed is not permission to resume; anomalies require the existing decision-quality resolution and the original intake finding must also be resolved'};
}
