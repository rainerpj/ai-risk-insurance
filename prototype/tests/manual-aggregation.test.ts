import test from 'node:test';
import assert from 'node:assert/strict';
import {custom} from 'viem';
import {autoFixture} from './m2b-fixture.ts';
import {seedIntake} from './seed-intake.ts';
import {id,U} from './chain-helper.ts';
import {json} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {createApp} from '../packages/service/api.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {manualTemplate} from '../packages/service/manual-template.ts';
import {qualityMetrics} from '../packages/service/metrics.ts';
import {workloadMetrics} from '../packages/service/workload.ts';
import {recordQuality,qualityCases,qualityReviews} from '../packages/service/quality.ts';

test('12 notices blocked from auto are independently merged manually, paid in installments and cannot obtain a second incident',async()=>{
 const f=await autoFixture({}, {gross:900n*U,compensation:0n}),{c}=f;
 const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),Object.fromEntries(Object.values(c.accounts).map(a=>[a.address.toLowerCase(),a])));
 const app=createApp(f.store,chain),worker=new Worker(f.store,chain),index=new Indexer(f.store,chain,0n),tokens:Record<string,string>={};
 const req=(url:string,actor:string,body:any)=>app.inject({method:'POST',url,headers:{authorization:'Bearer '+tokens[actor]},payload:JSON.parse(json(body))});
 const confirm=async()=>{await worker.tick();await c.connection.provider.request({method:'evm_mine'});await index.sync();};
 try{
  const noticeIds=[f.request.noticeId];
  for(let n=1;n<12;n++)noticeIds.push((await c.notice(f.q,{incidentCommitment:f.n.n.incidentCommitment})).n.noticeId);
  for(const noticeId of noticeIds)await seedIntake(f.store,chain,c.accounts.insured,{...f.request,noticeId},900n*U);
  await f.enable();const a=await f.reviewer.assess(f.request);
  await assert.rejects(f.authorizer.authorize(f.request,a.a,a.signature),/MANUAL_AGGREGATION_REQUIRED/);
  assert.equal(f.budget.all('SELECT * FROM reservations').length,0);
  for(const [actor,role] of [['assessor','ASSESSOR'],['approver','CLAIM_APPROVER']] as const){
   f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[actor].address.toLowerCase(),f.q.enterpriseId,role);
   const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts[actor].address}})).json();
   tokens[actor]=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await c.accounts[actor].signMessage({message:ch.message})}})).json().token;
  }
  const expense=(gross:bigint)=>({gross,duplicate:0n,compensation:0n,recovery:0n}),incidentId=id();
  const body={policyId:f.q.quoteId,incidentId,noticeIds,expenses:[expense(10800n*U),expense(0n)],reason:'独立核损逐项核验十二份费用',approver:c.accounts.approver.address};
  assert.equal((await req('/api/drafts','assessor',body)).statusCode,400);
  assert.equal((await req('/api/drafts','assessor',{...body,aggregation:{confirmed:true,reason:'same incident verified',claimedTotal:'900000000'}})).json().error,'CLAIM_TOTAL_BELOW_RECORDED');
  const metadata={templateId:f.g.templateId,aggregation:{confirmed:true,reason:'12份独立费用逐项核验同一事故，无重复费用',claimedTotal:'10800000000'}};
  assert.equal((await req('/api/drafts','assessor',{...body,...metadata,templateId:'not-a-template-id'})).statusCode,400);
  const created=await req('/api/drafts','assessor',{...body,...metadata});
  assert.equal(created.statusCode,200,created.body);const draft=created.json();assert.equal(draft.draft.d.reviewAmount,'10800000000');assert.equal(draft.draft.d.channel,'0');assert.match(draft.draft.reason,/归并核验/);
  assert.equal((await req(`/api/drafts/${draft.id}/submit`,'approver',{})).statusCode,400);
  assert.equal((await req(`/api/drafts/${draft.id}/sign`,'approver',{})).statusCode,200);
  assert.equal((await req(`/api/drafts/${draft.id}/submit`,'approver',{})).statusCode,200);await confirm();
  for(const noticeId of noticeIds)assert.equal((await c.read(c.core,'getNotice',[noticeId])).incidentId,incidentId);
  for(const amount of ['900000000','9900000000']){const p=await req('/api/manual/payment','approver',{incidentId,amount,reason:'归并后的累计决定分期付款'});assert.equal(p.statusCode,200,p.body);await confirm();}
  const final=await c.state(f.q,incidentId);assert.equal(final.incident.P,10800n*U);assert.equal(final.incident.D,0n);assert.equal(final.incident.decision.channel,0);
  assert.equal(manualTemplate(f.store,f.q.enterpriseId,final.incident.decision),f.g.templateId);
  assert.equal(manualTemplate(f.store,id(),final.incident.decision),null);
  const population=(await qualityMetrics(f.store,chain,f.q.enterpriseId)).population;
  assert.equal(population.groups[0]!.templateId,f.g.templateId);assert.equal(population.groups[0]!.templateAttribution,'signed-manual-reason');
  assert.equal((await workloadMetrics(f.store,chain,f.q.enterpriseId)).templates![0]!.templateId,f.g.templateId);
  const saved=f.store.get('SELECT payload FROM drafts WHERE id=?',draft.id).payload,tampered=JSON.parse(saved);
  const reason=JSON.parse(tampered.reason);reason.templateId=id();tampered.reason=json(reason);
  f.store.run('UPDATE drafts SET payload=? WHERE id=?',json(tampered),draft.id);
  assert.equal(manualTemplate(f.store,f.q.enterpriseId,final.incident.decision),null,'unsigned metadata mutation must not reattribute the confirmed decision');
  f.store.run('UPDATE drafts SET payload=? WHERE id=?',saved,draft.id);
  await recordQuality(f.store,chain,{address:c.accounts.assessor2.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},{id:id(),incidentId,decisionVersion:'1',outcome:'underpayment',reason:'synthetic independent classification audit'});
  assert.equal(qualityReviews(f.store,f.q.enterpriseId)[0].payload.templateId,f.g.templateId);
  assert.equal((await qualityCases(f.store,chain,f.q.enterpriseId))[0].payload.templateId,f.g.templateId);
  assert.equal((await qualityMetrics(f.store,chain,f.q.enterpriseId)).groups[0]!.templateId,f.g.templateId);
  await assert.rejects(f.reviewer.assess(f.request),/EXISTING_OR_MANUAL_INCIDENT/);
  const duplicate=await c.decision(f.q,[noticeIds[0]!],id(),900n*U);await c.rejects(c.core,'registerDecision',duplicate.args,'executor',/NoticeConflict/);
  assert.deepEqual(await c.state(f.q,incidentId),final);
  console.log('Manual aggregation evidence:',c.save('manual-aggregation',{status:'passed',noticeIds,draft: draft.draft,final}));
 }finally{await app.close();f.close();await c.connection.close();}
});
