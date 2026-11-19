import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H} from './chain-helper.ts';
import {Chain} from '../packages/service/chain.ts';
import {custom} from 'viem';
import {recordQuality,qualityCases} from '../packages/service/quality.ts';
import {resolveQuality} from '../packages/service/quality-resolution.ts';
import {Worker} from '../packages/service/indexer.ts';
import {recoveryReadiness} from '../packages/service/recovery-readiness.ts';
import {RecoveryExecutor} from '../packages/service/recovery-executor.ts';
import {Store,json} from '../packages/service/store.ts';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {BudgetObserver} from '../packages/service/budget-observer.ts';
import {activationReadiness} from '../packages/service/activation-readiness.ts';

test('template recovery requires resolved coverage, confirmed Grant revocation and same-checkpoint reconciled budgets without releasing debt',async()=>{
 let governorKey='';
 const f=await autoFixture({captureKey:(name,key)=>{if(name==='governor')governorKey=key;}}),{c}=f,chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{[c.accounts.governor.address.toLowerCase()]:c.accounts.governor});
 const budgets=new Map([[f.g.authorizer.toLowerCase(),f.budget]]),check=()=>recoveryReadiness(f.store,chain,f.g.templateId,budgets);
 try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;await c.send(c.core,'registerDecision',job.args,'executor');
  const oldSigned=await c.payment(f.q,d.incidentId,800000000n,{grantId:d.grantId,grantEpoch:d.grantEpoch,budgetVersion:d.budgetVersion,reservationId:d.reservationId},'approver2');
  const actor={address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
  const anomaly={id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'underpayment',reason:'synthetic check'};await recordQuality(f.store,chain,actor,anomaly,c.accounts.governor.address);
  await new Worker(f.store,chain).tick();await f.enable(false,false);await c.connection.provider.request({method:'evm_mine'});
  let report=await check();assert(report.reasons.includes('QUALITY_CASES_UNRESOLVED'));assert(report.reasons.includes('AFFECTED_GRANT_REVOCATION_REQUIRED'));
  const review={...anomaly,id:id(),outcome:'correct',reason:'independent review supports original amount'};await recordQuality(f.store,chain,actor,review);
  const caseId=(await qualityCases(f.store,chain,actor.tenant))[0].id;
  await resolveQuality(f.store,chain,{...actor,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'},{id:id(),caseId,reviewId:review.id,type:'false_alarm',reason:'independent supervisor evidence'});
  await c.send(f.registry,'revoke',[f.request.grantId]);await c.connection.provider.request({method:'evm_mine'});
  report=await check();assert(report.reasons.includes('BUDGET_CHECKPOINT_MISMATCH'));await f.authorizer.reconcile();
  const before=f.budget.all('SELECT id,remaining,state FROM reservations');report=await check();assert.equal(report.ready,true,report.reasons.join());assert.equal(report.coverage.unresolved,0);
  assert.deepEqual(f.budget.all('SELECT id,remaining,state FROM reservations'),before);assert.equal((await chain.incident(d.incidentId)).D,800000000n);assert.equal(await c.read(f.registry,'disabledVersion',[f.g.templateId]),true);
  assert((await recoveryReadiness(f.store,chain,f.g.templateId,new Map())).reasons.includes('AUTHORIZER_BUDGET_UNAVAILABLE'));
  const executor=new RecoveryExecutor(f.store,chain,c.accounts.governor.address,budgets),planId=id(),reason=H('governed local recovery');
  await executor.plan(planId,f.g.templateId,reason);
  assert.equal((await executor.plan(planId,f.g.templateId,reason)).state,'planned');
  await assert.rejects(()=>executor.plan(planId,f.g.templateId,H('different')),/RECOVERY_PLAN_CONFLICT/);
  const updatedReview={...review,id:id(),reason:'new independent evidence with same conclusion'};
  await recordQuality(f.store,chain,actor,updatedReview);
  await resolveQuality(f.store,chain,{...actor,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'},{id:id(),caseId,reviewId:updatedReview.id,type:'false_alarm',reason:'replaced review checked independently'});
  const changed=await check();assert.equal(changed.ready,true);assert.deepEqual(changed.coverage,report.coverage);
  assert.notEqual(changed.digest,JSON.parse(executor.get(planId).payload).report.digest,'same counts must not hide changed review evidence');
  await assert.rejects(()=>executor.tick(planId),/RECOVERY_PLAN_STALE/);
  await c.connection.provider.request({method:'evm_mine'});assert((await check()).reasons.includes('BUDGET_CHECKPOINT_MISMATCH'));
  await assert.rejects(()=>executor.tick(planId),/RECOVERY_PLAN_STALE/);assert.equal(executor.get(planId).raw,null);
  await f.authorizer.reconcile();const fresh=id();
  const branch=await c.connection.provider.request({method:'evm_snapshot'});
  let broadcasts=0;
  const server=createServer(async(req,res)=>{
   try{let body='';for await(const part of req)body+=part;const call=JSON.parse(body);if(call.method==='eth_sendRawTransaction')broadcasts++;
    const result=await c.connection.provider.request({method:call.method,params:call.params??[]});res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:call.id,result}));
   }catch(e:any){res.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:e.code??-32000,message:e.message}}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as any).port,config=f.dir+'/governor-private.json';
  writeFileSync(config,JSON.stringify({rpc:`http://127.0.0.1:${port}`,privateKey:governorKey,core:c.core.address,deploymentId:c.salt,database:'executor.sqlite',confirmations:2,budgets:[{authorizer:f.g.authorizer,database:'budget.sqlite'}]}));
  const child=(fault=false,command='tick',planId=fresh,extra:string[]=[])=>new Promise<{code:number|null;output:string}>((resolve,reject)=>{
   const p=spawn(process.execPath,['--import','tsx','scripts/govern-recovery.ts',config,command,planId,...extra,...(command==='plan'?[f.g.templateId,reason]:[]),...(fault?['--test-exit-after-broadcast']:[])],{windowsHide:true});let output='';
   p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>resolve({code,output}));
  });
  let signed:any;const configured=id(),configureRequest={kind:'configure' as const,grantId:f.request.grantId,grant:f.g};
  try{
   const planned=await child(false,'plan');assert.equal(planned.code,0,planned.output);assert.match(planned.output,/"state":"planned"/);
   const crashed=await child(true);assert.equal(crashed.code,73,crashed.output);assert.equal(executor.get(fresh).state,'unknown');signed=executor.get(fresh);
   await c.connection.provider.request({method:'evm_mine'});
   const recovered=await child();assert.equal(recovered.code,0,recovered.output);assert.match(recovered.output,/"state":"confirmed"/);assert.equal(broadcasts,1);
   const status=await child(false,'status');assert.equal(status.code,0,status.output);assert.match(status.output,/"state":"confirmed"/);assert.equal(broadcasts,1);
   assert.equal(f.budget.meta('ready'),'1','governor observer must not pause authorizer');
   const observer=new BudgetObserver(f.budgetPath,f.scope);try{assert.throws(()=>observer.get("UPDATE meta SET v='0' WHERE k='ready'"),/readonly/);}finally{observer.close();}
   await f.authorizer.reconcile();writeFileSync(f.dir+'/activation.json',json({recoveryId:fresh,request:configureRequest,reason}));
   const plannedConfig=await child(false,'plan-activation',configured,['activation.json']);assert.equal(plannedConfig.code,0,plannedConfig.output);
   const beforePrepare=await child(false,'tick',configured,['--test-exit-before-prepare']);assert.equal(beforePrepare.code,76,beforePrepare.output);
   assert.equal(executor.get(configured).state,'preparing');assert.equal(f.store.get('SELECT * FROM recovery_unsigned WHERE plan_id=?',configured),undefined);
   const beforeSign=await child(false,'tick',configured,['--test-exit-before-sign']);assert.equal(beforeSign.code,74,beforeSign.output);
   const unsigned=f.store.get('SELECT payload_hash FROM recovery_unsigned WHERE plan_id=?',configured).payload_hash;
   assert.equal(executor.get(configured).state,'signing');assert.equal(executor.get(configured).raw,null);
   const afterSign=await child(false,'tick',configured,['--test-exit-after-sign']);assert.equal(afterSign.code,75,afterSign.output);
   assert.equal(f.store.get('SELECT payload_hash FROM recovery_unsigned WHERE plan_id=?',configured).payload_hash,unsigned);assert.equal(executor.get(configured).raw,null);
   const competitors=await Promise.all([child(false,'tick',configured,['--test-exit-after-sign']),child(false,'tick',configured,['--test-exit-after-sign'])]);
   for(const result of competitors)assert.equal(result.code,75,result.output);
   const hashes=f.store.all('SELECT value FROM meta WHERE key LIKE ?',`testRecoverySigner:${configured}:%`);assert.equal(hashes.length,3);assert.equal(new Set(hashes.map(r=>r.value)).size,1);
   const configCrash=await child(true,'tick',configured);assert.equal(configCrash.code,73,configCrash.output);const raw=executor.get(configured).raw;
   assert.equal(executor.get(configured).tx_hash,f.store.getMeta('testRecoverySignedHash:'+configured));
   await c.connection.provider.request({method:'evm_mine'});
   const configRestart=await child(false,'tick',configured);assert.equal(configRestart.code,0,configRestart.output);assert.equal(executor.get(configured).state,'confirmed');assert.equal(executor.get(configured).raw,raw);assert.equal(broadcasts,2);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  await c.connection.provider.request({method:'evm_mine'});
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);
  try{
   const restarted=new RecoveryExecutor(reopened,chain,c.accounts.governor.address,budgets);
   assert.equal((await restarted.tick(fresh)).state,'confirmed');assert.equal(broadcasts,2);
   assert.equal(restarted.get(fresh).raw,signed.raw);assert.equal(restarted.get(fresh).tx_hash,signed.tx_hash);
   assert.equal((await restarted.tick(fresh)).state,'confirmed');
   const wrong=new RecoveryExecutor(reopened,chain,c.accounts.executor.address,budgets);
   await assert.rejects(()=>wrong.tick(fresh),/RECOVERY_EXECUTOR_SCOPE/);
  }finally{reopened.close();}
  assert.equal(await c.read(f.registry,'disabledVersion',[f.g.templateId]),false);
  assert.equal(await c.read(f.registry,'approvalEnabled',[1]),false);assert.equal(await c.read(f.registry,'paymentEnabled',[2]),false);
  assert.deepEqual(f.budget.all('SELECT id,remaining,state FROM reservations'),before);
  await f.authorizer.reconcile();
  assert.equal(await c.read(f.registry,'approvalEnabled',[1]),false);assert.equal(await c.read(f.registry,'paymentEnabled',[1]),false);
  await f.authorizer.reconcile();
  const enableRequest={kind:'enable' as const,grantId:f.request.grantId,approve:true,pay:true},obsolete=id();
  await executor.planActivation(obsolete,fresh,enableRequest,reason);
  const shared=id();await c.send(f.registry,'configure',[shared,{...f.g,templateId:H('other shared channel template'),riskGroupId:H('unmapped risk')}]);
  await c.connection.provider.request({method:'evm_mine'});await f.authorizer.reconcile();
  const unsafe=await activationReadiness(f.store,chain,fresh,enableRequest,budgets);assert.equal(unsafe.grants.length,2);assert(unsafe.reasons.includes('RISK_GROUP_MISMATCH'));
  await assert.rejects(()=>executor.tick(obsolete),/RECOVERY_PLAN_STALE/);assert.equal(executor.get(obsolete).raw,null);
  await assert.rejects(()=>executor.planActivation(id(),fresh,enableRequest,reason),/ACTIVATION_NOT_READY/);
  await c.send(f.registry,'revoke',[shared]);await c.connection.provider.request({method:'evm_mine'});await f.authorizer.reconcile();
  const originalLimit=f.budget.get("SELECT config FROM limits WHERE dimension='GLOBAL'").config;
  f.budget.run("UPDATE limits SET config=? WHERE dimension='GLOBAL'",JSON.stringify({...JSON.parse(originalLimit),amount:'700000000'}));
  assert((await activationReadiness(f.store,chain,fresh,enableRequest,budgets)).reasons.includes('ROLLING_BUDGET_EXCEEDED'));
  f.budget.run("UPDATE limits SET config=? WHERE dimension='GLOBAL'",originalLimit);
  const chainRead=chain.read.bind(chain);let mutated=false;
  chain.read=(name:string,args:unknown[]=[],blockNumber?:bigint)=>{
   if(name==='ledgerHash'&&!mutated){mutated=true;f.budget.run("UPDATE limits SET config=? WHERE dimension='GLOBAL'",JSON.stringify({...JSON.parse(originalLimit),amount:'700000000'}));}
   return chainRead(name,args,blockNumber);
  };
  try{const raced=await activationReadiness(f.store,chain,fresh,enableRequest,budgets);assert(mutated);assert(raced.reasons.includes('BUDGET_CHANGED_DURING_ACTIVATION_CHECK'));}
  finally{chain.read=chainRead;f.budget.run("UPDATE limits SET config=? WHERE dimension='GLOBAL'",originalLimit);}
  const mismatch=await activationReadiness(f.store,chain,fresh,{...configureRequest,grant:{...f.g,budgetVersion:2n}},budgets);assert(mismatch.reasons.includes('BUDGET_VERSION'));
  const enabled=id();await executor.planActivation(enabled,fresh,enableRequest,reason);assert.equal((await executor.tick(enabled)).state,'submitted');
  await c.connection.provider.request({method:'evm_mine'});assert.equal((await executor.tick(enabled)).state,'confirmed');
  assert.equal(await c.read(f.registry,'approvalEnabled',[1]),true);assert.equal(await c.read(f.registry,'paymentEnabled',[1]),true);
  assert.deepEqual(f.budget.all('SELECT id,remaining,state FROM reservations'),before);
  await c.rejects(c.core,'executePayment',[oldSigned.p,oldSigned.sig],'executor',/GrantInactive/);
  assert.equal((await chain.incident(d.incidentId)).D,800000000n);
  await c.connection.provider.request({method:'evm_revert',params:[branch]});
  assert.equal((await executor.tick(fresh)).state,'unknown');assert.equal(executor.get(fresh).error,'RECEIPT_LOST');
  assert.equal(executor.get(fresh).raw,signed.raw);assert.equal(await c.read(f.registry,'disabledVersion',[f.g.templateId]),true);
  console.log('Recovery readiness evidence:',c.save('recovery-readiness',report));
 }finally{f.close();await c.connection.close();}
});
