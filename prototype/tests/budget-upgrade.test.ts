import test from 'node:test';
import assert from 'node:assert/strict';
import {sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {autoFixture,limits} from './m2b-fixture.ts';
import {U,id} from './chain-helper.ts';
import {H} from '../packages/service/reviewer.ts';
import {hash,json} from '../packages/service/store.ts';
import {Budget} from '../packages/service/budget.ts';
import {Authorizer} from '../packages/service/automatic.ts';

test('AC40 paid 600 plus due 300 survives new Grant/model/version/restart and lower 800 limit',async()=>{
 const f=await autoFixture({}, {gross:900n*U,compensation:0n,units:9n}),{c}=f;
 let reopened:Budget|undefined;
 try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0];
  await c.send(c.core,'registerDecision',job.args,'executor');
  const paid=await f.authorizer.payment(d.reservationId,'600000000',id());
  await c.send(c.core,'executePayment',paid.args,'executor');await c.connection.provider.request({method:'evm_mine'});
  // The chain accepted the payment but the authorizer has not observed its outcome.
  assert.equal(f.budget.get('SELECT state FROM payments WHERE id=?',paid.id).state,'reserved');
  const dims=JSON.parse(f.budget.get('SELECT dims FROM reservations').dims);
  const usage=(b:Budget,now:number)=>{for(const u of Object.values(b.usage(dims,now))){assert.equal(u.amount,900n*U);assert.equal(u.count,1);}};
  usage(f.budget,Number(await c.now()));
  await f.authorizer.reconcile();const stale=await f.authorizer.payment(d.reservationId,'300000000',id());
  // Reproduce an unobserved successful first installment during the governance migration.
  f.budget.reorg(paid.id);assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'900000000');
  const newGrant=id(),newModel=H('replacement-static-model');
  await f.enable(false,false);
  await c.send(f.registry,'configure',[f.request.grantId,{...f.g,budgetVersion:2n}]);
  await c.send(f.registry,'configure',[newGrant,{...f.g,budgetVersion:2n,modelVersion:newModel}]);
  await c.connection.provider.request({method:'evm_mine'});
  await f.authorizer.reconfigure(limits(1000n*U,5,'2'),[f.request.grantId,newGrant],0);
  assert.equal(f.budget.get('SELECT state FROM payments WHERE id=?',paid.id).state,'confirmed');
  assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'300000000');
  f.budget.mapModel(newModel,f.g.riskGroupId);
  reopened=new Budget(f.budgetPath,f.scope);
  const recovered=new Authorizer(f.authorizer.chain,f.authorizer.originals,reopened,f.g.authorizer);
  assert.equal(reopened.meta('ready'),'0');await recovered.reconcile();
  // Two installments consume two count slots, while monetary usage remains 900.
  for(const u of Object.values(reopened.usage(dims,Number(await c.now())))){assert.equal(u.amount,900n*U);assert.equal(u.count,2);}
  await f.enable();await c.rejects(c.core,'executePayment',stale.args,'executor',/GrantInactive/);
  const preserved=await c.state(f.q,d.incidentId);assert.equal(preserved.incident.P,600n*U);assert.equal(preserved.incident.D,300n*U);
  // Independently signed originals for a new 200 loss, under the replacement Grant/model.
  const commitment=id(),refs:string[]=[];
  for(const ref of f.request.refs){
   const body={...f.reviewer.originals.read(ref),commitment};
   if('units' in body)body.units='2';
   if('expenseId' in body)body.expenseId='cost-2';
   if('invoiceId' in body)body.invoiceId='invoice-2';
   if(body.kind==='payment'){body.paid='200000000';body.reference='bank-test-2';}
   const doc={source:body.kind,body,signature:sign(null,Buffer.from(hash(body)),f.sourceKeys[body.kind].privateKey).toString('base64')},next=hash(doc);
   writeFileSync(resolve(f.dir,next+'.json'),json(doc));refs.push(next);
  }
  f.trust.modelVersion=newModel;
  const n=await c.notice(f.q,{incidentCommitment:commitment,evidenceHash:H(refs)}),request={...f.request,grantId:newGrant,noticeId:n.n.noticeId,refs};
  const assessment=await f.reviewer.assess(request),signatures=reopened.all('SELECT * FROM signatures').length;
  await assert.rejects(recovered.authorize(request,assessment.a,assessment.signature),/ROLLING_BUDGET_EXCEEDED/);
  assert.equal(reopened.all('SELECT * FROM reservations').length,1);assert.equal(reopened.all('SELECT * FROM signatures').length,signatures);
  await f.enable(false,false);
  await c.send(f.registry,'configure',[f.request.grantId,{...f.g,budgetVersion:3n}]);
  await c.send(f.registry,'configure',[newGrant,{...f.g,budgetVersion:3n,modelVersion:newModel}]);
  await c.connection.provider.request({method:'evm_mine'});
  await recovered.reconfigure(limits(800n*U,5,'3'),[f.request.grantId,newGrant],0);await recovered.reconcile();await f.enable();
  const nextAssessment=await f.reviewer.assess(request);
  await assert.rejects(recovered.authorize(request,nextAssessment.a,nextAssessment.signature),/ROLLING_BUDGET_EXCEEDED/);
  assert.equal(reopened.get('SELECT remaining FROM reservations').remaining,'300000000');
  assert.deepEqual(await c.state(f.q,d.incidentId),preserved);
  console.log('Budget upgrade evidence:',c.save('budget-upgrade',{status:'passed',preserved,usage:reopened.usage(dims,Number(await c.now())),history:reopened.all('SELECT * FROM history')}));
 }finally{reopened?.close();f.close();await c.connection.close();}
});
