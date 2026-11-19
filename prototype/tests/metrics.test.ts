import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H} from './chain-helper.ts';
import {recordQuality} from '../packages/service/quality.ts';
import {recordMeasurement,qualityMetrics,metricDistribution} from '../packages/service/metrics.ts';
import {Store} from '../packages/service/store.ts';
import {createApp} from '../packages/service/api.ts';
test('sampled quality metrics preserve unknowns, currency, latest review and restart isolation',async()=>{
 const f=await autoFixture(),{c}=f,chain=f.makeChain('executor'),actor={address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
 let reopened:Store|undefined;
 try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;await c.send(c.core,'registerDecision',job.args,'executor');
  const snap=await c.connection.provider.request({method:'evm_snapshot'});await c.connection.provider.request({method:'evm_mine'});
  const review={id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'correct',reason:'independent synthetic cost and timing review'};
  await recordQuality(f.store,chain,actor,review);
  let metrics=await qualityMetrics(f.store,chain,actor.tenant);assert.equal(metrics.populationRate,null);assert.equal(metrics.groups[0]!.processingMs.mean,null);
  const m={id:id(),reviewId:review.id,processingMs:'1500',humanMs:'300',costCurrency:'USD',costMicros:'250000',costBreakdown:{currency:'USD',basis:'actual',components:{human:'200000',model:'20000',chain:'10000',infrastructure:'20000',other:'0'},reference:'synthetic invoice and time costing'},wrongPaid:'0',underpaid:null,duplicatePayments:'0',manualOverturned:false,appealOverturned:null,reason:'synthetic stopwatch and expense record'};
  await assert.rejects(recordMeasurement(f.store,chain,actor,{...m,costMicros:'1'}),/COST_BREAKDOWN_SCHEMA/);
  await assert.rejects(recordMeasurement(f.store,chain,{...actor,role:'insured'},m),/ROLE_DENIED/);
  await assert.rejects(recordMeasurement(f.store,chain,{...actor,tenant:H('other')},m),/NOT_FOUND/);
  await assert.rejects(recordMeasurement(f.store,chain,{...actor,address:c.accounts.supervisor.address.toLowerCase()},m),/REVIEW_AUTHOR_REQUIRED/);
  await assert.rejects(recordMeasurement(f.store,chain,actor,{...m,wrongPaid:'1'}),/WRONG_PAYMENT_EVIDENCE_CONFLICT/);
  await Promise.all([recordMeasurement(f.store,chain,actor,m),recordMeasurement(f.store,chain,actor,m)]);
  const app=createApp(f.store,chain);try{
   for(const [name,role] of [['assessor','ASSESSOR'],['insured','insured']] as const){
    f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[name].address.toLowerCase(),actor.tenant,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts[name].address}})).json();
    const login=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await c.accounts[name].signMessage({message:ch.message})}})).json();
    const headers={authorization:'Bearer '+login.token};
    assert.equal((await app.inject({url:'/api/quality/metrics',headers})).statusCode,name==='insured'?403:200);
    const listing=await app.inject({url:'/api/quality/measurements',headers});assert.equal(listing.statusCode,name==='insured'?403:200);if(name==='assessor'){assert.equal(listing.json().length,1);assert.equal(listing.json()[0].payload.underpaid,null);}
    assert.equal((await app.inject({method:'POST',url:'/api/quality/measurements',headers,payload:m})).statusCode,name==='insured'?403:200);
   }
   const other=c.accounts.supervisor;f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',other.address.toLowerCase(),H('other'),'SUPERVISOR');
   const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:other.address}})).json();
   const login=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await other.signMessage({message:ch.message})}})).json();
   const isolated=await app.inject({url:'/api/quality/measurements',headers:{authorization:'Bearer '+login.token}});assert.equal(isolated.statusCode,200);assert.deepEqual(isolated.json(),[]);
  }finally{await app.close();}
  await assert.rejects(recordMeasurement(f.store,chain,actor,{...m,processingMs:'999'}),/IMMUTABLE_MEASUREMENT/);
  await c.connection.provider.request({method:'evm_mine'});
  reopened=new Store(f.dir+'/executor.sqlite',f.scope);metrics=await qualityMetrics(reopened,chain,actor.tenant);
  assert.equal(metrics.population.state,'available');assert.equal(metrics.population.groups[0]!.channel,1);assert.equal(metrics.population.groups[0]!.templateId,f.g.templateId);
  assert.deepEqual(metrics.population.groups[0]!.outcomeRates.correct,{numerator:1,denominator:1});
  assert.equal(metrics.population.groups[0]!.costCoverage.series[0]!.populationTotalMicros,'250000');
  assert.deepEqual(metrics.population.groups[0]!.costCoverage.completeFraction,{numerator:1,denominator:1});
  const measured=metrics;
  assert.equal(metrics.groups[0]!.measuredDecisions,1);assert.equal(metrics.groups[0]!.processingMs.p95,'1500');assert.deepEqual(metrics.groups[0]!.humanMs.mean,{numerator:'300',denominator:1});
  assert.equal(metrics.groups[0]!.costs.length,0);assert.equal(metrics.groups[0]!.costBreakdown.groups[0]!.currency,'USD');assert.equal(metrics.groups[0]!.costBreakdown.groups[0]!.totalMicros,'250000');assert.equal(metrics.groups[0]!.money[0]!.token.toLowerCase(),f.q.token.toLowerCase());assert.equal(metrics.groups[0]!.money[0]!.underpaid.sum,null);assert.equal(metrics.groups[0]!.appealOverturned.sum,null);
  const isolatedCosts=await qualityMetrics(reopened,chain,H('other'));assert.deepEqual(isolatedCosts.groups,[]);assert.deepEqual(isolatedCosts.costBreakdown.groups,[]);
  await recordQuality(reopened,chain,actor,{...review,id:id(),reason:'later independent opinion without timing measurement'});
  const later=await qualityMetrics(reopened,chain,actor.tenant);assert.equal(later.groups[0]!.reviewedDecisions,1);assert.equal(later.groups[0]!.measuredDecisions,0);assert.equal(later.groups[0]!.processingMs.sum,null);assert.deepEqual(later.costBreakdown.groups,[]);
  await c.connection.provider.request({method:'evm_revert',params:[snap]});metrics=await qualityMetrics(reopened,chain,actor.tenant);assert.deepEqual(metrics.groups,[]);assert.equal(metrics.excludedUnverifiedReviews,2);
  console.log('Metric evidence:',c.save('quality-metrics',{measured,later,metrics,persistedMeasurements:reopened.get('SELECT count(*) n FROM quality_measurements').n}));
 }finally{reopened?.close();f.close();await c.connection.close();}
});

test('P95 uses nearest rank and keeps integer precision above Number safe range',()=>{
 const base=9007199254740993n,values=Array.from({length:20},(_,i)=>base+BigInt(i));
 const summary=metricDistribution(values.reverse());assert.equal(summary.p95,(base+18n).toString());assert.deepEqual(summary.mean,{numerator:(20n*base+190n).toString(),denominator:20});
 assert.equal(metricDistribution([]).sum,null);assert.equal(metricDistribution([0n]).sum,'0');
});
