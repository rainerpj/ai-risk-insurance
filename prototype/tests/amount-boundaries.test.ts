import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,H,id} from './chain-helper.ts';
import {validateMessage} from '../packages/domain/typed-data.ts';

test('AC25 smallest-unit settlement and recovery stay exact; invalid zero/negative/overflow fail',async()=>{
 const c=await setup(),MAX=2n**256n-1n;try{
  const q=await c.issue({incidentLimit:2n,annualLimit:2n}),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId],id(),1n);await c.send(c.core,'registerDecision',d.args);
  const before=await c.state(q,d.d.incidentId),zero=await c.payment(q,d.d.incidentId,0n);
  await c.rejects(c.core,'executePayment',[zero.p,zero.sig],'executor',/AmountMismatch/);assert.deepEqual(await c.state(q,d.d.incidentId),before);
  for(const amount of [-1n,MAX+1n])assert.throws(()=>validateMessage('PaymentAuthorization',{...zero.p,amount}));
  const pay=await c.payment(q,d.d.incidentId,1n);await c.send(c.core,'executePayment',[pay.p,pay.sig],'executor');
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,true,H('one unit recovery')]);
  const reduced=await c.decision(q,[n.n.noticeId],d.d.incidentId,0n,{reviewAmount:1n});await c.send(c.core,'registerDecision',reduced.args);
  assert.equal((await c.read(c.core,'getIncident',[d.d.incidentId])).Q,1n);
  await c.rejects(c.core,'returnRecovery',[d.d.incidentId,0n,id()],'insured',/RecoveryInvalid/);
  await c.send(c.core,'returnRecovery',[d.d.incidentId,1n,id()],'insured');
  const revised=await c.decision(q,[n.n.noticeId],d.d.incidentId,2n,{netApproved:1n});await c.send(c.core,'registerDecision',revised.args);
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,false,H('one unit remaining')]);
  const last=await c.payment(q,d.d.incidentId,1n);await c.send(c.core,'executePayment',[last.p,last.sig],'executor');
  const final=await c.state(q,d.d.incidentId);assert.equal(final.incident.P,2n);assert.equal(final.incident.R,1n);assert.equal(final.incident.N,1n);assert.equal(final.incident.D,0n);assert.equal(final.incident.Q,0n);
  const math=await c.deploy('SettlementMath'),expense=(gross:bigint)=>({gross,duplicate:0n,compensation:0n,recovery:0n}),limits={P:0n,R:0n,otherOccupied:0n,incidentLimit:1n,annualLimit:1n,oldDue:0n,claimed:1n,reviewAmount:MAX};
  assert.deepEqual(await c.read(math,'calculate',[[expense(MAX),expense(0n)],limits]),[1n,1n,0n]);
  await c.rejects(math,'calculate',[[expense(MAX),expense(1n)],limits]);
  await c.rejects(math,'calculate',[[{...expense(0n),duplicate:1n},expense(0n)],limits]);
  console.log('Amount boundary evidence:',c.save('amount-boundaries',{status:'passed',final,maximumLoss:MAX}));
 }finally{await c.connection.close();}
});
