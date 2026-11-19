import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,H,U,id,zeroAddress} from './chain-helper.ts';

test('AC11 token freeze keeps approval and debt; unfreeze executes original payment once',async()=>{
 const c=await setup();try{
  const token=await c.deploy('AdversarialToken'),insurerId=H('freeze insurer'),vault=await c.deploy('PoolVault',[c.core.address,token.address,insurerId,10000n*U]);
  await c.send(c.core,'registerPool',[vault.address]);await c.send(token,'mint',[c.accounts.treasurer.address,150000n*U]);await c.send(token,'approve',[vault.address,150000n*U],'treasurer');await c.send(c.core,'depositCapital',[vault.address,150000n*U],'treasurer');await c.send(c.core,'sealPool',[vault.address]);
  await c.send(token,'mint',[c.accounts.insured.address,20000n*U]);await c.send(token,'approve',[vault.address,20000n*U],'insured');
  const q=await c.issue({pool:vault.address,token:token.address,insurerId}),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId]);await c.send(c.core,'registerDecision',d.args);
  const pay=await c.payment(q,d.d.incidentId,8000n*U),before=await c.state(q,d.d.incidentId,vault,token);
  await c.send(token,'configure',[5,zeroAddress,'0x']);await c.rejects(c.core,'executePayment',[pay.p,pay.sig],'executor',/TOKEN_FROZEN/);
  assert.deepEqual(await c.state(q,d.d.incidentId,vault,token),before);assert.equal(await c.read(c.core,'usedPaymentIds',[pay.p.paymentId]),false);
  await c.send(token,'configure',[0,zeroAddress,'0x']);await c.send(c.core,'executePayment',[pay.p,pay.sig],'executor');
  const final=await c.state(q,d.d.incidentId,vault,token);assert.equal(final.incident.P,8000n*U);assert.equal(final.incident.D,25000n*U);assert.equal(final.incident.decisionDigest,before.incident.decisionDigest);
  await c.rejects(c.core,'executePayment',[pay.p,pay.sig],'executor',/PaymentAlreadyExecuted/);assert.deepEqual(await c.state(q,d.d.incidentId,vault,token),final);
  console.log('Freeze evidence:',c.save('token-freeze',{status:'passed',before,final}));
 }finally{await c.connection.close();}
});

test('AC22 new-policy and payment pauses are independent and preserve existing obligations',async()=>{
 const c=await setup();try{
  const q=await c.issue(),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId]);await c.send(c.core,'registerDecision',d.args);
  const first=await c.payment(q,d.d.incidentId,8000n*U),before=await c.state(q,d.d.incidentId);
  await c.send(c.core,'setActionPause',[0,true,H('new policies only')]);assert.deepEqual(await c.state(q,d.d.incidentId),before);
  const blocked=await c.quote();await c.rejects(c.core,'purchasePolicy',[blocked.q,blocked.sig],'insured',/ChannelPaused/);
  await c.notice(q);await c.send(c.core,'executePayment',[first.p,first.sig],'executor');
  await c.send(c.core,'setActionPause',[0,false,H('resume new policies')]);
  const partial=await c.state(q,d.d.incidentId);await c.send(c.core,'setActionPause',[2,true,H('payments only')]);assert.deepEqual(await c.state(q,d.d.incidentId),partial);
  const remaining=await c.payment(q,d.d.incidentId,25000n*U);await c.rejects(c.core,'executePayment',[remaining.p,remaining.sig],'executor',/ChannelPaused/);
  assert.deepEqual(await c.state(q,d.d.incidentId),partial);
  const other=await c.quote({premium:1000n*U,annualLimit:1000n*U,incidentLimit:1000n*U});await c.send(c.core,'purchasePolicy',[other.q,other.sig],'insured');
  assert.equal((await c.read(c.core,'getIncident',[d.d.incidentId])).D,25000n*U);await c.notice(q);
  await c.send(c.core,'setActionPause',[2,false,H('resume payments')]);await c.send(c.core,'executePayment',[remaining.p,remaining.sig],'executor');
  const final=await c.state(q,d.d.incidentId);assert.equal(final.incident.P,33000n*U);assert.equal(final.incident.D,0n);
  console.log('Pause evidence:',c.save('action-pause',{status:'passed',final}));
 }finally{await c.connection.close();}
});

test('AC17 expiry retains capacity, accepts late report and executes still-valid approved payment',async()=>{
 const c=await setup();try{
  const q=await c.issue({endAt:(await c.now())+3700n}),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId]);await c.send(c.core,'registerDecision',d.args);
  const pay=await c.payment(q,d.d.incidentId,8000n*U),before=await c.state(q,d.d.incidentId);
  await c.connection.provider.request({method:'evm_setNextBlockTimestamp',params:[Number(q.endAt+1n)]});await c.connection.provider.request({method:'evm_mine'});
  assert.deepEqual(await c.state(q,d.d.incidentId),before);const late=await c.notice(q,{declaredIncidentAt:q.endAt-1n});assert.equal((await c.read(c.core,'getNotice',[late.n.noticeId])).data.policyId,q.quoteId);
  assert.equal(await c.read(c.vault,'K'),before.pool.K);await c.send(c.core,'executePayment',[pay.p,pay.sig],'executor');
  const final=await c.state(q,d.d.incidentId);assert.equal(final.incident.P,8000n*U);assert.equal(final.incident.D,25000n*U);assert.equal(final.pool.K,before.pool.K-8000n*U);
  console.log('Expiry evidence:',c.save('policy-expiry',{status:'passed',before,final}));
 }finally{await c.connection.close();}
});
