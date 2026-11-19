import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture,limits} from './m2b-fixture.ts';
import {id,U} from './chain-helper.ts';
import {executorApp} from '../packages/service/automatic-api.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {json,Store} from '../packages/service/store.ts';
import {Budget} from '../packages/service/budget.ts';
import {Authorizer} from '../packages/service/automatic.ts';

test('AC43 unknown payment crosses rolling window, restarts, settles same ID and recovers after reorg',async()=>{
 const f=await autoFixture(),{c}=f;let reopened:Store|undefined,budget:Budget|undefined;
 const executor=f.makeChain('executor'),api=executorApp(f.store,executor,c.accounts.executor.address,f.g.authorizer,'e'.repeat(40));
 try{
  f.budget.pause();f.budget.configure(limits(1000n*U,5,'2',10),Number(await c.now()),0);
  await c.send(f.registry,'configure',[f.request.grantId,{...f.g,budgetVersion:2n}]);await f.authorizer.reconcile();await f.enable();
  const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0];await c.send(c.core,'registerDecision',job.args,'executor');
  const first=await f.authorizer.payment(d.reservationId,'200000000',id());await c.send(c.core,'executePayment',first.args,'executor');await c.connection.provider.request({method:'evm_mine'});await f.authorizer.reconcile();
  const requestId=id(),pending=await f.authorizer.payment(d.reservationId,'600000000',requestId),queued=await api.inject({method:'POST',url:'/enqueue',headers:{authorization:'Bearer '+'e'.repeat(40)},payload:JSON.parse(json(pending))});assert.equal(queued.statusCode,200,queued.body);
  const worker=new Worker(f.store,executor),send=executor.client.sendRawTransaction;
  executor.client.sendRawTransaction=async()=>{throw new Error('injected RPC timeout before acceptance');};
  try{await worker.tick();}finally{executor.client.sendRawTransaction=send;}
  const original=f.store.get('SELECT * FROM outbox WHERE id=?',pending.id);assert.equal(original.state,'unknown');assert(original.raw&&original.tx_hash);
  await c.connection.provider.request({method:'evm_increaseTime',params:[20]});await c.connection.provider.request({method:'evm_mine'});
  reopened=new Store(f.dir+'/executor.sqlite',f.scope);budget=new Budget(f.budgetPath,f.scope);
  const recovered=new Authorizer(f.authorizer.chain,f.authorizer.originals,budget,f.g.authorizer),index=new Indexer(reopened,executor,0n);
  await index.sync();await recovered.reconcile();const dims=JSON.parse(budget.get('SELECT dims FROM reservations').dims);
  for(const u of Object.values(budget.usage(dims,Number(await c.now())))){assert.equal(u.amount,600n*U);assert.equal(u.count,1);}
  assert.equal(reopened.get('SELECT state FROM outbox WHERE id=?',pending.id).state,'unknown');
  assert.deepEqual(await recovered.payment(d.reservationId,'600000000',requestId),pending);
  await assert.rejects(recovered.payment(d.reservationId,'600000000',id()),/PAYMENT_UNRESOLVED/);
  assert.equal(budget.all('SELECT * FROM payments').length,2);assert.equal((await c.state(f.q,d.incidentId)).incident.D,600n*U);
  const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  await new Worker(reopened,executor).tick();await c.connection.provider.request({method:'evm_mine'});await index.sync();await recovered.reconcile();
  const confirmed=reopened.get('SELECT * FROM outbox WHERE id=?',pending.id);
  assert.equal(confirmed.state,'confirmed');assert.equal(confirmed.raw,original.raw);assert.equal(confirmed.tx_hash,original.tx_hash);
  assert.equal(budget.get('SELECT remaining FROM reservations').remaining,'0');assert.equal((await c.state(f.q,d.incidentId)).incident.P,800n*U);
  await c.connection.provider.request({method:'evm_revert',params:[snapshot]});await c.connection.provider.request({method:'evm_mine'});await index.sync();await recovered.reconcile();
  assert.equal(reopened.get('SELECT state FROM outbox WHERE id=?',pending.id).state,'reorg_pending');
  assert.equal(budget.get('SELECT state FROM payments WHERE id=?',pending.id).state,'reorg_pending');assert.equal(budget.get('SELECT remaining FROM reservations').remaining,'600000000');
  await recovered.reconcile();assert.equal(budget.get('SELECT remaining FROM reservations').remaining,'600000000');
  await new Worker(reopened,executor).tick();await c.connection.provider.request({method:'evm_mine'});await index.sync();await recovered.reconcile();
  assert.equal(reopened.get('SELECT state FROM outbox WHERE id=?',pending.id).state,'confirmed');
  assert.equal(reopened.get('SELECT raw FROM outbox WHERE id=?',pending.id).raw,original.raw);assert.equal(budget.get('SELECT remaining FROM reservations').remaining,'0');
  await c.rejects(c.core,'executePayment',pending.args,'governor',/PaymentAlreadyExecuted/);
  const final=await c.state(f.q,d.incidentId);assert.equal(final.incident.P,800n*U);assert.equal(final.incident.D,0n);assert.equal(final.incident.installmentIndex,2n);
  console.log('Cross-window payment evidence:',c.save('payment-window',{status:'passed',paymentId:pending.id,transactionHash:original.tx_hash,final,history:budget.all('SELECT * FROM history')}));
 }finally{await api.close();reopened?.close();budget?.close();f.close();await c.connection.close();}
});
