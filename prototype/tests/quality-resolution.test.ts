import {createApp} from '../packages/service/api.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H,U} from './chain-helper.ts';
import {recordQuality,qualityCases} from '../packages/service/quality.ts';
import {resolveQuality,resolutionCases} from '../packages/service/quality-resolution.ts';
import {Store} from '../packages/service/store.ts';
import type {Hex} from 'viem';

test('resolution requires independent current review and supervisor; persists but never changes funds or permission, then invalidates on ledger changes',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),{c}=f;
 try{
  const d=await c.decision(f.q,[f.request.noticeId as Hex],id(),800n*U);await c.send(c.core,'registerDecision',d.args,'executor');
  const actor={address:c.accounts.assessor2.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},supervisor={...actor,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'};
  const input={id:id(),incidentId:d.d.incidentId,decisionVersion:'1',outcome:'underpayment',reason:'synthetic anomaly'};await recordQuality(f.store,chain,actor,input);
  const pending=await qualityCases(f.store,chain,actor.tenant),request={id:id(),caseId:pending[0].id,reviewId:input.id,type:'false_alarm',reason:'independent supervisor confirms supported followup'};
  await assert.rejects(resolveQuality(f.store,chain,actor,request),/SUPERVISOR_REQUIRED/);
  await assert.rejects(resolveQuality(f.store,chain,supervisor,request),/CURRENT_REVIEW/);
  const review={...input,id:id(),outcome:'correct',reason:'independent review determines no error in decision'};await recordQuality(f.store,chain,actor,review);request.reviewId=review.id;
  await assert.rejects(resolveQuality(f.store,chain,{...supervisor,address:actor.address},request),/SUPERVISOR|CURRENT_REVIEW/);
  await assert.rejects(resolveQuality(f.store,chain,supervisor,{...request,type:'corrected'}),/CORRECTION_NOT_COMPLETED/);
  const before=await chain.incident(d.d.incidentId),snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  const resolved=await resolveQuality(f.store,chain,supervisor,request);assert.deepEqual(await resolveQuality(f.store,chain,supervisor,request),resolved);
  await assert.rejects(resolveQuality(f.store,chain,supervisor,{...request,reason:'changed'}),/CONFLICT/);
  assert.deepEqual(await chain.incident(d.d.incidentId),before);assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,0);
  const status=()=>resolutionCases(f.store,chain,actor.tenant,qualityCasesPlaceholder);
  const qualityCasesPlaceholder=await qualityCases(f.store,chain,actor.tenant);assert.equal((await status())[0].state,'resolved');
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{assert.equal((await resolutionCases(reopened,chain,actor.tenant,await qualityCases(reopened,chain,actor.tenant)))[0].state,'resolved');}finally{reopened.close();}
  const payment=await c.payment(f.q,d.d.incidentId,100n*U);await c.send(c.core,'executePayment',[payment.p,payment.sig],'executor');assert.equal((await status())[0].state,'recheck_required');
  await c.connection.provider.request({method:'evm_revert',params:[snapshot]});assert.equal((await status())[0].state,'resolved');
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,true,H('later freeze')]);assert.equal((await status())[0].state,'recheck_required','freeze invalidates resolution even when ledger hash is unchanged');
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,false,H('freeze lifted')]);assert.equal((await status())[0].state,'resolved');
  await recordQuality(f.store,chain,actor,{...review,id:id(),outcome:'underpayment',reason:'new conflicting review requires recheck'});assert.equal((await status())[0].state,'recheck_required');
  await assert.rejects(resolveQuality(f.store,chain,supervisor,{...request,id:id()}),/REVIEW_SUPERSEDED/);
  console.log('Quality resolution evidence:',c.save('quality-resolution',{resolved,before,request}));
 }finally{f.close();await c.connection.close();}
});

test('corrected resolution requires revised decision and completed funds; authenticated endpoint and orphaned resolution fail closed',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),{c}=f;
 const reviewer={address:c.accounts.assessor2.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},supervisor={...reviewer,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'};
 try{
  const first=await c.decision(f.q,[f.request.noticeId as Hex],id(),800n*U);await c.send(c.core,'registerDecision',first.args,'executor');
  await recordQuality(f.store,chain,reviewer,{id:id(),incidentId:first.d.incidentId,decisionVersion:'1',outcome:'underpayment',reason:'synthetic underpayment'});
  const caseId=(await qualityCases(f.store,chain,reviewer.tenant))[0].id;
  const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  await c.send(c.core,'setIncidentFreeze',[first.d.incidentId,true,H('correct')]);
  const revised=await c.decision(f.q,[f.request.noticeId as Hex],first.d.incidentId,900n*U);await c.send(c.core,'registerDecision',revised.args,'executor');
  await c.send(c.core,'setIncidentFreeze',[first.d.incidentId,false,H('reviewed')]);
  const reviewId=id();await recordQuality(f.store,chain,reviewer,{id:reviewId,incidentId:first.d.incidentId,decisionVersion:'2',outcome:'correct',reason:'independently verified corrected amount'});
  const request={id:id(),caseId,reviewId,type:'corrected',reason:'correction and payment verified by independent supervisor'};
  await assert.rejects(resolveQuality(f.store,chain,supervisor,request),/CORRECTION_NOT_COMPLETED/);
  const payment=await c.payment(f.q,first.d.incidentId,900n*U);await c.send(c.core,'executePayment',[payment.p,payment.sig],'executor');
  const app=createApp(f.store,chain);try{
   for(const [who,role] of [['assessor2','ASSESSOR'],['supervisor','SUPERVISOR']] as const){
    f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[who].address.toLowerCase(),reviewer.tenant,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts[who].address}})).json();
    const token=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await c.accounts[who].signMessage({message:ch.message})}})).json().token;
    const response=await app.inject({method:'POST',url:'/api/quality/resolutions',headers:{authorization:'Bearer '+token},payload:request});assert.equal(response.statusCode,who==='supervisor'?200:403,response.body);
   }
  }finally{await app.close();}
  assert.equal((await resolutionCases(f.store,chain,reviewer.tenant,await qualityCases(f.store,chain,reviewer.tenant)))[0].state,'resolved');
  await c.connection.provider.request({method:'evm_revert',params:[snapshot]});
  assert.equal((await resolutionCases(f.store,chain,reviewer.tenant,await qualityCases(f.store,chain,reviewer.tenant)))[0].state,'unavailable');
  assert.equal(f.store.get('SELECT count(*) n FROM quality_resolutions').n,1,'orphaned resolution retained for audit');
 }finally{f.close();await c.connection.close();}
});
