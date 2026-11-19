import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H} from './chain-helper.ts';
import {Store} from '../packages/service/store.ts';
import {recordIntakeMeasurement,intakeMeasurementHistory,pendingIntakeCosts} from '../packages/service/intake-metrics.ts';
import {workloadMetrics} from '../packages/service/workload.ts';
import {Indexer} from '../packages/service/indexer.ts';
import {createApp} from '../packages/service/api.ts';

test('pending intake costs preserve unknowns, immutable history, concurrency and tenant isolation across restart and binding',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),tenant=f.q.enterpriseId;
 const actor={address:f.c.accounts.assessor.address.toLowerCase(),tenant,role:'ASSESSOR'},noticeId=f.request.noticeId;
 try{
  f.store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',noticeId,tenant,f.c.accounts.insured.address.toLowerCase(),'{}','receipt-proof',new Date().toISOString(),'awaiting_binding');
  const first={id:id(),noticeId,previousId:null,humanMs:'300',costCurrency:null,costMicros:null,costBreakdown:{currency:'USD',basis:'estimate',components:{human:'20',model:null,chain:'0',infrastructure:'0',other:'0'},reference:'synthetic intake expense'},reason:'cumulative intake observation'};
  await assert.rejects(recordIntakeMeasurement(f.store,chain,{...actor,role:'insured'},first),/ROLE_DENIED/);
  await assert.rejects(recordIntakeMeasurement(f.store,chain,{...actor,tenant:H('foreign')},first),/NOT_FOUND/);
  await assert.rejects(recordIntakeMeasurement(f.store,chain,{...actor,address:f.c.accounts.insured.address},first),/OWNER_CANNOT/);
  await assert.rejects(recordIntakeMeasurement(f.store,chain,actor,{...first,costMicros:'20',costCurrency:'USD'}),/COST_BREAKDOWN_SCHEMA/);
  const originalRead=chain.read.bind(chain);chain.read=async(name,args=[],block)=>name==='hasRole'?false:originalRead(name,args,block);
  await assert.rejects(recordIntakeMeasurement(f.store,chain,actor,first),/CHAIN_ROLE_REVOKED/);chain.read=originalRead;
  await Promise.all([recordIntakeMeasurement(f.store,chain,actor,first),recordIntakeMeasurement(f.store,chain,actor,first)]);
  assert.equal(intakeMeasurementHistory(f.store,tenant).length,1);
  await assert.rejects(recordIntakeMeasurement(f.store,chain,actor,{...first,humanMs:'1'}),/IMMUTABLE/);
  const second={...first,id:id(),previousId:first.id,humanMs:null,costCurrency:'USD',costMicros:'25',costBreakdown:{...first.costBreakdown,basis:'actual',components:{human:'20',model:'5',chain:'0',infrastructure:'0',other:'0'}}};
  const races=await Promise.allSettled([recordIntakeMeasurement(f.store,chain,actor,second),recordIntakeMeasurement(f.store,chain,actor,{...second,id:id()})]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(races.filter(r=>r.status==='rejected'&&/STALE/.test(String(r.reason))).length,1);
  const pending=pendingIntakeCosts(f.store,tenant,[noticeId,id()]);assert.equal(pending.measuredNotices,1);assert.equal(pending.unmeasuredNotices,1);assert.equal(pending.humanMs.sum,null);assert.equal(pending.costs.groups[0]!.totalMicros,'25');assert.equal(pending.costs.groups[0]!.pendingPopulationTotalMicros,null);
  f.store.run('UPDATE notices SET payload_hash=? WHERE id=?','different-receipt',noticeId);assert.equal(pendingIntakeCosts(f.store,tenant,[noticeId]).measuredNotices,0);f.store.run('UPDATE notices SET payload_hash=? WHERE id=?','receipt-proof',noticeId);
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{
   assert.equal(intakeMeasurementHistory(reopened,tenant).length,2);assert.equal(intakeMeasurementHistory(reopened,H('foreign')).length,0);
   assert.equal(pendingIntakeCosts(reopened,tenant,[noticeId]).costs.groups[0]!.pendingPopulationTotalMicros,'25');
  }finally{reopened.close();}
  const app=createApp(f.store,chain);try{
   for(const [name,role,t] of [['assessor','ASSESSOR',tenant],['insured','insured',tenant],['supervisor','SUPERVISOR',H('foreign')]] as const){
    const account=f.c.accounts[name];f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',account.address.toLowerCase(),t,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:account.address}})).json();
    const login=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await account.signMessage({message:ch.message})}})).json();
    const headers={authorization:'Bearer '+login.token};
    const read=await app.inject({url:'/api/quality/intake-measurements?tenant='+tenant,headers});assert.equal(read.statusCode,name==='insured'?403:200);
    if(name!=='insured')assert.equal(read.json().length,name==='assessor'?2:0);
    const write=await app.inject({method:'POST',url:'/api/quality/intake-measurements',headers,payload:first});assert.equal(write.statusCode,name==='insured'?403:name==='supervisor'?404:200);
   }
  }finally{await app.close();}
  const index=new Indexer(f.store,chain,0n);await f.c.connection.provider.request({method:'evm_mine'});await index.sync();
  assert.equal((await workloadMetrics(f.store,chain,tenant)).pending!.intakeCosts.completeCosts,1);
  const snap=await f.c.connection.provider.request({method:'evm_snapshot'});
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature);await f.c.send(f.c.core,'registerDecision',job.args,'executor');await f.c.connection.provider.request({method:'evm_mine'});await index.sync();
  await assert.rejects(recordIntakeMeasurement(f.store,chain,actor,{...second,id:id(),previousId:second.id}),/ALREADY_BOUND/);
  assert.equal((await workloadMetrics(f.store,chain,tenant)).pending!.intakeCosts.measuredNotices,0);assert.equal(intakeMeasurementHistory(f.store,tenant).length,2);
  await f.c.connection.provider.request({method:'evm_revert',params:[snap]});await index.sync();assert.equal((await workloadMetrics(f.store,chain,tenant)).pending!.intakeCosts.completeCosts,1);
  chain.check=async()=>{throw Error('offline');};await assert.rejects(recordIntakeMeasurement(f.store,chain,actor,{...first,id:id()}),/offline/);
  assert.equal((await workloadMetrics(f.store,chain,tenant)).pending,null);
 }finally{f.close();await f.c.connection.close();}
});
