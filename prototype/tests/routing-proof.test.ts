import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {H,id} from './chain-helper.ts';
import {observeRouting,routingObservations,verifyRoutingProof,routingMessage} from '../packages/service/routing-proof.ts';
import {reviewerApp} from '../packages/service/automatic-api.ts';
import {Store} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {custom} from 'viem';
import {recordIntakeQuality,intakeQualityStatus} from '../packages/service/intake-quality.ts';
import {seedIntake} from './seed-intake.ts';
import {Worker,Indexer} from '../packages/service/indexer.ts';

test('signed routing observation pins historical Grant, tenant, notice and deployment and survives restart without exposing originals',async()=>{
 const f=await autoFixture(),tenant=f.q.enterpriseId,scope=f.scope,chain=f.makeChain('executor');
 try{
  const snapshot=await f.c.connection.provider.request({method:'evm_snapshot'});await f.c.connection.provider.request({method:'evm_mine'});
  const proof=await observeRouting(f.store,f.reviewer,f.request);
  assert.equal((await verifyRoutingProof(chain,scope,tenant,f.request.noticeId,proof)).templateId,f.g.templateId);
  await observeRouting(f.store,f.reviewer,f.request);assert.equal(routingObservations(f.store,tenant).observations.length,1);
  assert.equal(routingObservations(f.store,H('foreign')).observations.length,0);
  const reopened=new Store(f.dir+'/executor.sqlite',scope);try{assert.deepEqual(routingObservations(reopened,tenant),routingObservations(f.store,tenant));}finally{reopened.close();}
  await assert.rejects(verifyRoutingProof(chain,scope,H('foreign'),f.request.noticeId,proof),/SCOPE/);
  await assert.rejects(verifyRoutingProof(chain,scope,tenant,H('foreign notice'),proof),/SCOPE/);
  await assert.rejects(verifyRoutingProof(chain,scope+'other',tenant,f.request.noticeId,proof),/SCOPE/);
  await assert.rejects(verifyRoutingProof(chain,scope,tenant,f.request.noticeId,{...proof,payload:{...proof.payload,templateId:H('forged')}}),/SCOPE/);
  const forged=await f.c.accounts.insured.signMessage({message:routingMessage(proof.payload)});
  await assert.rejects(verifyRoutingProof(chain,scope,tenant,f.request.noticeId,{...proof,signature:forged}),/INVALID/);
  await f.c.send(f.registry,'configure',[f.request.grantId,{...f.g,templateId:H('replacement template')}]);
  assert.equal((await verifyRoutingProof(chain,scope,tenant,f.request.noticeId,proof)).templateId,f.g.templateId,'current Grant must not relabel historical attempt');
  await f.c.connection.provider.request({method:'evm_revert',params:[snapshot]});await assert.rejects(verifyRoutingProof(chain,scope,tenant,f.request.noticeId,proof));
  assert.equal(routingObservations(f.store,tenant).observations.length,1,'orphan proof retained');
 }finally{f.close();await f.c.connection.close();}
});

test('review HTTP persists routing before outcome and tenant portal capabilities cannot cross scopes',async()=>{
 const f=await autoFixture(),tenant=f.q.enterpriseId,token='i'.repeat(32),portal='p'.repeat(32),app=reviewerApp(f.reviewer,token,f.store,{[tenant]:portal});
 try{
  const result=await app.inject({method:'POST',url:'/review',headers:{authorization:'Bearer '+token},payload:f.request});assert.equal(result.statusCode,200,result.body);
  const read=await app.inject({url:'/portal/'+tenant+'/routing',headers:{authorization:'Bearer '+portal}});assert.equal(read.statusCode,200);assert.equal(read.json().observations.length,1);
  const proof=read.json().observations[0];await verifyRoutingProof(f.makeChain('executor'),f.scope,tenant,f.request.noticeId,proof);
  assert(!read.body.includes('privateKey'));assert(!read.body.includes('refs'));assert(!read.body.includes('proposal'));
  assert.equal((await app.inject({url:'/portal/'+H('foreign')+'/routing',headers:{authorization:'Bearer '+portal}})).statusCode,403);
  assert.equal((await app.inject({url:'/portal/'+tenant+'/routing',headers:{authorization:'Bearer '+token}})).statusCode,403);
 }finally{await app.close();f.close();await f.c.connection.close();}
});

test('pending anomaly atomically queues historical template pause and restart executes it without changing policy funds',async()=>{
 const f=await autoFixture(),chain=new Chain(f.c.core.address,f.c.salt,custom(f.c.connection.provider),{[f.c.accounts.governor.address.toLowerCase()]:f.c.accounts.governor}),tenant=f.q.enterpriseId;
 try{
  await seedIntake(f.store,chain,f.c.accounts.insured,f.request,800000000n);
  await observeRouting(f.store,f.reviewer,f.request);
  const portal={routing:async()=>routingObservations(f.store,tenant),status:async()=>({}),import:async()=>({}),submit:async()=>({})};
  const input={id:id(),noticeId:f.request.noticeId,outcome:'missed_escalation',reason:'synthetic independent intake anomaly'},actor={address:f.c.accounts.assessor.address.toLowerCase(),tenant,role:'ASSESSOR'};
  await assert.rejects(recordIntakeQuality(f.store,chain,actor,input,{intakePortal:portal}),/SAFETY_GOVERNOR_REQUIRED/);
  assert.equal(f.store.get('SELECT count(*) n FROM intake_quality').n,0);assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,0);
  const before=await chain.policy(f.request.policyId),replacement=H('new template');await f.c.send(f.registry,'configure',[f.request.grantId,{...f.g,templateId:replacement}]);
  const options={intakePortal:portal,safetyGovernor:f.c.accounts.governor.address};
  await Promise.all([recordIntakeQuality(f.store,chain,actor,input,options),recordIntakeQuality(f.store,chain,actor,input,options)]);
  const review=(await intakeQualityStatus(f.store,chain,tenant))[0]!,pause=review.payload.pauseJobs[0];assert.equal(pause.templateId,f.g.templateId);assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,1);
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{
   const worker=new Worker(reopened,chain);await worker.tick();await worker.tick();await f.c.connection.provider.request({method:'evm_mine'});await new Indexer(reopened,chain,0n).sync();
   assert.equal(reopened.get('SELECT state FROM outbox WHERE id=?',pause.id).state,'confirmed');
  }finally{reopened.close();}
  assert.equal(await f.c.read(f.registry,'disabledVersion',[f.g.templateId]),true);assert.equal(await f.c.read(f.registry,'disabledVersion',[replacement]),false);assert.deepEqual(await chain.policy(f.request.policyId),before);
 }finally{f.close();await f.c.connection.close();}
});
