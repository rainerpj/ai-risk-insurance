import test from 'node:test';
import assert from 'node:assert/strict';
import {sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {autoFixture} from './m2b-fixture.ts';
import {U,id,H as KH} from './chain-helper.ts';
import {hash,json} from '../packages/service/store.ts';
import {H} from '../packages/service/reviewer.ts';

test('AC37 manual denial blocks fresh review and previously valid assessment',async()=>{
 const f=await autoFixture(),{c}=f;try{
  await f.enable();const assessed=await f.reviewer.assess(f.request);
  const denial=await c.decision(f.q,[f.request.noticeId],id(),0n,{reviewAmount:800n*U});
  await c.send(c.core,'registerDecision',denial.args,'executor');
  const before=await c.state(f.q,denial.d.incidentId);
  await assert.rejects(f.reviewer.assess(f.request),/EXISTING_OR_MANUAL_INCIDENT/);
  await assert.rejects(f.authorizer.authorize(f.request,assessed.a,assessed.signature),/EXISTING_OR_MANUAL_INCIDENT/);
  assert.equal(f.budget.all('SELECT * FROM reservations').length,0);
  assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
  assert.deepEqual(await c.state(f.q,denial.d.incidentId),before);
  console.log('Manual denial evidence:',c.save('forced-manual-denial',{status:'passed',before}));
 }finally{f.close();await c.connection.close();}
});

test('AC37 zero proposal and changed payee cannot obtain automatic approval',async()=>{
 for(const mode of ['zero','payee'] as const){
  const f=await autoFixture({}, {gross:800n*U,compensation:mode==='zero'?800n*U:0n});try{
   let request=f.request;
   if(mode==='payee'){
    const original=f.request.refs.find(ref=>f.reviewer.originals.read(ref).kind==='payment')!,body={...f.reviewer.originals.read(original),beneficiary:f.c.accounts.outsider.address};
    const doc={source:'payment',body,signature:sign(null,Buffer.from(hash(body)),f.sourceKeys.payment.privateKey).toString('base64')},ref=hash(doc);
    writeFileSync(resolve(f.dir,ref+'.json'),json(doc));const refs=f.request.refs.map(r=>r===original?ref:r);
    const n=await f.c.notice(f.q,{incidentCommitment:f.n.n.incidentCommitment,evidenceHash:H(refs)});request={...request,noticeId:n.n.noticeId,refs};
   }
   const before=await f.c.state(f.q);await assert.rejects(f.reviewer.assess(request),mode==='zero'?/ZERO_OR_CAP_CLIPPING/:/PAYMENT_MISMATCH/);
   assert.deepEqual(await f.c.state(f.q),before);assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
   console.log('Forced manual evidence:',f.c.save('forced-manual-'+mode,{status:'passed',before}));
  }finally{f.close();await f.c.connection.close();}
 }
});

test('AC37 appeal and disputed reduction preserve debt against automatic overwrite',async()=>{
 const f=await autoFixture(),{c}=f;try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),incidentId=job.args[0].incidentId;
  await c.send(c.core,'registerDecision',job.args,'executor');const payment=await f.authorizer.payment(job.args[0].reservationId,'200000000',id());await c.send(c.core,'executePayment',payment.args,'executor');
  const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  await c.send(c.core,'appendDispute',[incidentId,id(),1n,KH('disputed reduction request')],'insured');
  const disputed=await c.state(f.q,incidentId);assert.equal(disputed.incident.D,600n*U);
  await assert.rejects(f.reviewer.assess(f.request),/EXISTING_OR_MANUAL_INCIDENT/);
  await assert.rejects(f.authorizer.authorize(f.request,a.a,a.signature),/EXISTING_OR_MANUAL_INCIDENT/);
  await assert.rejects(f.authorizer.payment(job.args[0].reservationId,'1000000',id()),/DECISION_CHANGED_OR_MANUAL/);
  assert.deepEqual(await c.state(f.q,incidentId),disputed);
  await c.connection.provider.request({method:'evm_revert',params:[snapshot]});
  await c.send(c.core,'setIncidentFreeze',[incidentId,true,KH('manual reduction review')]);
  const manual=await c.decision(f.q,[f.request.noticeId],incidentId,600n*U,{reviewAmount:800n*U});await c.send(c.core,'registerDecision',manual.args,'executor');
  const revised=await c.state(f.q,incidentId);assert.equal(revised.incident.P,200n*U);assert.equal(revised.incident.D,400n*U);assert.equal(revised.incident.manualHold,true);
  await assert.rejects(f.reviewer.assess(f.request),/EXISTING_OR_MANUAL_INCIDENT/);
  // Replaying an already consumed decision ID fails before the version check.
  await c.rejects(c.core,'registerDecision',job.args,'executor',/InvalidInput/);assert.deepEqual(await c.state(f.q,incidentId),revised);
  console.log('Manual hold evidence:',c.save('forced-manual-hold',{status:'passed',disputed,revised}));
 }finally{f.close();await c.connection.close();}
});
