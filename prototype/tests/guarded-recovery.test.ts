import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H} from './chain-helper.ts';

test('guarded recovery cannot bypass active Grants, channels or changed governance; duplicate recovery and old signatures fail',async()=>{
 const f=await autoFixture(),{c}=f,version=f.g.templateId,read=(name:string,args:any[]=[])=>c.read(f.registry,name,args);
 try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;await c.send(c.core,'registerDecision',job.args,'executor');
  const old=await c.payment(f.q,d.incidentId,800000000n,{grantId:d.grantId,grantEpoch:d.grantEpoch,budgetVersion:d.budgetVersion,reservationId:d.reservationId},'approver2');
  await c.send(f.registry,'pauseVersion',[version,true,H('anomaly')]);
  const args=async()=>[version,await read('governanceRevision'),H('evidence snapshot'),H('approved recovery')];
  await c.rejects(f.registry,'recoverVersion',await args(),'executor',new RegExp('Unauthorized|'+H('Unauthorized()').slice(0,10)));
  await c.rejects(f.registry,'recoverVersion',await args(),'governor',new RegExp('GrantInactive|'+H('GrantInactive()').slice(0,10)));assert.equal(await read('activeTemplateGrants',[version]),1n);
  await c.send(f.registry,'revoke',[f.request.grantId]);await c.rejects(f.registry,'recoverVersion',await args(),'governor',new RegExp('ChannelPaused|'+H('ChannelPaused()').slice(0,10)));
  await f.enable(false,false);const signedArgs=await args();
  await c.send(f.registry,'pauseVersion',[version,true,H('new pause')]);await c.rejects(f.registry,'recoverVersion',signedArgs,'governor',new RegExp('GrantInactive|'+H('GrantInactive()').slice(0,10)));
  const newGrant=id();await c.send(f.registry,'configure',[newGrant,{...f.g,enabled:false}]);
  const before=await c.state(f.q,d.incidentId),readyArgs=await args();await c.send(f.registry,'recoverVersion',readyArgs);
  assert.equal(await read('disabledVersion',[version]),false);assert.equal(await read('activeTemplateGrants',[version]),0n);assert.equal(await read('approvalEnabled',[1]),false);assert.deepEqual(await c.state(f.q,d.incidentId),before);
  await c.rejects(f.registry,'recoverVersion',readyArgs,'governor',new RegExp('GrantInactive|'+H('GrantInactive()').slice(0,10)));await f.enable();await c.rejects(c.core,'executePayment',[old.p,old.sig],'executor',new RegExp('GrantInactive|'+H('GrantInactive()').slice(0,10)));
  console.log('Guarded recovery evidence:',c.save('guarded-recovery',{readyArgs,before}));
 }finally{f.close();await c.connection.close();}
});

test('active template counts follow replacement, disabled configuration and repeated revoke exactly',async()=>{
 const f=await autoFixture(),{c}=f,first=f.g.templateId,second=H('second-template'),count=(v:string)=>c.read(f.registry,'activeTemplateGrants',[v]);
 try{
  const other=id();await c.send(f.registry,'configure',[other,f.g]);assert.equal(await count(first),2n);
  await c.send(f.registry,'configure',[f.request.grantId,{...f.g,templateId:second}]);assert.equal(await count(first),1n);assert.equal(await count(second),1n);
  await c.send(f.registry,'configure',[other,{...f.g,enabled:false}]);assert.equal(await count(first),0n);
  await c.send(f.registry,'revoke',[other]);await c.send(f.registry,'revoke',[other]);assert.equal(await count(first),0n);
  await c.send(f.registry,'revoke',[f.request.grantId]);assert.equal(await count(second),0n);
 }finally{f.close();await c.connection.close();}
});

