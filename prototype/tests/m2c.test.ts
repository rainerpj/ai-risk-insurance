import test from 'node:test';
import assert from 'node:assert/strict';
import {renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {semanticFixture} from './m2c-fixture.ts';
import {runAgent} from '../packages/service/agent.ts';
import {reviewSemantic} from '../packages/service/semantic-review.ts';
import {json} from '../packages/service/store.ts';
import {H} from '../packages/service/reviewer.ts';
import {id,U} from './chain-helper.ts';
import {reviewerApp,authorizerApp,executorApp} from '../packages/service/automatic-api.ts';
import {Worker,Indexer} from '../packages/service/indexer.ts';
test('L2 stub 5000 passes independent scope/cause/expense verification and separate budget authorization/payment',async()=>{
 const f=await semanticFixture(),{c}=f;
 const apps=[reviewerApp(f.reviewer,'r'.repeat(40)),authorizerApp(f.authorizer,{reviewer:'a'.repeat(40),executor:'p'.repeat(40)}),executorApp(f.store,f.makeChain('executor'),c.accounts.executor.address,f.g.authorizer,'e'.repeat(40))];
 try{
  const run=await runAgent({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>({inputTokens:20,outputTokens:50,output:json(f.proposal)})},f.tools,f.refs);assert.equal(run.proposal.route,'recommend');
  const assessment=(await apps[0]!.inject({method:'POST',url:'/review-semantic',headers:{authorization:'Bearer '+'r'.repeat(40)},payload:{request:f.request,proposal:run.proposal}})).json();assert(assessment.signature);
  await assert.rejects(f.authorizer.authorize(f.request,assessment.a,assessment.signature,run.proposal),/ChannelPaused/);assert.equal(f.budget.get('SELECT count(*) n FROM reservations').n,0);
  await c.send(f.registry,'setChannel',[1,true,true,H('enable L1 only')]);
  await assert.rejects(f.authorizer.authorize(f.request,assessment.a,assessment.signature,run.proposal),/ChannelPaused/);
  assert.equal(f.budget.get('SELECT count(*) n FROM reservations').n,0);
  assert.equal(f.budget.get('SELECT count(*) n FROM signatures').n,0);
  await f.enable();
  const authorized=await apps[1]!.inject({method:'POST',url:'/authorize',headers:{authorization:'Bearer '+'a'.repeat(40)},payload:{request:f.request,a:assessment.a,signature:assessment.signature,proposal:run.proposal}});assert.equal(authorized.statusCode,200,authorized.body);const job=authorized.json();
  assert.equal(job.args[0].netApproved,'5000000000');assert.equal(job.args[0].channel,'2');assert.equal(f.budget.get('SELECT count(*) n FROM expenses').n,6);
  const secondCommitment=id(),mapping=new Map<string,string>();
  for(const ref of f.refs){const body={...f.originals.read(ref),commitment:secondCommitment};for(const key of ['expenseId','invoiceId'])if(body[key]==='emergency')body[key]='emergency-second';if(body.reference==='bank-emergency')body.reference='bank-emergency-second';mapping.set(ref,f.put(body.kind,body));}
  const secondRefs=f.refs.map(r=>mapping.get(r)!),secondNotice=await c.notice(f.q,{incidentCommitment:secondCommitment,evidenceHash:H(secondRefs)}),secondRequest={...f.request,noticeId:secondNotice.n.noticeId,refs:secondRefs},secondProposal=structuredClone(f.proposal);
  for(const item of secondProposal.items){for(const key of ['ticketRef','workRef','completionRef','paymentRef'] as const)item[key]=mapping.get(item[key])!;if(item.expenseId==='emergency')item.expenseId='emergency-second';}
  const secondAssessment=await f.reviewer.assess(secondRequest,secondProposal);
  await assert.rejects(f.authorizer.authorize(secondRequest,secondAssessment.a,secondAssessment.signature,secondProposal),/EXPENSE_ALREADY_USED/);
  assert.equal(f.budget.get('SELECT count(*) n FROM expenses').n,6);assert.equal(f.budget.get('SELECT count(*) n FROM reservations').n,1);
  const queued=await apps[2]!.inject({method:'POST',url:'/enqueue',headers:{authorization:'Bearer '+'e'.repeat(40)},payload:job});assert.equal(queued.statusCode,200,queued.body);
  const worker=new Worker(f.store,f.makeChain('executor')),index=new Indexer(f.store,f.makeChain('executor'),0n);await worker.tick();await c.connection.provider.request({method:'evm_mine'});await index.sync();
  const pay=await f.authorizer.payment(job.args[0].reservationId,'5000000000',id());const payment=await apps[2]!.inject({method:'POST',url:'/enqueue',headers:{authorization:'Bearer '+'e'.repeat(40)},payload:JSON.parse(json(pay))});assert.equal(payment.statusCode,200,payment.body);
  await worker.tick();await c.connection.provider.request({method:'evm_mine'});await index.sync();await f.authorizer.reconcile();
  const i=await c.read(c.core,'getIncident',[job.args[0].incidentId]);assert.equal(i.P,5000n*U);assert.equal(i.D,0n);assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'0');
  console.log('L2 stub evidence:',c.save('m2c-stub',{run,job,incident:i,reservations:f.budget.all('SELECT id,remaining,state FROM reservations'),verification:'stub only; no real-model semantic acceptance'}));
 }finally{for(const app of apps)await app.close();f.close();await c.connection.close();}
});
test('semantic evidence below 1000 can use L2; 10000 inclusive and one micro-unit over routes manual',async()=>{
 for(const [prices,expected] of [[{recovery:'100000000',emergency:'100000000'},500000000n],[{recovery:'2000000000',emergency:'2000000000'},10000000000n],[{recovery:'2000000000',emergency:'2000000001'},null]] as const){
  const f=await semanticFixture(prices);try{const grant=await f.reviewer.grant(f.request.grantId),verify=()=>reviewSemantic(f.makeChain('executor'),f.originals,f.request,grant,f.proposal);
   await assert.rejects(reviewSemantic(f.makeChain('executor'),f.originals,f.request,grant,undefined as any),/SEMANTIC_PROPOSAL_REQUIRED/);
   const ticket=resolve(f.dir,f.proposal.items[0]!.ticketRef+'.json'),missing=ticket+'.absent';
   renameSync(ticket,missing);
   try{await assert.rejects(f.reviewer.assess(f.request,f.proposal),/ENOENT/);}
   finally{renameSync(missing,ticket);}
   assert.equal(f.budget.all('SELECT * FROM reservations').length,0);
   assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
   if(expected===null){
    await assert.rejects(verify(),/MANUAL_REQUIRED/);
    await assert.rejects(f.reviewer.assess(f.request,f.proposal),/MANUAL_REQUIRED/);
   }else{
    const r=await verify();assert.equal(r.d.netApproved,expected);assert.equal(r.d.channel,2n);
    await f.enable();const a=await f.reviewer.assess(f.request,f.proposal);
    const job=await f.authorizer.authorize(f.request,a.a,a.signature,f.proposal);
    await f.c.send(f.c.core,'registerDecision',job.args,'executor');
    const pay=await f.authorizer.payment(job.args[0].reservationId,expected.toString(),id());
    await f.c.send(f.c.core,'executePayment',pay.args,'executor');
    const incident=await f.c.read(f.c.core,'getIncident',[job.args[0].incidentId]);
    assert.equal(incident.P,expected);assert.equal(incident.D,0n);
   }
   console.log('L2 boundary evidence:',f.c.save('l2-boundary',{expected,status:'passed',verification:'synthetic proposal; no real-model acceptance'}));
  }finally{f.close();await f.c.connection.close();}
 }
});
test('L2 independent verifier rejects other deployment, absent causality, payment mismatch and amount/routing changes',async()=>{
 const f=await semanticFixture();
 try{
  const grant=await f.reviewer.grant(f.request.grantId);
  for(const [kind,changes,error] of [['release',{runtimeDeployment:'wrong-rollout'},/EVIDENCE_SCOPE/],['replay',{oldPass:false},/CAUSALITY/],['payment',{paid:'3000000000'},/PAYMENT_MISMATCH/],['payment',{compensation:null},/INVALID_AMOUNT/],['work',{action:'not-approved'},/EXTRACTION|RUNBOOK/]] as const){
   const original=f.refs.find(r=>f.originals.read(r).kind===kind)!,ref=f.put(kind,{...f.originals.read(original),...changes}),refs=f.refs.map(r=>r===original?ref:r),n=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),proposal=structuredClone(f.proposal);
   for(const item of proposal.items)for(const field of ['ticketRef','workRef','completionRef','paymentRef'] as const)if(item[field]===original)item[field]=ref;
   await assert.rejects(reviewSemantic(f.makeChain('executor'),f.originals,{...f.request,noticeId:n.n.noticeId,refs},grant,proposal),error);
  }
  await assert.rejects(reviewSemantic(f.makeChain('executor'),f.originals,{...f.request,refs:[...f.refs].reverse()},grant,f.proposal),/NOTICE_EVIDENCE_BINDING/);
  const altered=structuredClone(f.proposal);altered.items[0]!.units='99';await assert.rejects(reviewSemantic(f.makeChain('executor'),f.originals,f.request,grant,altered),/EXTRACTION|TICKET_TEXT_CONFLICT/);
 }finally{f.close();await f.c.connection.close();}
});

