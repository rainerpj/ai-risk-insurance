import {parseAbiItem} from 'viem';
import {Store,hash} from './store.ts';
import {Chain,grantAbi} from './chain.ts';
import {Budget} from './budget.ts';
import {qualityCases,qualityStatus} from './quality.ts';
import {resolutionCases} from './quality-resolution.ts';
import {intakeQualityStatus} from './intake-quality.ts';
import {intakeFollowups} from './intake-followups.ts';
import {zeroHash} from '../domain/typed-data.ts';

/** Governor-side read-only gate. A positive report does not sign, unpause, release debt or enable a Grant. */
export type RecoveryBudget=Pick<Budget,'meta'|'get'|'all'>;
export async function recoveryReadiness(s:Store,chain:Chain,templateId:string,budgets:ReadonlyMap<string,RecoveryBudget>,confirmations=2){
 if(!/^0x[a-f0-9]{64}$/.test(templateId)||!Number.isSafeInteger(confirmations)||confirmations<1)throw Error('RECOVERY_SCHEMA');
 await chain.check();const tip=await chain.client.getBlockNumber({cacheTime:0}),height=tip-BigInt(confirmations-1),head=await chain.block(height),registry=await chain.read('grantRegistry',[],height),reasons:string[]=[];
 const read=(name:string,args:any[])=>chain.client.readContract({address:registry,abi:grantAbi,functionName:name,args,blockNumber:height});
 const governanceRevision=String(await read('governanceRevision',[]));
 if(!await read('disabledVersion',[templateId]))reasons.push('CONFIRMED_TEMPLATE_PAUSE_REQUIRED');
 for(const channel of [1,2])if(await read('approvalEnabled',[channel])||await read('paymentEnabled',[channel]))reasons.push('CONFIRMED_CHANNEL_PAUSE_REQUIRED');
 const events:any[]=await chain.client.getLogs({address:registry,event:parseAbiItem('event GrantChanged(bytes32 indexed grantId,uint64 epoch,uint64 budgetVersion,bool enabled)'),fromBlock:0n,toBlock:height});
 const grants:any[]=[];
 for(const id of new Set(events.map(e=>e.args.grantId))){const g=await read('getGrant',[id]);if(g.templateId!==templateId)continue;grants.push({id,epoch:g.epoch.toString(),enabled:g.enabled,authorizer:g.authorizer});if(g.enabled)reasons.push('AFFECTED_GRANT_REVOCATION_REQUIRED');}
 if(!grants.length)reasons.push('AFFECTED_GRANTS_NOT_FOUND');
 // Discover cross-enterprise affected decisions before enumerating tenants, including enterprises with no review yet.
 await qualityCases(s,chain,zeroHash);await intakeFollowups(s,chain,zeroHash);
 const tenants=new Set(s.all('SELECT tenant FROM quality_reviews UNION SELECT tenant FROM quality_cases UNION SELECT tenant FROM intake_quality UNION SELECT tenant FROM intake_followups').map(r=>r.tenant));let triggers=0,cases=0,unresolved=0;
 const qualityProofs:{tenant:string;digest:string}[]=[];
 for(const tenant of tenants){
  const reviews=await qualityStatus(s,chain,tenant),related=reviews.filter(r=>r.payload.templateId===templateId&&r.pause_job);
  triggers+=related.length;if(related.some(r=>r.proof_state!=='canonical'))reasons.push('QUALITY_TRIGGER_UNVERIFIED');
  const rows=(await resolutionCases(s,chain,tenant,await qualityCases(s,chain,tenant))).filter(c=>c.payload.templateId===templateId);
  cases+=rows.length;unresolved+=rows.filter(c=>c.state!=='resolved').length;
  const intake=(await intakeQualityStatus(s,chain,tenant)).filter(r=>r.payload.pauseJobs?.some((j:any)=>j.templateId===templateId));
  const followups=(await intakeFollowups(s,chain,tenant)).cases.filter(c=>c.payload.templateId===templateId);
  triggers+=intake.length;cases+=intake.length+followups.length;
  const missing=intake.filter(r=>r.resolution?.state!=='current'||BigInt(r.resolution.payload.block)>height).length+followups.filter(c=>c.state!=='reviewed').length;
  unresolved+=missing;if(missing)reasons.push('INTAKE_QUALITY_UNRESOLVED');
  if(intake.some(r=>BigInt(r.payload.block)>height))reasons.push('INTAKE_TRIGGER_NOT_CONFIRMED');
  for(const c of followups){const review=reviews.find(r=>r.id===c.review_id);if(!review||BigInt(review.payload.block)>height)reasons.push('INTAKE_FOLLOWUP_NOT_CONFIRMED');}
  // Counts alone cannot bind the selected review/resolution: replacements can preserve all counts.
  qualityProofs.push({tenant,digest:hash({reviews:[...reviews].sort((a,b)=>a.id.localeCompare(b.id)),cases:[...rows].sort((a,b)=>a.id.localeCompare(b.id)),intake,followups})});
 }
 if(!triggers||!cases)reasons.push('QUALITY_COVERAGE_MISSING');if(unresolved)reasons.push('QUALITY_CASES_UNRESOLVED');
 const budgetProofs:any[]=[];
 for(const owner of new Set(grants.map(g=>g.authorizer.toLowerCase()))){
  const budget=budgets.get(owner);if(!budget||budget.meta('scope')!==s.getMeta('scope')){reasons.push('AUTHORIZER_BUDGET_UNAVAILABLE');continue;}
  if(budget.meta('ready')!=='1')reasons.push('BUDGET_RECONCILIATION_REQUIRED');
  const last=budget.get("SELECT payload FROM history WHERE action='reconcile' ORDER BY id DESC LIMIT 1"),reconciled=last?JSON.parse(last.payload):null;
  if(!reconciled||String(reconciled.height)!==height.toString()||reconciled.hash!==head.hash)reasons.push('BUDGET_CHECKPOINT_MISMATCH');
  const pending=budget.all("SELECT id FROM payments WHERE state NOT IN ('confirmed','released')");if(pending.length)reasons.push('PAYMENTS_UNRESOLVED');
  budgetProofs.push({authorizer:owner,pending:pending.length,reservations:budget.all('SELECT id,remaining,state FROM reservations')});
 }
 // Reports are invalid if the chain advanced during multi-service evidence collection. Re-run instead of guessing.
 if(await chain.client.getBlockNumber({cacheTime:0})!==tip||(await chain.block(height)).hash!==head.hash)reasons.push('RECOVERY_SNAPSHOT_CHANGED');
 const report={scope:s.getMeta('scope'),templateId,governanceRevision,height:height.toString(),blockHash:head.hash,ready:reasons.length===0,reasons:[...new Set(reasons)],grants,coverage:{triggers,cases,unresolved},qualityProofs,budgetProofs};
 return {...report,digest:hash(report),effect:'read-only; separate governed execution and fresh Grants required'};
}
