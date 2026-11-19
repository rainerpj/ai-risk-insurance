import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {Indexer} from '../packages/service/indexer.ts';
import {refreshSampling,samplingStatus} from '../packages/service/sampling.ts';
import {recordQuality} from '../packages/service/quality.ts';
import {Store} from '../packages/service/store.ts';
import {createApp} from '../packages/service/api.ts';
import {id,H} from './chain-helper.ts';

test('all confirmed automatic versions are queued once, remain durable, and require an independent canonical review',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor');let reopened:Store|undefined;
 try{
  assert.equal((await samplingStatus(f.store,chain,f.q.enterpriseId)).state,'not_ready');
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;
  await f.c.send(f.c.core,'registerDecision',job.args,'executor');const index=new Indexer(f.store,chain,0n);await index.sync();await refreshSampling(f.store,chain);
  assert.equal((await samplingStatus(f.store,chain,f.q.enterpriseId)).counts.selected,0,'unconfirmed decision is not a confirmed sample');
  await f.c.connection.provider.request({method:'evm_mine'});await index.sync();await Promise.all([refreshSampling(f.store,chain),refreshSampling(f.store,chain)]);
  let status=await samplingStatus(f.store,chain,f.q.enterpriseId);assert.equal(status.policy.percent,100);assert.equal(status.counts.pending,1);assert.equal(status.cases[0].incident,d.incidentId);
  assert.equal(f.store.get("SELECT count(*) n FROM audit WHERE action='sample_selected'").n,1);
  reopened=new Store(f.dir+'/executor.sqlite',f.scope);await refreshSampling(reopened,chain);assert.equal((await samplingStatus(reopened,chain,f.q.enterpriseId)).counts.pending,1);
  const reviewer={address:f.c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
  await recordQuality(reopened,chain,reviewer,{id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'correct',reason:'independent full pilot sample review'});
  status=await samplingStatus(reopened,chain,reviewer.tenant);assert.equal(status.counts.reviewed,1);assert.equal(status.counts.pending,0);assert(status.cases[0].reviewId);assert.equal(status.cases[0].outcome,'correct');
  assert.deepEqual((await samplingStatus(reopened,chain,H('other tenant'))).cases,[]);
  const app=createApp(reopened,chain);try{
   for(const [name,role] of [['insured','insured'],['assessor','ASSESSOR']] as const){
    reopened.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts[name].address.toLowerCase(),reviewer.tenant,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:f.c.accounts[name].address}})).json(),login=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await f.c.accounts[name].signMessage({message:ch.message})}})).json();
    const result=await app.inject({url:'/api/quality/samples',headers:{authorization:'Bearer '+login.token}});assert.equal(result.statusCode,name==='insured'?403:200);
   }
  }finally{await app.close();}
  console.log('Full pilot sample evidence:',f.c.save('quality-sampling',{status}));
 }finally{reopened?.close();f.close();await f.c.connection.close();}
});

test('reorg preserves orphaned sample and review; new canonical source requires a new matching review',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),index=new Indexer(f.store,chain,0n);
 try{
  await f.enable();await index.sync();const snapshot=await f.c.connection.provider.request({method:'evm_snapshot'});
  const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;
  await f.c.send(f.c.core,'registerDecision',job.args,'executor');await f.c.connection.provider.request({method:'evm_mine'});await index.sync();await refreshSampling(f.store,chain);
  const actor={address:f.c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};await recordQuality(f.store,chain,actor,{id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'correct',reason:'old branch review'});
  const before=await samplingStatus(f.store,chain,actor.tenant);assert.equal(before.counts.reviewed,1);
  await f.c.connection.provider.request({method:'evm_revert',params:[snapshot]});assert.equal((await samplingStatus(f.store,chain,actor.tenant)).state,'unavailable');
  await index.sync();await refreshSampling(f.store,chain);let status=await samplingStatus(f.store,chain,actor.tenant);assert.equal(status.counts.recheckRequired,1);assert.equal(status.counts.selected,0);
  await f.c.connection.provider.request({method:'evm_increaseTime',params:[5]});await f.c.send(f.c.core,'registerDecision',job.args,'executor');await f.c.connection.provider.request({method:'evm_mine'});await index.sync();await refreshSampling(f.store,chain);
  status=await samplingStatus(f.store,chain,actor.tenant);assert.equal(status.cases.length,2);assert.equal(status.counts.pending,1);assert.equal(status.counts.reviewed,0);assert.equal(status.counts.recheckRequired,1);
  const getBlock=chain.block.bind(chain);chain.block=async()=>{throw Error('offline');};assert.equal((await samplingStatus(f.store,chain,actor.tenant)).state,'unavailable');chain.block=getBlock;
  assert.equal(f.store.get('SELECT count(*) n FROM quality_samples').n,2);
  console.log('Sampling reorg evidence:',f.c.save('quality-sampling-reorg',{before,status}));
 }finally{f.close();await f.c.connection.close();}
});
