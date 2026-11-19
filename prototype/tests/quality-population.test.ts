import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {H,id,U} from './chain-helper.ts';
import {qualityMetrics,recordMeasurement} from '../packages/service/metrics.ts';
import {recordQuality} from '../packages/service/quality.ts';

test('population denominator includes unreviewed and revised decisions; rates require full confirmed coverage and tenant isolation',async()=>{
 const f=await autoFixture(),{c}=f,chain=f.makeChain('executor'),actor={address:c.accounts.assessor2.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
 const mine=()=>c.connection.provider.request({method:'evm_mine'}),read=async()=>(await qualityMetrics(f.store,chain,actor.tenant)).population;
 try{
  const n=await c.notice(f.q),first=await c.decision(f.q,[f.request.noticeId],id(),800n*U),second=await c.decision(f.q,[n.n.noticeId],id(),900n*U);
  await c.send(c.core,'registerDecision',first.args,'executor');
  // Refresh the expected policy ledger after registering the first independent incident.
  const secondCurrent=await c.decision(f.q,[n.n.noticeId],second.d.incidentId,900n*U);await c.send(c.core,'registerDecision',secondCurrent.args,'executor');await mine();
  let p=await read();assert.equal(p.state,'available');assert.equal(p.groups[0]!.decisionVersions,2);assert.equal(p.groups[0]!.unreviewedDecisionVersions,2);assert.equal(p.groups[0]!.outcomeRates.correct,null);
  assert.equal(p.groups[0]!.costCoverage.missing,2);assert.equal(p.groups[0]!.costCoverage.denominator,2);
  const firstReview=id();await recordQuality(f.store,chain,actor,{id:firstReview,incidentId:first.d.incidentId,decisionVersion:'1',outcome:'correct',reason:'independent review first case'});await mine();
  await recordMeasurement(f.store,chain,actor,{id:id(),reviewId:firstReview,processingMs:null,humanMs:null,costCurrency:'USD',costMicros:'10',costBreakdown:{currency:'USD',basis:'actual',reference:'synthetic invoice',components:{human:'10',model:'0',chain:'0',infrastructure:'0',other:'0'}},wrongPaid:null,underpaid:null,duplicatePayments:null,manualOverturned:null,appealOverturned:null,reason:'synthetic cost coverage'});
  p=await read();assert.deepEqual(p.groups[0]!.reviewCoverage,{numerator:1,denominator:2});assert.equal(p.groups[0]!.outcomeRates.correct,null);assert.equal(p.groups[0]!.costCoverage.complete,1);assert.equal(p.groups[0]!.costCoverage.missing,1);assert.equal(p.groups[0]!.costCoverage.series[0]!.populationTotalMicros,null);
  const secondReview=id();await recordQuality(f.store,chain,actor,{id:secondReview,incidentId:second.d.incidentId,decisionVersion:'1',outcome:'underpayment',reason:'independent review found insufficient payment'});await mine();
  const partial={id:id(),reviewId:secondReview,processingMs:null,humanMs:null,costCurrency:null,costMicros:null,costBreakdown:{currency:'USD',basis:'actual',reference:'synthetic missing model invoice',components:{human:'5',model:null,chain:'0',infrastructure:'0',other:'0'}},wrongPaid:null,underpaid:null,duplicatePayments:null,manualOverturned:null,appealOverturned:null,reason:'partial cost evidence'};
  await recordMeasurement(f.store,chain,actor,partial);
  p=await read();assert.deepEqual(p.groups[0]!.outcomeRates.underpayment,{numerator:1,denominator:2});assert.deepEqual(p.groups[0]!.outcomeRates.correct,{numerator:1,denominator:2});assert.equal(p.groups[0]!.templateAttribution,'manual-template-unrecorded');
  assert.equal(p.groups[0]!.costCoverage.partial,1);assert.equal(p.groups[0]!.costCoverage.series[0]!.populationTotalMicros,null);
  const legacyReview=id();await recordQuality(f.store,chain,actor,{id:legacyReview,incidentId:second.d.incidentId,decisionVersion:'1',outcome:'underpayment',reason:'later review with legacy cost total'});await mine();
  const {costBreakdown,...legacy}=partial;await recordMeasurement(f.store,chain,actor,{...legacy,id:id(),reviewId:legacyReview,costCurrency:'USD',costMicros:'5'});
  p=await read();assert.equal(p.groups[0]!.costCoverage.partial,0);assert.equal(p.groups[0]!.costCoverage.legacyTotal,1);assert.equal(p.groups[0]!.costCoverage.series[0]!.populationTotalMicros,null);
  assert.deepEqual((await qualityMetrics(f.store,chain,H('other enterprise'))).population.groups,[]);
  const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  await c.send(c.core,'setIncidentFreeze',[first.d.incidentId,true,H('revision')]);const revised=await c.decision(f.q,[f.request.noticeId],first.d.incidentId,850n*U);await c.send(c.core,'registerDecision',revised.args,'executor');await mine();
  p=await read();assert.equal(p.groups[0]!.decisionVersions,3);assert.equal(p.groups[0]!.incidents,2);assert.equal(p.groups[0]!.unreviewedDecisionVersions,1);assert.equal(p.groups[0]!.outcomeRates.underpayment,null);assert.equal(p.groups[0]!.costCoverage.denominator,3);assert.equal(p.groups[0]!.costCoverage.missing,1);
  await c.connection.provider.request({method:'evm_revert',params:[snapshot]});await mine();p=await read();assert.equal(p.groups[0]!.decisionVersions,2);
  const check=chain.check;chain.check=async()=>{throw Error('RPC_OFFLINE');};assert.equal((await read()).state,'unavailable');chain.check=check;
  console.log('Quality population evidence:',c.save('quality-population',{status:'passed',population:p}));
 }finally{f.close();await c.connection.close();}
});

