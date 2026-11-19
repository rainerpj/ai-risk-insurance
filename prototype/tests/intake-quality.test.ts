import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {seedIntake} from './seed-intake.ts';
import {id,H} from './chain-helper.ts';
import {Store,json} from '../packages/service/store.ts';
import {recordIntakeQuality,intakeQualityStatus,pendingIntakeQuality} from '../packages/service/intake-quality.ts';
import {createApp} from '../packages/service/api.ts';

test('independent intake review persists pre-decision anomalies with source and chain proofs, without inventing incident or template attribution',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),tenant=f.q.enterpriseId,actor={address:f.c.accounts.assessor2.address.toLowerCase(),role:'ASSESSOR',tenant};
 try{
  await seedIntake(f.store,chain,f.c.accounts.insured,f.request,800000000n);
  const input={id:id(),noticeId:f.request.noticeId,outcome:'missed_escalation',reason:'Synthetic independent review: required human escalation was not recorded'};
  await assert.rejects(recordIntakeQuality(f.store,chain,{...actor,role:'insured'},input),/ROLE_DENIED/);
  await assert.rejects(recordIntakeQuality(f.store,chain,{...actor,tenant:H('foreign')},input),/NOT_FOUND/);
  await assert.rejects(recordIntakeQuality(f.store,chain,{...actor,address:f.c.accounts.insured.address},input),/INDEPENDENT_REVIEW_REQUIRED/);
  // Local draft participants cannot review their own pending work, even before a decision exists.
  const draftId=id(),draft={noticeIds:[input.noticeId],assessment:{assessor:actor.address},d:{approver:f.c.accounts.approver.address}};
  f.store.run('INSERT INTO drafts VALUES(?,?,?,?)',draftId,tenant,json(draft),'{}');
  await assert.rejects(recordIntakeQuality(f.store,chain,actor,input),/INDEPENDENT_REVIEW_REQUIRED/);
  f.store.run('UPDATE drafts SET payload=? WHERE id=?',json({...draft,assessment:{assessor:f.c.accounts.assessor.address}}),draftId);
  const snap=await f.c.connection.provider.request({method:'evm_snapshot'});await f.c.connection.provider.request({method:'evm_mine'});
  await Promise.all([recordIntakeQuality(f.store,chain,actor,input),recordIntakeQuality(f.store,chain,actor,input)]);
  await assert.rejects(recordIntakeQuality(f.store,chain,actor,{...input,outcome:'no_issue_observed'}),/ID_CONFLICT/);
  let rows=await intakeQualityStatus(f.store,chain,tenant);assert.equal(rows.length,1);assert.equal(rows[0]!.proof_state,'canonical');assert.equal(rows[0]!.currentlyPending,true);
  const height=rows[0]!.payload.block;
  assert.equal((await pendingIntakeQuality(f.store,chain,tenant,[input.noticeId],String(BigInt(height)-1n))).reviewedNotices,0,'new head review is not yet confirmed');
  const coverage=await pendingIntakeQuality(f.store,chain,tenant,[input.noticeId,id()],height);assert.equal(coverage.reviewedNotices,1);assert.equal(coverage.unreviewedOrUnverifiable,1);assert.equal(coverage.outcomes.missed_escalation,1);assert.equal(coverage.rate,null);
  assert.equal(rows[0]!.payload.templateId,null);assert.equal(rows[0]!.payload.channel,null);assert.equal(rows[0]!.payload.disposition,'pending_independent_resolution');assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,0,'no guessed template pause or payout');
  const reopened=new Store(f.dir+'/executor.sqlite',f.scope);try{assert.equal((await intakeQualityStatus(reopened,chain,tenant)).length,1);assert.equal((await intakeQualityStatus(reopened,chain,H('foreign'))).length,0);}finally{reopened.close();}
  const app=createApp(f.store,chain);try{
   for(const [name,role,t] of [['assessor2','ASSESSOR',tenant],['insured','insured',tenant],['supervisor','SUPERVISOR',H('foreign')]] as const){
    const a=f.c.accounts[name];f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',a.address.toLowerCase(),t,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:a.address}})).json();
    const token=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await a.signMessage({message:ch.message})}})).json().token;
    const headers={authorization:'Bearer '+token};const read=await app.inject({url:'/api/quality/intake-reviews?tenant='+tenant,headers});assert.equal(read.statusCode,name==='insured'?403:200);if(name!=='insured')assert.equal(read.json().length,name==='assessor2'?1:0);
    assert.equal((await app.inject({method:'POST',url:'/api/quality/intake-reviews',headers,payload:input})).statusCode,name==='insured'?403:name==='supervisor'?404:200);
   }
  }finally{await app.close();}
  f.store.run('UPDATE drafts SET signatures=? WHERE id=?',json({supervisor:{supervisor:f.c.accounts.supervisor.address}}),draftId);
  assert.equal((await intakeQualityStatus(f.store,chain,tenant))[0]!.proof_state,'source_changed');
  await recordIntakeQuality(f.store,chain,actor,{...input,id:id(),reason:'Independent review of updated local inputs'});
  await f.enable();const assessment=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessment.a,assessment.signature);await f.c.send(f.c.core,'registerDecision',job.args,'executor');
  await assert.rejects(recordIntakeQuality(f.store,chain,actor,{...input,id:id()}),/USE_DECISION_QUALITY_REVIEW/);
  rows=await intakeQualityStatus(f.store,chain,tenant);assert.equal(rows[0]!.currentlyPending,false);assert.equal(rows[0]!.payload.disposition,'pending_independent_resolution','binding cannot silently resolve anomaly');
  await f.c.connection.provider.request({method:'evm_revert',params:[snap]});assert.equal((await intakeQualityStatus(f.store,chain,tenant))[0]!.proof_state,'recheck_required');
  const original=chain.read.bind(chain);chain.read=async(name,args=[],block)=>name==='hasRole'?false:original(name,args,block);await assert.rejects(recordIntakeQuality(f.store,chain,actor,input),/INDEPENDENT_REVIEW_REQUIRED/);chain.read=original;
  chain.check=async()=>{throw Error('offline');};assert.equal((await intakeQualityStatus(f.store,chain,tenant))[0]!.proof_state,'unavailable');await assert.rejects(recordIntakeQuality(f.store,chain,actor,{...input,id:id()}),/offline/);
 }finally{f.close();await f.c.connection.close();}
});
