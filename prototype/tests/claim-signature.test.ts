import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,id,U} from './chain-helper.ts';
import {types} from '../packages/domain/typed-data.ts';

test('AC06 claim and payment signatures bind recipient, amount, chain, contract, schema version and deployment',async()=>{
 const c=await setup(),outcomes:string[]=[];
 try{
  const q=await c.issue(),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId]);
  const before=await c.state(q,d.d.incidentId);
  const domains=[['chain',{...c.scope,chainId:1}],['contract',{...c.scope,verifyingContract:c.vault.address}],['version',{...c.scope,version:'2'}],['deployment',{...c.scope,salt:id()}]] as const;
  for(const [name,domain] of domains){
   for(const type of ['Assessment','ClaimDecision'] as const){
    c.label(type+'-'+name);const args=[...d.args];
    args[type==='Assessment'?4:5]=await (type==='Assessment'?c.accounts.assessor:c.accounts.approver).signTypedData({domain,types,primaryType:type,message:type==='Assessment'?d.a:d.d});
    await c.rejects(c.core,'registerDecision',args,'executor',/InvalidSignature/);
    assert.deepEqual(await c.state(q,d.d.incidentId),before);
    assert.equal(await c.read(c.core,'usedDecisionIds',[d.d.decisionId]),false);outcomes.push(type+'-'+name);
   }
  }
  for(const change of [{beneficiary:c.accounts.outsider.address},{netApproved:d.d.netApproved-1n}]){
   c.label('decision-field-tamper');const args=[...d.args];args[0]={...d.d,...change};
   await c.rejects(c.core,'registerDecision',args,'executor');assert.deepEqual(await c.state(q,d.d.incidentId),before);
  }
  await c.send(c.core,'registerDecision',d.args,'executor');
  const payment=await c.payment(q,d.d.incidentId,8000n*U),approved=await c.state(q,d.d.incidentId);
  for(const [name,domain] of domains){
   c.label('payment-'+name);const signature=await c.accounts.approver.signTypedData({domain,types,primaryType:'PaymentAuthorization',message:payment.p});
   await c.rejects(c.core,'executePayment',[payment.p,signature],'executor',/InvalidSignature/);
   assert.deepEqual(await c.state(q,d.d.incidentId),approved);assert.equal(await c.read(c.core,'usedPaymentIds',[payment.p.paymentId]),false);outcomes.push('payment-'+name);
  }
  for(const change of [{beneficiary:c.accounts.outsider.address},{amount:payment.p.amount+1n}]){
   c.label('payment-field-tamper');await c.rejects(c.core,'executePayment',[{...payment.p,...change},payment.sig],'executor',/InvalidSignature/);
   assert.deepEqual(await c.state(q,d.d.incidentId),approved);assert.equal(await c.read(c.core,'usedPaymentIds',[payment.p.paymentId]),false);
  }
  c.label('original-authorization-success');await c.send(c.core,'executePayment',[payment.p,payment.sig],'executor');
  const paid=await c.read(c.core,'getIncident',[d.d.incidentId]);assert.equal(paid.P,8000n*U);assert.equal(paid.D,25000n*U);
  console.log('Claim signature evidence:',c.save('claim-signature',{status:'passed',domains:outcomes,fieldTamperingCases:4,originalPaymentAccepted:true}));
 }finally{await c.connection.close();}
});
