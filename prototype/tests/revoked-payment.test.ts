import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {H,id,U} from './chain-helper.ts';

test('AC42 paused/revoked signed payments reject different relayers; manual takeover needs fresh independent authorization',async()=>{
 const f=await autoFixture(),{c}=f;
 try{
  await f.enable();const assessment=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessment.a,assessment.signature),d=job.args[0];
  await c.send(c.core,'registerDecision',job.args,'executor');
  const payment=await f.authorizer.payment(d.reservationId,'800000000',id()),before=await c.state(f.q,d.incidentId);
  for(const action of ['channel','version','revoke'] as const){
   const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
   if(action==='channel')await f.enable(true,false);
   else if(action==='version')await c.send(f.registry,'pauseVersion',[f.g.ruleVersion,true,H('pause signed automatic payment')]);
   else await c.send(f.registry,'revoke',[f.request.grantId]);
   for(const broadcaster of ['executor','governor','insured'] as const){
    await c.rejects(c.core,'executePayment',payment.args,broadcaster,action==='channel'?/ChannelPaused/:/GrantInactive/);
    assert.equal(await c.read(c.core,'usedPaymentIds',[payment.id]),false);
    assert.deepEqual(await c.state(f.q,d.incidentId),before);
   }
   await c.connection.provider.request({method:'evm_revert',params:[snapshot]});
  }
  await c.send(f.registry,'revoke',[f.request.grantId]);
  const premature=await c.payment(f.q,d.incidentId,800n*U);
  await c.rejects(c.core,'executePayment',[premature.p,premature.sig],'executor',/GrantInactive/);
  assert.deepEqual(await c.state(f.q,d.incidentId),before);
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,true,H('independent manual takeover')]);
  const manual=await c.decision(f.q,[f.request.noticeId],d.incidentId,800n*U);
  assert.notEqual(manual.a.assessor.toLowerCase(),d.approver.toLowerCase());
  assert.notEqual(manual.d.approver.toLowerCase(),assessment.a.assessor.toLowerCase());
  await c.send(c.core,'registerDecision',manual.args,'executor');
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,false,H('manual review complete')]);
  for(const old of [payment.args,[premature.p,premature.sig]])await c.rejects(c.core,'executePayment',old,'executor',/StaleDecision/);
  const fresh=await c.payment(f.q,d.incidentId,800n*U);
  await c.rejects(c.core,'executePayment',[fresh.p,payment.args[1]],'executor',/InvalidSignature/);
  assert.equal((await c.state(f.q,d.incidentId)).incident.D,800n*U);
  await c.send(c.core,'executePayment',[fresh.p,fresh.sig],'executor');
  const final=await c.state(f.q,d.incidentId);assert.equal(final.incident.P,800n*U);assert.equal(final.incident.D,0n);assert.equal(final.incident.manualHold,true);
  assert.equal(await c.read(c.core,'usedPaymentIds',[payment.id]),false);
  // Revocation/manual settlement alone never guesses that an outstanding automatic signature expired.
  assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'800000000');
  console.log('Revoked payment evidence:',c.save('revoked-payment',{status:'passed',before,final,automaticPaymentId:payment.id,manualPaymentId:fresh.p.paymentId}));
 }finally{f.close();await c.connection.close();}
});
