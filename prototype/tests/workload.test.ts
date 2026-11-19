import {Store} from '../packages/service/store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {Indexer} from '../packages/service/indexer.ts';
import {workloadMetrics} from '../packages/service/workload.ts';
import {id,H} from './chain-helper.ts';
import {createApp} from '../packages/service/api.ts';

test('workload unions local and chain notices without counting duplicate receipt, and keeps unbound incident denominator unknown',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),index=new Indexer(f.store,chain,0n),tenant=f.q.enterpriseId;
 try{
  assert.equal((await workloadMetrics(f.store,chain,tenant)).state,'not_ready');
  await f.c.connection.provider.request({method:'evm_mine'});await index.sync();
  const add=(noticeId:string,t=tenant)=>f.store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',noticeId,t,'synthetic-owner','{}','synthetic-digest',new Date().toISOString(),'awaiting_binding');
  let result=await workloadMetrics(f.store,chain,tenant);assert.equal(result.pending!.waitingMs.unknown,1,'chain-only notice has no durable receipt timing');
  add(f.request.noticeId);result=await workloadMetrics(f.store,chain,tenant);assert.equal(result.counts!.noticeIds,1);assert.equal(result.counts!.unboundConfirmedNotices,1);assert.equal(result.incidentDenominator,null);
  const pendingStart=Date.parse(f.store.get('SELECT received_at FROM notices WHERE id=?',f.request.noticeId).received_at);
  const pending= (await workloadMetrics(f.store,chain,tenant,pendingStart+5000)).pending!;
  assert.equal(pending.noticeIds,1);assert.equal(pending.waitingMs.sum,'5000');assert.equal(pending.waitingMs.p95,'5000');assert.equal(pending.qualityRate,null);assert.equal(pending.channel,null);assert.equal(pending.incidentCount,null);
  assert.equal((await workloadMetrics(f.store,chain,tenant,pendingStart-1)).pending!.waitingMs.unknown,1);
  assert.equal((await workloadMetrics(f.store,chain,tenant,Number.MAX_SAFE_INTEGER)).pending!.observedAt,null);
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature);
  const snapshot=await f.c.connection.provider.request({method:'evm_snapshot'});
  await f.c.send(f.c.core,'registerDecision',job.args,'executor');await f.c.connection.provider.request({method:'evm_mine'});await index.sync();
  result=await workloadMetrics(f.store,chain,tenant);assert.equal(result.counts!.boundNotices,1);assert.equal(result.incidentDenominator,1);assert.equal(result.channels![1]!.withDue,1);assert.deepEqual(result.automaticClosureRate,{numerator:0,denominator:1});assert.equal(result.templates!.length,1);assert.equal(result.templates![0]!.templateId,f.g.templateId);
  await f.c.send(f.registry,'configure',[f.request.grantId,{...f.g,templateId:H('replacement template')}]);
  await f.c.connection.provider.request({method:'evm_mine'});await index.sync();
  const replaced=await workloadMetrics(f.store,chain,tenant);assert.equal(replaced.templates![0]!.templateId,f.g.templateId,'historical attribution must not follow replacement Grant');assert.equal(replaced.pending!.noticeIds,0,'confirmed decision removes its notice from pending population');
  const timing=result.channels![1]!.decisionObservedMs;assert.equal(timing.observations,1);assert.equal(timing.unknown,0);assert(BigInt(timing.sum!)>=0n);
  const captured=f.store.all('SELECT * FROM decision_observations');await index.sync();assert.deepEqual(f.store.all('SELECT * FROM decision_observations'),captured);
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{assert.deepEqual((await workloadMetrics(reopened,chain,tenant)).channels![1]!.decisionObservedMs,timing);}finally{reopened.close();}
  const receipt=f.store.get('SELECT received_at FROM notices WHERE id=?',f.request.noticeId).received_at;
  for(const invalid of ['invalid date',new Date(Number(f.store.getMeta('timingStartedAt'))-1).toISOString(),new Date(Date.now()+1000000).toISOString()]){
   f.store.run('UPDATE notices SET received_at=? WHERE id=?',invalid,f.request.noticeId);const unknown=(await workloadMetrics(f.store,chain,tenant)).channels![1]!.decisionObservedMs;assert.equal(unknown.observations,0);assert.equal(unknown.unknown,1);assert.equal(unknown.mean,null);
  }
  f.store.run('UPDATE notices SET received_at=? WHERE id=?',receipt,f.request.noticeId);
  add(id());add(id(),H('foreign'));result=await workloadMetrics(f.store,chain,tenant);assert.equal(result.counts!.noticeIds,2);assert.equal(result.counts!.localOnlyNotices,1);assert.equal(result.incidentDenominator,null);
  assert.equal((await workloadMetrics(f.store,chain,H('foreign'))).counts!.decidedIncidents,0);
  const app=createApp(f.store,chain);try{
   for(const [actor,role] of [['insured','insured'],['assessor','ASSESSOR']] as const){
    f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts[actor].address.toLowerCase(),tenant,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:f.c.accounts[actor].address}})).json();
    const token=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await f.c.accounts[actor].signMessage({message:ch.message})}})).json().token;
    const response=await app.inject({url:'/api/quality/workload?tenant='+H('foreign'),headers:{authorization:'Bearer '+token}});assert.equal(response.statusCode,actor==='insured'?403:200);if(actor==='assessor')assert.equal(response.json().counts.decidedIncidents,1);
   }
  }finally{await app.close();}
  await f.c.connection.provider.request({method:'evm_revert',params:[snapshot]});assert.equal((await workloadMetrics(f.store,chain,tenant)).state,'unavailable');
  await index.sync();result=await workloadMetrics(f.store,chain,tenant);assert.equal(result.counts!.decidedIncidents,0);assert.equal(result.counts!.unboundConfirmedNotices,1);assert.equal(result.pending!.noticeIds,2,'reorg restores pending notices without cross-tenant additions');
  chain.check=async()=>{throw Error('offline');};result=await workloadMetrics(f.store,chain,tenant);assert.equal(result.counts,null);assert.equal(result.pending,null);assert.equal(result.localAccepted,2);assert.equal(result.automaticClosureRate,null);
 }finally{f.close();await f.c.connection.close();}
});