test('AC46 manual disputed case cannot return to L2 through a fresh or previously valid proposal',async()=>{
 const f=await semanticFixture(),{c}=f;
 try{
  await f.enable();const prior=await f.reviewer.assess(f.request,f.proposal);
  const manual=await c.decision(f.q,[f.request.noticeId],id(),5000n*U);await c.send(c.core,'registerDecision',manual.args,'executor');
  const evidence:any[]=[];
  for(const disputed of [false,true]){
   if(disputed)await c.send(c.core,'appendDispute',[manual.d.incidentId,id(),1n,H('unresolved manual dispute')],'insured');
   const before=await c.state(f.q,manual.d.incidentId);
   await assert.rejects(f.reviewer.assess(f.request,f.proposal),/EXISTING_OR_MANUAL_INCIDENT/);
   await assert.rejects(f.authorizer.authorize(f.request,prior.a,prior.signature,f.proposal),/EXISTING_OR_MANUAL_INCIDENT/);
   assert.deepEqual(await c.state(f.q,manual.d.incidentId),before);
   assert.equal(f.budget.all('SELECT * FROM reservations').length,0);assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
   evidence.push({disputed,before});
  }
  console.log('Manual L2 routing evidence:',c.save('manual-l2-routing',{status:'passed',evidence,verification:'synthetic proposal; no real-model acceptance'}));
 }finally{f.close();await c.connection.close();}
});
