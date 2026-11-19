import {parseAbiItem} from 'viem';
import {Chain} from './chain.ts';
import {historicalDecision} from './quality.ts';
import {Store} from './store.ts';
import {manualTemplate} from './manual-template.ts';
import {costComponents,summarizeCostBreakdowns} from './cost-breakdown.ts';

/** Confirmed decision versions, including superseded versions; never equate an unreviewed case with correct. */
export async function qualityPopulation(s:Store,chain:Chain,tenant:string,reviews:any[]){
 const unavailable=()=>({state:'unavailable' as const,basis:'all canonical decision versions for this enterprise',checkpoint:null,groups:[] as any[]});
 try{
  await chain.check();const tip=await chain.client.getBlockNumber({cacheTime:0});if(tip<1n)return unavailable();
  const height=tip-1n,head=await chain.block(height);
  const logs=await chain.client.getLogs({address:chain.core,event:parseAbiItem('event DecisionRegistered(bytes32 indexed incidentId, bytes32 indexed decisionId, uint64 version, bytes32 digest, uint256 approved, uint256 due, uint256 recoveryDue)'),fromBlock:0n,toBlock:height});
  const groups=new Map<string,any>(),seen=new Set<string>();
  for(const log of logs){
   const incident=log.args.incidentId!,version=String(log.args.version),key=incident+':'+version;
   if(seen.has(key))throw Error('DUPLICATE_DECISION_VERSION');seen.add(key);
   const historical=await historicalDecision(chain,incident,version,head);
   if(historical.i.decisionDigest!==log.args.digest)throw Error('DECISION_HISTORY_MISMATCH');
   const policy=await chain.read('getPolicy',[historical.i.policyId],height);if(policy.quote.enterpriseId!==tenant)continue;
   const channel=Number(historical.i.decision.channel),templateId=historical.g?.templateId??manualTemplate(s,tenant,historical.i.decision),groupKey=JSON.stringify([channel,templateId]);
   const g=groups.get(groupKey)??{channel,templateId,decisionVersions:0,reviewedDecisionVersions:0,unreviewedDecisionVersions:0,outcomes:{},incidents:new Set<string>(),costs:[],costCoverage:{complete:0,partial:0,legacyTotal:0,missing:0}};
   g.decisionVersions++;g.incidents.add(incident);
   // qualityStatus returns newest review first. An unconfirmed newer review does not supersede a confirmed one yet.
   const review=reviews.find(r=>r.incident===incident&&r.payload.decisionVersion===version&&r.proof_state==='canonical'&&BigInt(r.payload.block)<=height&&r.payload.decisionBlockHash===log.blockHash);
   if(review){g.reviewedDecisionVersions++;g.outcomes[review.payload.outcome]=(g.outcomes[review.payload.outcome]??0)+1;}else g.unreviewedDecisionVersions++;
   const measurement=review?s.get('SELECT payload FROM quality_measurements WHERE review_id=? AND tenant=?',review.id,tenant):null;
   const m=measurement?JSON.parse(measurement.payload):null;
   if(m?.costBreakdown){g.costs.push(m);if(costComponents.every(k=>m.costBreakdown.components[k]!==null))g.costCoverage.complete++;else g.costCoverage.partial++;}
   else if(m?.costMicros!=null)g.costCoverage.legacyTotal++;else g.costCoverage.missing++;
   groups.set(groupKey,g);
  }
  if((await chain.block(height)).hash!==head.hash)return unavailable();
  return {state:'available' as const,basis:'all confirmed canonical decision versions since deployment, including superseded versions; not an incident or notice error rate',checkpoint:{height:height.toString(),hash:head.hash,confirmations:2},groups:[...groups.values()].map(g=>({
   channel:g.channel,templateId:g.templateId,templateAttribution:g.templateId?(g.channel===0?'signed-manual-reason':'decision-time-grant'):'manual-template-unrecorded',incidents:g.incidents.size,
   decisionVersions:g.decisionVersions,reviewedDecisionVersions:g.reviewedDecisionVersions,unreviewedDecisionVersions:g.unreviewedDecisionVersions,outcomes:g.outcomes,
   reviewCoverage:{numerator:g.reviewedDecisionVersions,denominator:g.decisionVersions},
   costCoverage:{...g.costCoverage,denominator:g.decisionVersions,completeFraction:{numerator:g.costCoverage.complete,denominator:g.decisionVersions},
    basis:'latest confirmed canonical review measurement for every decision version; complete includes estimates, never implies invoiced actual cost',
    // A cost series may only claim full population coverage if every version has all components in that exact currency and basis.
    series:summarizeCostBreakdowns(g.costs).groups.map(c=>({...c,populationTotalMicros:c.completeMeasurements===g.decisionVersions?c.totalMicros:null,coverage:{numerator:c.completeMeasurements,denominator:g.decisionVersions}}))},
   outcomeRates:Object.fromEntries(['correct','wrong_payment','underpayment','missed_escalation','wrong_denial'].map(k=>[k,g.unreviewedDecisionVersions===0?{numerator:g.outcomes[k]??0,denominator:g.decisionVersions}:null]))
  }))};
 }catch{return unavailable();}
}
