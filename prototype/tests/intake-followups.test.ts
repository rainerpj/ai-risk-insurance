import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H} from './chain-helper.ts';
import {seedIntake} from './seed-intake.ts';
import {observeRouting,routingObservations} from '../packages/service/routing-proof.ts';
import {recordIntakeQuality,resolveIntakeQuality} from '../packages/service/intake-quality.ts';
import {intakeFollowups} from '../packages/service/intake-followups.ts';
import {recordQuality} from '../packages/service/quality.ts';
import {recoveryReadiness} from '../packages/service/recovery-readiness.ts';
import {Store} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {custom} from 'viem';
import {Worker,Indexer} from '../packages/service/indexer.ts';
import {RecoveryExecutor} from '../packages/service/recovery-executor.ts';

test('intake anomaly discovers later automatic decisions, requires independent followup and blocks governance recovery until original issue is resolved',async()=>{
 const f=await autoFixture(),{c}=f,tenant=f.q.enterpriseId;
 const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{[c.accounts.governor.address.toLowerCase()]:c.accounts.governor}),actor={address:c.accounts.assessor.address.toLowerCase(),tenant,role:'ASSESSOR'};
 try{
  await seedIntake(f.store,chain,c.accounts.insured,f.request,800000000n);await f.enable();await observeRouting(f.store,f.reviewer,f.request);
  const portal={routing:async()=>routingObservations(f.store,tenant),status:async()=>({}),import:async()=>({}),submit:async()=>({})};
  await recordIntakeQuality(f.store,chain,actor,{id:id(),noticeId:f.request.noticeId,outcome:'missed_escalation',reason:'synthetic intake finding'},{intakePortal:portal,safetyGovernor:c.accounts.governor.address});
  assert.equal((await intakeFollowups(f.store,chain,tenant)).cases.length,0);
  const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  // A decision mines before the queued pause executes; discovery must include this race.
  const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;await c.send(c.core,'registerDecision',job.args,'executor');
  let cases=(await intakeFollowups(f.store,chain,tenant)).cases;assert.equal(cases.length,1);assert.equal(cases[0].state,'pending');assert.equal(cases[0].payload.sameVersion,true);
  assert.equal((await intakeFollowups(f.store,chain,H('foreign'))).cases.length,0);assert.equal(f.store.get('SELECT count(*) n FROM intake_followups').n,1);
  const review={id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'correct',reason:'subsequent current decision review'};await recordQuality(f.store,chain,actor,review);
  assert.equal((await intakeFollowups(f.store,chain,tenant)).cases[0].state,'recheck_required','original finding author cannot independently clear followup');
  await recordQuality(f.store,chain,{...actor,address:c.accounts.assessor2.address.toLowerCase()},{...review,id:id()});
  assert.equal((await intakeFollowups(f.store,chain,tenant)).cases[0].state,'reviewed');
  await c.connection.provider.request({method:'evm_mine'});
  const report=await recoveryReadiness(f.store,chain,f.g.templateId,new Map([[f.g.authorizer.toLowerCase(),f.budget]]));assert.equal(report.ready,false);assert(report.reasons.includes('INTAKE_QUALITY_UNRESOLVED'));assert(report.coverage.unresolved>=1);
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{assert.equal((await intakeFollowups(reopened,chain,tenant)).cases.length,1);}finally{reopened.close();}
  await c.connection.provider.request({method:'evm_revert',params:[snapshot]});cases=(await intakeFollowups(f.store,chain,tenant)).cases;assert.equal(cases.length,1);assert.equal(cases[0].state,'recheck_required');
 }finally{f.close();await c.connection.close();}
});

test('resolved intake-only false alarm admits confirmed governed recovery but never re-enables a Grant or channel',async()=>{
 const f=await autoFixture(),{c}=f,tenant=f.q.enterpriseId,chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{[c.accounts.governor.address.toLowerCase()]:c.accounts.governor});
 const actor={address:c.accounts.assessor.address.toLowerCase(),tenant,role:'ASSESSOR'},reviewer={...actor,address:c.accounts.assessor2.address.toLowerCase()},supervisor={...actor,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'},budgets=new Map([[f.g.authorizer.toLowerCase(),f.budget]]);
 try{
  await seedIntake(f.store,chain,c.accounts.insured,f.request,800000000n);await observeRouting(f.store,f.reviewer,f.request);
  const portal={routing:async()=>routingObservations(f.store,tenant),status:async()=>({}),import:async()=>({}),submit:async()=>({})},options={intakePortal:portal,safetyGovernor:c.accounts.governor.address};
  const trigger={id:id(),noticeId:f.request.noticeId,outcome:'missed_escalation',reason:'synthetic false alarm'};await recordIntakeQuality(f.store,chain,actor,trigger,options);
  const worker=new Worker(f.store,chain);await worker.tick();await worker.tick();await c.connection.provider.request({method:'evm_mine'});await new Indexer(f.store,chain,0n).sync();
  const followup={...trigger,id:id(),outcome:'no_issue_observed',reason:'another reviewer verifies unchanged inputs'};await recordIntakeQuality(f.store,chain,reviewer,followup,options);
  await resolveIntakeQuality(f.store,chain,supervisor,{id:id(),triggerId:trigger.id,reviewId:followup.id,type:'false_alarm',reason:'independent supervisor confirms false alarm'});
  await c.send(f.registry,'revoke',[f.request.grantId]);await c.connection.provider.request({method:'evm_mine'});await f.authorizer.reconcile();
  const ready=await recoveryReadiness(f.store,chain,f.g.templateId,budgets);assert.equal(ready.ready,true,ready.reasons.join());assert.equal(ready.coverage.unresolved,0);assert.equal(ready.coverage.cases,1);
  const before=await chain.policy(f.request.policyId),planId=id(),executor=new RecoveryExecutor(f.store,chain,c.accounts.governor.address,budgets);await executor.plan(planId,f.g.templateId,H('intake recovery evidence'));await executor.tick(planId);
  await c.connection.provider.request({method:'evm_mine'});
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{const restarted=new RecoveryExecutor(reopened,chain,c.accounts.governor.address,budgets);await restarted.tick(planId);assert.equal(restarted.get(planId).state,'confirmed');}finally{reopened.close();}
  assert.equal(await c.read(f.registry,'disabledVersion',[f.g.templateId]),false);assert.equal((await c.read(f.registry,'getGrant',[f.request.grantId])).enabled,false);
  for(const channel of [1,2]){assert.equal(await c.read(f.registry,'approvalEnabled',[channel]),false);assert.equal(await c.read(f.registry,'paymentEnabled',[channel]),false);}
  assert.deepEqual(await chain.policy(f.request.policyId),before);
  console.log('Intake recovery evidence:',c.save('intake-recovery',{ready,planId,before}));
 }finally{f.close();await c.connection.close();}
});
