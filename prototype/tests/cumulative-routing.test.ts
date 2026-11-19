import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {U,id} from './chain-helper.ts';
import {review,route} from '../packages/service/reviewer.ts';
import {sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {hash,json} from '../packages/service/store.ts';
import {H} from '../packages/service/reviewer.ts';
import {Authorizer} from '../packages/service/automatic.ts';

test('AC35 full 12x900 structured cost routes manual, not one 900 payment',async()=>{
 const f=await autoFixture({}, {gross:10800n*U,compensation:0n,units:12n});
 try{
  await f.enable();const grant=await f.reviewer.grant(f.request.grantId);
  await assert.rejects(review(f.makeChain('executor'),f.reviewer.originals,f.request,grant),e=>{
   assert.match(String(e),/MANUAL_REQUIRED/);assert.match(String(e),/10800000000/);assert.match(String(e),/manual/);return true;
  });
  await assert.rejects(f.reviewer.assess(f.request),/MANUAL_REQUIRED/);
  assert.equal(f.budget.all('SELECT * FROM reservations').length,0);
  console.log('Cumulative routing evidence:',f.c.save('cumulative-routing',{status:'passed',units:12,unitPrice:900n*U,fullReviewAmount:10800n*U}));
 }finally{f.close();await f.c.connection.close();}
});

test('AC35 annual remaining 500 cannot truncate a 12000 request into automatic approval',async()=>{
 const f=await autoFixture({}, {gross:12000n*U,compensation:0n});
 try{
  const n=await f.c.notice(f.q),d=await f.c.decision(f.q,[n.n.noticeId],id(),f.q.annualLimit-500n*U);
  await f.c.send(f.c.core,'registerDecision',d.args,'executor');
  const before=await f.c.state(f.q,d.d.incidentId),grant=await f.reviewer.grant(f.request.grantId);
  await assert.rejects(review(f.makeChain('executor'),f.reviewer.originals,f.request,grant),e=>{
   assert.match(String(e),/ZERO_OR_CAP_CLIPPING/);assert.match(String(e),/12000000000/);assert.match(String(e),/manual/);return true;
  });
  await assert.rejects(f.reviewer.assess(f.request),/MANUAL_REQUIRED/);
  assert.deepEqual(await f.c.state(f.q,d.d.incidentId),before);
  assert.equal(f.budget.all('SELECT * FROM reservations').length,0);
  console.log('Annual routing evidence:',f.c.save('annual-routing',{status:'passed',remaining:500n*U,fullReviewAmount:12000n*U}));
 }finally{f.close();await f.c.connection.close();}
});

test('AC35 cumulative decision already includes existing due; installments never add it twice',()=>{
 assert.equal(route(800n*U,600n*U,200n*U,800n*U).reviewAmount,800n*U);
 assert.equal(route(900n*U,600n*U,200n*U,900n*U).reviewAmount,900n*U);
 assert.equal(route(100n*U,600n*U,200n*U,100n*U).reviewAmount,800n*U);
 assert.equal(route(10800n*U,900n*U,9900n*U,10800n*U).channel,'manual');
});

test('12 separately signed 900 notices sharing an incident cannot obtain separate automatic authorizations',async()=>{
 const f=await autoFixture({}, {gross:900n*U,compensation:0n});
 try{
  await f.enable();const requests=[f.request];
  for(let index=1;index<12;index++){
   const refs=f.request.refs.map(ref=>{
    const body={...f.reviewer.originals.read(ref)};
    for(const key of ['expenseId','invoiceId','reference'])if(key in body)body[key]+='-'+index;
    const doc={source:body.kind,body,signature:sign(null,Buffer.from(hash(body)),f.sourceKeys[body.kind].privateKey).toString('base64')};
    const next=hash(doc);writeFileSync(resolve(f.dir,next+'.json'),json(doc));return next;
   });
   const n=await f.c.notice(f.q,{incidentCommitment:f.n.n.incidentCommitment,evidenceHash:H(refs)});
   requests.push({...f.request,noticeId:n.n.noticeId,refs});
  }
  const assessments=await Promise.all(requests.map(request=>f.reviewer.assess(request)));
  const attempts=await Promise.allSettled(requests.map((request,index)=>f.authorizer.authorize(request,assessments[index]!.a,assessments[index]!.signature)));
  assert(attempts.every(r=>r.status==='rejected'));
  // Retry every busy call: lock contention must not be the only reason the split was blocked.
  const restarted=new Authorizer(f.makeChain('approver2'),f.authorizer.originals,f.budget,f.g.authorizer);
  for(let index=0;index<requests.length;index++)await assert.rejects(restarted.authorize(requests[index]!,assessments[index]!.a,assessments[index]!.signature),/MANUAL_AGGREGATION_REQUIRED/);
  assert.equal(f.budget.all('SELECT * FROM reservations').length,0);assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
  console.log('Split notice evidence:',f.c.save('split-notices',{status:'passed',notices:requests.map(r=>r.noticeId),totalClaimed:10800n*U,authorized:0}));
 }finally{f.close();await f.c.connection.close();}
});

test('additional notice after approval blocks a new payment signature and preserves approved debt',async()=>{
 const f=await autoFixture();try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature);
  await f.c.send(f.c.core,'registerDecision',job.args,'executor');
  const before=await f.c.state(f.q,job.args[0].incidentId);
  await f.c.notice(f.q,{incidentCommitment:f.n.n.incidentCommitment,evidenceHash:H(['later-material'])});
  await assert.rejects(f.authorizer.payment(job.args[0].reservationId,(800n*U).toString(),id()),/MANUAL_AGGREGATION_REQUIRED/);
  assert.deepEqual(await f.c.state(f.q,job.args[0].incidentId),before);
  assert.equal(f.budget.all('SELECT * FROM payments').length,0);
  assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,(800n*U).toString());
  console.log('Late notice evidence:',f.c.save('late-split-notice',{status:'passed',before}));
 }finally{f.close();await f.c.connection.close();}
});