test('recovered Grant and explicit global channel activation bind evidence, revision, epoch and current permissions without resetting obligations',async()=>{
 const f=await autoFixture(),{c}=f,version=f.g.templateId,evidence=H('approved recovery plan'),reason=H('explicit global channel approval');
 const read=(name:string,args:any[]=[])=>c.read(f.registry,name,args),revision=()=>read('governanceRevision');
 const inactive=new RegExp('GrantInactive|'+H('GrantInactive()').slice(0,10));
 try{
  await f.enable();const assessment=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessment.a,assessment.signature),d=job.args[0] as any;
  await c.send(c.core,'registerDecision',job.args,'executor');
  const old=await c.payment(f.q,d.incidentId,800000000n,{grantId:d.grantId,grantEpoch:d.grantEpoch,budgetVersion:d.budgetVersion,reservationId:d.reservationId},'approver2');
  const before=await c.state(f.q,d.incidentId),reserved=f.budget.all('SELECT id,remaining,state FROM reservations');
  await c.send(f.registry,'pauseVersion',[version,true,reason]);await c.send(f.registry,'revoke',[f.request.grantId]);await f.enable(false,false);
  await c.rejects(f.registry,'configureRecovered',[f.request.grantId,f.g,await revision(),evidence],'governor',inactive);
  await c.send(f.registry,'recoverVersion',[version,await revision(),evidence,reason]);
  const args=[f.request.grantId,f.g,await revision(),evidence];
  await c.rejects(f.registry,'configureRecovered',args,'executor',new RegExp('Unauthorized|'+H('Unauthorized()').slice(0,10)));
  await c.rejects(f.registry,'configureRecovered',[f.request.grantId,f.g,await revision(),H('wrong evidence')],'governor',inactive);
  await c.send(f.registry,'configureRecovered',args);
  const recovered=await read('getGrant',[f.request.grantId]);assert(recovered.epoch>BigInt(d.grantEpoch));
  assert.equal(await read('approvalEnabled',[1]),false);assert.equal(await read('paymentEnabled',[1]),false);
  const activation=[f.request.grantId,true,false,await revision(),evidence,reason];
  await c.send(f.registry,'enableRecoveredChannel',activation);assert.equal(await read('approvalEnabled',[1]),true);assert.equal(await read('paymentEnabled',[1]),false);
  await c.rejects(f.registry,'enableRecoveredChannel',activation,'governor',inactive);
  await c.send(f.registry,'enableRecoveredChannel',[f.request.grantId,true,true,await revision(),evidence,reason]);
  await c.rejects(c.core,'executePayment',[old.p,old.sig],'executor',inactive);
  assert.deepEqual(await c.state(f.q,d.incidentId),before);assert.deepEqual(f.budget.all('SELECT id,remaining,state FROM reservations'),reserved);
  // Ordinary configuration changes the epoch and cannot reuse the earlier recovery activation proof.
  await f.enable(false,false);await c.send(f.registry,'configure',[f.request.grantId,f.g]);
  await c.rejects(f.registry,'enableRecoveredChannel',[f.request.grantId,true,true,await revision(),evidence,reason],'governor',inactive);
  await c.send(f.registry,'configureRecovered',[f.request.grantId,f.g,await revision(),evidence]);
  await c.send(c.core,'revokeRole',[H('AUTO_AUTHORIZER'),f.g.authorizer]);
  await c.rejects(f.registry,'enableRecoveredChannel',[f.request.grantId,true,true,await revision(),evidence,reason],'governor',inactive);
  await c.send(c.core,'grantRole',[H('AUTO_AUTHORIZER'),f.g.authorizer]);
  await c.send(f.registry,'pauseVersion',[version,true,reason]);await c.send(f.registry,'pauseVersion',[version,false,reason]);
  await c.rejects(f.registry,'enableRecoveredChannel',[f.request.grantId,true,true,await revision(),evidence,reason],'governor',inactive);
  console.log('Recovery activation evidence:',c.save('recovery-activation',{recovered,before,reserved}));
 }finally{f.close();await c.connection.close();}
});
