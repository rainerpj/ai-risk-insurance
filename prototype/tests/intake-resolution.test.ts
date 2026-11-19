import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {seedIntake} from './seed-intake.ts';
import {id,H,U} from './chain-helper.ts';
import {Store} from '../packages/service/store.ts';
import {recordIntakeQuality,resolveIntakeQuality,intakeQualityStatus,pendingIntakeQuality} from '../packages/service/intake-quality.ts';
import {recordQuality} from '../packages/service/quality.ts';
import {createApp} from '../packages/service/api.ts';

test('intake false alarm needs a different reviewer and independent supervisor; later evidence invalidates resolution without deleting history',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),tenant=f.q.enterpriseId;
 const reporter={address:f.c.accounts.assessor.address.toLowerCase(),role:'ASSESSOR',tenant},reviewer={...reporter,address:f.c.accounts.assessor2.address.toLowerCase()},supervisor={...reporter,address:f.c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'};
 try{
  await seedIntake(f.store,chain,f.c.accounts.insured,f.request,800n*U);
  const trigger={id:id(),noticeId:f.request.noticeId,outcome:'missed_escalation',reason:'synthetic intake anomaly'};await recordIntakeQuality(f.store,chain,reporter,trigger);
  const follow={...trigger,id:id(),outcome:'no_issue_observed',reason:'independent followup of same inputs'};await recordIntakeQuality(f.store,chain,reporter,follow);
  const request={id:id(),triggerId:trigger.id,reviewId:follow.id,type:'false_alarm',reason:'independent supervisor confirms false alarm'};
  await assert.rejects(resolveIntakeQuality(f.store,chain,reviewer,request),/SUPERVISOR_REQUIRED/);
  await assert.rejects(resolveIntakeQuality(f.store,chain,supervisor,request),/INDEPENDENT_CURRENT_REVIEW_REQUIRED/);
  await recordIntakeQuality(f.store,chain,reviewer,{...follow,id:request.reviewId=id()});
  await assert.rejects(resolveIntakeQuality(f.store,chain,{...supervisor,address:reviewer.address},request),/INDEPENDENT/);
  await assert.rejects(resolveIntakeQuality(f.store,chain,{...supervisor,tenant:H('other')},request),/NOT_FOUND/);
  await Promise.all([resolveIntakeQuality(f.store,chain,supervisor,request),resolveIntakeQuality(f.store,chain,supervisor,request)]);
  const status=async()=>(await intakeQualityStatus(f.store,chain,tenant)).find(r=>r.id===trigger.id)!;
  assert.equal((await status()).resolution.state,'current');assert.equal(f.store.get('SELECT count(*) n FROM intake_resolutions').n,1);assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,0);
  assert.equal((await pendingIntakeQuality(f.store,chain,tenant,[trigger.noticeId],String((await chain.client.getBlock()).number))).unresolvedFindings,0);
  await assert.rejects(resolveIntakeQuality(f.store,chain,supervisor,{...request,reason:'changed'}),/ID_CONFLICT/);
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{assert.equal((await intakeQualityStatus(reopened,chain,tenant)).find(r=>r.id===trigger.id)!.resolution.state,'current');}finally{reopened.close();}
  await recordIntakeQuality(f.store,chain,reviewer,{...follow,id:id(),outcome:'unverifiable'});
  assert.equal((await status()).resolution.state,'recheck_required');await assert.rejects(resolveIntakeQuality(f.store,chain,supervisor,{...request,id:id()}),/REVIEW_SUPERSEDED/);
  f.store.run('UPDATE notices SET payload_hash=? WHERE id=?','changed-input',trigger.noticeId);assert.equal((await status()).resolution.state,'recheck_required');
  chain.check=async()=>{throw Error('offline');};assert.equal((await status()).proof_state,'unavailable');
 }finally{f.close();await f.c.connection.close();}
});

test('intake correction requires later manual settled decision and independent review; HTTP isolation and orphan recovery retain evidence',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),tenant=f.q.enterpriseId,{c}=f;
 const reporter={address:c.accounts.assessor.address.toLowerCase(),tenant,role:'ASSESSOR'},reviewer={...reporter,address:c.accounts.assessor2.address.toLowerCase()},supervisor={...reporter,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'};
 try{
  await seedIntake(f.store,chain,c.accounts.insured,f.request,800n*U);
  const trigger={id:id(),noticeId:f.request.noticeId,outcome:'unpaid_obligation',reason:'synthetic unpaid obligation'};await recordIntakeQuality(f.store,chain,reporter,trigger);
  const request={id:id(),triggerId:trigger.id,reviewId:id(),type:'corrected',reason:'manual remedy independently confirmed'};
  await assert.rejects(resolveIntakeQuality(f.store,chain,supervisor,request),/CORRECTION_NOT_COMPLETED/);
  const snap=await c.connection.provider.request({method:'evm_snapshot'});
  const d=await c.decision(f.q,[f.request.noticeId],id(),800n*U);await c.send(c.core,'registerDecision',d.args,'executor');
  await recordQuality(f.store,chain,reviewer,{id:request.reviewId,incidentId:d.d.incidentId,decisionVersion:'1',outcome:'correct',reason:'independent manual correction review'});
  await assert.rejects(resolveIntakeQuality(f.store,chain,supervisor,request),/CORRECTION_NOT_COMPLETED/);
  const payment=await c.payment(f.q,d.d.incidentId,800n*U);await c.send(c.core,'executePayment',[payment.p,payment.sig],'executor');
  const before=await chain.incident(d.d.incidentId),app=createApp(f.store,chain);
  try{for(const [name,role] of [['assessor2','ASSESSOR'],['supervisor','SUPERVISOR']] as const){
   const a=c.accounts[name];f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',a.address.toLowerCase(),tenant,role);
   const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:a.address}})).json(),token=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await a.signMessage({message:ch.message})}})).json().token;
   const result=await app.inject({method:'POST',url:'/api/quality/intake-resolutions',headers:{authorization:'Bearer '+token},payload:request});assert.equal(result.statusCode,name==='supervisor'?200:403,result.body);
  }}finally{await app.close();}
  assert.deepEqual(await chain.incident(d.d.incidentId),before);
  assert.equal((await intakeQualityStatus(f.store,chain,tenant))[0]!.resolution.state,'current');
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,true,H('later concern')]);assert.equal((await intakeQualityStatus(f.store,chain,tenant))[0]!.resolution.state,'recheck_required');
  await c.connection.provider.request({method:'evm_revert',params:[snap]});assert.notEqual((await intakeQualityStatus(f.store,chain,tenant))[0]!.resolution?.state,'current');assert.equal(f.store.get('SELECT count(*) n FROM intake_resolutions').n,1);
 }finally{f.close();await c.connection.close();}
});
