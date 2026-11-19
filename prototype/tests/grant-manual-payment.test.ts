import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {H,U,id,setup} from './chain-helper.ts';

test('AC07 revoked Grant preserves paid ledger and manual takeover pays only remaining debt',async()=>{
 const f=await autoFixture(),{c}=f;
 try{
  await f.enable();const assessment=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessment.a,assessment.signature),d=job.args[0] as any;
  await c.send(c.core,'registerDecision',job.args,'executor');
  const first=await f.authorizer.payment(d.reservationId,'200000000',id());await c.send(c.core,'executePayment',first.args,'executor');
  await c.connection.provider.request({method:'evm_mine'});await f.authorizer.reconcile();
  const old=await f.authorizer.payment(d.reservationId,'600000000',id()),before=await c.state(f.q,d.incidentId);
  assert.equal(before.incident.P,200n*U);assert.equal(before.incident.D,600n*U);
  await c.send(f.registry,'revoke',[f.request.grantId]);
  await c.rejects(c.core,'executePayment',old.args,'executor',/GrantInactive/);
  assert.deepEqual(await c.state(f.q,d.incidentId),before);
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,true,H('grant revoked manual reconciliation')]);
  const manual=await c.decision(f.q,[f.request.noticeId as any],d.incidentId,800n*U);await c.send(c.core,'registerDecision',manual.args,'executor');
  const transferred=await c.read(c.core,'getIncident',[d.incidentId]);assert.equal(transferred.P,200n*U);assert.equal(transferred.D,600n*U);assert.equal(transferred.manualHold,true);
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,false,H('manual payment approved')]);
  await c.rejects(c.core,'executePayment',old.args,'executor',/StaleDecision/);
  const remaining=await c.payment(f.q,d.incidentId,600n*U);await c.send(c.core,'executePayment',[remaining.p,remaining.sig],'executor');
  const final=await c.state(f.q,d.incidentId);assert.equal(final.incident.P,800n*U);assert.equal(final.incident.D,0n);assert.equal(final.policy.paidTotal,800n*U);
  await c.rejects(c.core,'executePayment',old.args,'executor',/StaleDecision/);assert.deepEqual(await c.state(f.q,d.incidentId),final);
  console.log('Grant manual payment evidence:',c.save('grant-manual-payment',{status:'passed',before,final}));
 }finally{f.close();await c.connection.close();}
});

test('AC07 expired supervisor authorization retains debt until fresh co-signed decision settles it',async()=>{
 const c=await setup();
 try{
  const q=await c.issue(),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId],id(),50001n*U);
  d.s.expiresAt=(await c.now())+20n;d.args[7]=await c.sign('SupervisorApproval',d.s,'supervisor');await c.send(c.core,'registerDecision',d.args);
  const first=await c.payment(q,d.d.incidentId,8000n*U);await c.send(c.core,'executePayment',[first.p,first.sig],'executor');
  const old=await c.payment(q,d.d.incidentId,42001n*U),before=await c.state(q,d.d.incidentId);
  await c.connection.provider.request({method:'evm_setNextBlockTimestamp',params:[Number(d.s.expiresAt)]});await c.connection.provider.request({method:'evm_mine'});
  await c.rejects(c.core,'executePayment',[old.p,old.sig],'executor',/ExpiredAuthorization/);assert.deepEqual(await c.state(q,d.d.incidentId),before);
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,true,H('renew supervisor authorization')]);
  const fresh=await c.decision(q,[n.n.noticeId],d.d.incidentId,50001n*U);await c.send(c.core,'registerDecision',fresh.args);
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,false,H('fresh supervisor co-sign confirmed')]);
  await c.rejects(c.core,'executePayment',[old.p,old.sig],'executor',/StaleDecision/);
  const rest=await c.payment(q,d.d.incidentId,42001n*U);await c.send(c.core,'executePayment',[rest.p,rest.sig],'executor');
  const final=await c.state(q,d.d.incidentId);assert.equal(final.incident.P,50001n*U);assert.equal(final.incident.D,0n);
  console.log('Supervisor recovery evidence:',c.save('supervisor-renewal',{status:'passed',before,final}));
 }finally{await c.connection.close();}
});
