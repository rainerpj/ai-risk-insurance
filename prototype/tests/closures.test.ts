import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {Indexer} from '../packages/service/indexer.ts';
import {workloadMetrics} from '../packages/service/workload.ts';
import {Store} from '../packages/service/store.ts';
import {projectedClosures} from '../packages/service/closures.ts';
import {H,id} from './chain-helper.ts';

test('confirmed settlement closure is durable, versioned, revocable on freeze/dispute/reorg and never releases capacity',async()=>{
 const f=await autoFixture(),{c}=f,chain=f.makeChain('executor'),index=new Indexer(f.store,chain,0n),metrics=()=>workloadMetrics(f.store,chain,f.q.enterpriseId);
 const sync=async()=>{await c.connection.provider.request({method:'evm_mine'});await index.sync();};
 try{
  f.store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',f.request.noticeId,f.q.enterpriseId,'synthetic-owner','{}','synthetic-digest',new Date().toISOString(),'awaiting_binding');
  await f.enable();const assessed=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessed.a,assessed.signature),d=job.args[0] as any;
  await c.send(c.core,'registerDecision',job.args,'executor');await sync();assert.equal((await metrics()).closure!.closed,0);
  const branch=await c.connection.provider.request({method:'evm_snapshot'});
  const payment=await c.payment(f.q,d.incidentId,800000000n,{grantId:d.grantId,grantEpoch:d.grantEpoch,budgetVersion:d.budgetVersion,reservationId:d.reservationId},'approver2');
  await c.send(c.core,'executePayment',[payment.p,payment.sig],'executor');await index.sync();assert.equal((await metrics()).closure!.closed,0,'mined is not confirmed closure');
  const paidState=await c.state(f.q,d.incidentId);await sync();let result=await metrics();assert.equal(result.closure!.automaticClosed,1);assert.deepEqual(result.automaticClosureRate,{numerator:1,denominator:1});assert.deepEqual(await c.state(f.q,d.incidentId),paidState);
  const first=f.store.get('SELECT * FROM claim_closures WHERE active=1');await sync();assert.equal(f.store.get('SELECT observed_at FROM claim_closures WHERE active=1').observed_at,first.observed_at);
  assert.deepEqual(result.channels![1]!.automaticClosureRate,{numerator:1,denominator:1});assert.deepEqual(result.templates![0]!.automaticClosureRate,{numerator:1,denominator:1});
  const timing=result.closure!.closureObservedMs;assert.equal(timing.observations,1);assert.equal(timing.unknown,0);assert(BigInt(timing.sum!)>=0n);
  assert.deepEqual((await metrics()).closure!.closureObservedMs,timing);
  assert(BigInt(timing.sum!)>=BigInt(result.channels![1]!.decisionObservedMs.sum!),'closure observation cannot precede decision observation');
  const received=f.store.get('SELECT received_at FROM notices WHERE id=?',f.request.noticeId).received_at;
  f.store.run('UPDATE notices SET received_at=? WHERE id=?','invalid',f.request.noticeId);assert.equal((await metrics()).closure!.closureObservedMs.unknown,1);assert.equal((await metrics()).closure!.closureObservedMs.mean,null);
  f.store.run('UPDATE notices SET received_at=? WHERE id=?',received,f.request.noticeId);
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{assert.equal((await workloadMetrics(reopened,chain,f.q.enterpriseId)).closure!.automaticClosed,1);}finally{reopened.close();}
  // A damaged/incomplete decision history must not be silently classified automatic.
  const currentViews=f.store.all('SELECT * FROM views').map(v=>[v.kind,v.id,v.tenant,v.payload]);
  f.store.run("UPDATE events SET canonical=0 WHERE name='DecisionRegistered'");
  const incomplete=await projectedClosures(f.store,chain,currentViews,await chain.block(BigInt(f.store.getMeta('confirmed')!)));assert.equal(incomplete[0][5],null);
  // Rebuilding restores actual events and the original first observation.
  await index.rebuild();assert.equal((await metrics()).closure!.automaticClosed,1);
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,true,H('pause review')]);await sync();assert.equal((await metrics()).closure!.closed,0);
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,false,H('resume')]);await sync();assert.equal((await metrics()).closure!.automaticClosed,1);assert.notEqual(f.store.get('SELECT id FROM claim_closures WHERE active=1').id,first.id);
  await c.send(c.core,'setIncidentFreeze',[d.incidentId,true,H('reduce verified loss')]);
  const reduced=await c.decision(f.q,[f.request.noticeId as any],d.incidentId,400000000n,{reviewAmount:800000000n});await c.send(c.core,'registerDecision',reduced.args,'executor');await c.send(c.core,'setIncidentFreeze',[d.incidentId,false,H('recovery pending')]);await sync();
  assert.equal((await metrics()).closure!.closed,0);assert.equal((await chain.incident(d.incidentId)).Q,400000000n);
  await c.send(c.core,'returnRecovery',[d.incidentId,400000000n,id()],'insured');await sync();assert.equal((await metrics()).closure!.closed,1);assert.equal((await metrics()).closure!.automaticClosed,0);
  const dispute=id();await c.send(c.core,'appendDispute',[d.incidentId,dispute,2n,H('appeal')],'insured');await sync();assert.equal((await metrics()).closure!.closed,0);
  await c.send(c.core,'grantRole',[H('CLAIM_APPROVER'),c.accounts.approver2.address]);
  await c.send(c.core,'reopenIncident',[dispute,H('independent reopen')],'approver2');
  const revised=await c.decision(f.q,[f.request.noticeId as any],d.incidentId,400000000n,{reviewAmount:800000000n},'assessor2','approver2');await c.send(c.core,'registerDecision',revised.args,'executor');await c.send(c.core,'setIncidentFreeze',[d.incidentId,false,H('revised complete')]);await sync();
  result=await metrics();assert.equal(result.closure!.closed,1);assert.equal(result.closure!.automaticClosed,0);assert.equal(result.channels![0]!.closed,1);assert.deepEqual(result.automaticClosureRate,{numerator:0,denominator:1});
  await c.connection.provider.request({method:'evm_revert',params:[branch]});assert.equal((await metrics()).state,'unavailable');await index.sync();assert.equal((await metrics()).closure!.closed,0);assert(f.store.all('SELECT * FROM claim_closures').length>=3,'orphaned and superseded records retained');assert.equal(f.store.get('SELECT count(*) n FROM claim_closures WHERE active=1').n,0);
  console.log('Closure evidence:',c.save('closures',{first,paidState}));
 }finally{f.close();await c.connection.close();}
});

