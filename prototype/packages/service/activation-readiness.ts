import {parseAbiItem,keccak256,stringToHex} from 'viem';
import {Store,hash,json} from './store.ts';
import {Chain,grantAbi} from './chain.ts';
import {readBudgetUsage} from './budget.ts';
import type {RecoveryBudget} from './recovery-readiness.ts';
import {qualityCases,qualityStatus} from './quality.ts';
import {resolutionCases} from './quality-resolution.ts';

export type ActivationRequest={kind:'configure';grantId:string;grant:any}|{kind:'enable';grantId:string;approve:boolean;pay:boolean};
/** Both stages bind the original confirmed recovery; enabling examines every active Grant on the global channel. */
export async function activationReadiness(s:Store,chain:Chain,recoveryId:string,request:ActivationRequest,budgets:ReadonlyMap<string,RecoveryBudget>,confirmations=2){
 if(!/^0x[a-f0-9]{64}$/.test(recoveryId)||!/^0x[a-f0-9]{64}$/.test(request.grantId)||!['configure','enable'].includes(request.kind)||!Number.isSafeInteger(confirmations)||confirmations<1)throw Error('ACTIVATION_SCHEMA');
 if(request.kind==='enable'&&(typeof request.approve!=='boolean'||typeof request.pay!=='boolean'||!request.approve&&!request.pay))throw Error('ACTIVATION_SCHEMA');
 await chain.check();const tip=await chain.client.getBlockNumber({cacheTime:0}),height=tip-BigInt(confirmations-1),head=await chain.block(height),registry=await chain.read('grantRegistry',[],height);
 const read=(name:string,args:any[])=>chain.client.readContract({address:registry,abi:grantAbi,functionName:name,args,blockNumber:height});
 const recovery=s.get('SELECT * FROM recovery_plans WHERE id=?',recoveryId);
 if(!recovery||recovery.state!=='confirmed'||!recovery.receipt)throw Error('CONFIRMED_RECOVERY_REQUIRED');
 const original=JSON.parse(recovery.payload),receipt=JSON.parse(recovery.receipt);
 if(hash(original)!==recovery.payload_hash||original.report.scope!==s.getMeta('scope')||BigInt(receipt.blockNumber)>height||(await chain.block(BigInt(receipt.blockNumber))).hash!==receipt.blockHash)throw Error('RECOVERY_PROOF_INVALID');
 const evidence=`0x${recovery.payload_hash}`,templateId=original.templateId,reasons:string[]=[];
 if(await read('recoveryEvidence',[templateId])!==evidence||await read('disabledVersion',[templateId]))reasons.push('RECOVERY_EVIDENCE_INVALIDATED');
 const current=await read('getGrant',[request.grantId]),target=request.kind==='configure'?request.grant:current;
 if(!target||target.templateId!==templateId||![1,2].includes(Number(target.channel)))throw Error('RECOVERY_TEMPLATE_OR_CHANNEL');
 const governanceRevision=String(await read('governanceRevision',[])),channels=[];
 // Validate proposal fields through the same fixed contract entry point before persisting a signing job.
 try{
  let functionName='enableRecoveredChannel',args:any[]=[request.grantId,request.kind==='enable'&&request.approve,request.kind==='enable'&&request.pay,BigInt(governanceRevision),evidence,original.reason];
  if(request.kind==='configure'){
   const g={...target,channel:Number(target.channel)};
   for(const field of ['budgetVersion','validFrom','validUntil','epoch','reviewLimit'])g[field]=BigInt(g[field]);
   functionName='configureRecovered';args=[request.grantId,g,BigInt(governanceRevision),evidence];
  }
  await chain.client.simulateContract({address:registry,abi:grantAbi,functionName,args,account:original.actor,blockNumber:height});
 }catch{reasons.push('ACTIVATION_CONTRACT_VALIDATION_FAILED');}
 for(const channel of [1,2]){const approve=await read('approvalEnabled',[channel]),pay=await read('paymentEnabled',[channel]);channels.push({channel,approve,pay});if(request.kind==='configure'&&(approve||pay))reasons.push('CONFIRMED_CHANNEL_PAUSE_REQUIRED');}
 if(request.kind==='configure'&&current.epoch>0n&&current.authorizer.toLowerCase()!==target.authorizer.toLowerCase())reasons.push('BUDGET_OWNER_TRANSFER_REQUIRES_MIGRATION');
 if(request.kind==='configure'&&!original.report.grants.some((g:any)=>g.authorizer.toLowerCase()===target.authorizer.toLowerCase()))reasons.push('BUDGET_OWNER_TRANSFER_REQUIRES_MIGRATION');
 if(request.kind==='enable'&&(await read('recoveredGrantEvidence',[request.grantId])!==evidence||await read('recoveredGrantEpoch',[request.grantId])!==current.epoch))reasons.push('RECOVERED_GRANT_CONFIGURATION_REQUIRED');
 const grants:{id:string;grant:any}[]=[{id:request.grantId,grant:target}];
 if(request.kind==='enable'){
  const logs:any[]=await chain.client.getLogs({address:registry,event:parseAbiItem('event GrantChanged(bytes32 indexed grantId,uint64 epoch,uint64 budgetVersion,bool enabled)'),fromBlock:0n,toBlock:height});
  for(const id of [...new Set<string>(logs.map(e=>e.args.grantId))].sort()){if(id===request.grantId)continue;const g=await read('getGrant',[id]);if(g.enabled&&Number(g.channel)===Number(target.channel))grants.push({id,grant:g});}
 }
 const budgetProofs:any[]=[],budgetSnapshots=new Map<string,string>();
 const fingerprint=(b:RecoveryBudget)=>hash({ready:b.meta('ready'),limits:b.all('SELECT * FROM limits ORDER BY dimension'),groups:b.all('SELECT * FROM risk_groups ORDER BY model'),reservations:b.all('SELECT * FROM reservations ORDER BY id'),payments:b.all('SELECT * FROM payments ORDER BY id'),checkpoint:b.get("SELECT payload FROM history WHERE action='reconcile' ORDER BY id DESC LIMIT 1")});
 for(const {id,grant:g} of grants){
  if(!g.enabled||BigInt(g.validFrom)>head.timestamp||BigInt(g.validUntil)<=head.timestamp)reasons.push('GRANT_INACTIVE_OR_EXPIRED');
  for(const version of [g.templateId,g.ruleVersion,g.modelVersion])if(await read('disabledVersion',[version]))reasons.push('SHARED_GRANT_VERSION_PAUSED');
  for(const [role,actor] of [['AUTO_REVIEWER',g.reviewer],['AUTO_AUTHORIZER',g.authorizer]])if(!await chain.read('hasRole',[keccak256(stringToHex(role!)),actor],height))reasons.push('SHARED_GRANT_ROLE_INACTIVE');
  const budget=budgets.get(g.authorizer.toLowerCase());if(!budget||budget.meta('scope')!==s.getMeta('scope')){reasons.push('AUTHORIZER_BUDGET_UNAVAILABLE');continue;}
  const owner=g.authorizer.toLowerCase();if(!budgetSnapshots.has(owner))budgetSnapshots.set(owner,fingerprint(budget));
  if(budget.meta('ready')!=='1')reasons.push('BUDGET_RECONCILIATION_REQUIRED');
  const last=budget.get("SELECT payload FROM history WHERE action='reconcile' ORDER BY id DESC LIMIT 1"),checkpoint=last?JSON.parse(last.payload):null;
  if(!checkpoint||String(checkpoint.height)!==String(height)||checkpoint.hash!==head.hash)reasons.push('BUDGET_CHECKPOINT_MISMATCH');
  if(budget.all("SELECT id FROM payments WHERE state NOT IN ('confirmed','released')").length)reasons.push('PAYMENTS_UNRESOLVED');
  if(budget.get('SELECT group_id FROM risk_groups WHERE model=?',g.modelVersion)?.group_id!==g.riskGroupId)reasons.push('RISK_GROUP_MISMATCH');
  const dims={deploymentId:chain.deploymentId,insurerId:g.insurerId,token:g.token,enterpriseId:g.enterpriseId,fdeId:g.fdeId,riskGroupId:g.riskGroupId};
  const usage=readBudgetUsage(budget,dims,Number(head.timestamp));
  for(const u of Object.values(usage)){if(BigInt(u.limit.version)!==BigInt(g.budgetVersion))reasons.push('BUDGET_VERSION');if(u.amount>BigInt(u.limit.amount)||u.count>u.limit.count)reasons.push('ROLLING_BUDGET_EXCEEDED');}
  budgetProofs.push({grantId:id,authorizer:g.authorizer,usage,ledgerDigest:hash({reservations:budget.all('SELECT * FROM reservations ORDER BY id'),payments:budget.all('SELECT * FROM payments ORDER BY id')})});
 }
 const templates=new Set(grants.map(g=>g.grant.templateId)),qualityProofs=[];
 for(const {tenant} of s.all('SELECT DISTINCT tenant FROM quality_reviews ORDER BY tenant')){
  const reviews=(await qualityStatus(s,chain,tenant)).filter(r=>templates.has(r.payload.templateId));
  if(reviews.some(r=>r.pause_job&&r.proof_state!=='canonical'))reasons.push('QUALITY_TRIGGER_UNVERIFIED');
  const cases=(await resolutionCases(s,chain,tenant,await qualityCases(s,chain,tenant))).filter(c=>templates.has(c.payload.templateId));
  if(cases.some(c=>c.state!=='resolved'))reasons.push('SHARED_TEMPLATE_CASES_UNRESOLVED');
  qualityProofs.push({tenant,digest:hash({reviews:reviews.sort((a,b)=>a.id.localeCompare(b.id)),cases:cases.sort((a,b)=>a.id.localeCompare(b.id))})});
 }
 for(const [owner,digest] of budgetSnapshots)if(fingerprint(budgets.get(owner)!)!==digest)reasons.push('BUDGET_CHANGED_DURING_ACTIVATION_CHECK');
 if(await chain.client.getBlockNumber({cacheTime:0})!==tip||(await chain.block(height)).hash!==head.hash)reasons.push('ACTIVATION_SNAPSHOT_CHANGED');
 const report=JSON.parse(json({scope:s.getMeta('scope'),recoveryId,templateId,evidence,request,governanceRevision,height,blockHash:head.hash,channels,grants,budgetProofs,budgetSnapshots:[...budgetSnapshots],qualityProofs,ready:reasons.length===0,reasons:[...new Set(reasons)]}));
 return {...report,digest:hash(report)};
}
