import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {autoFixture} from './m2b-fixture.ts';
import {id} from './chain-helper.ts';
import {hash,json} from '../packages/service/store.ts';
import {intakeMessage} from '../packages/service/api.ts';
import {localIntakeGate} from '../packages/service/intake-gate.ts';
import {authorizerApp} from '../packages/service/automatic-api.ts';
import {seedIntake} from './seed-intake.ts';

test('configured intake gate verifies signed local amount and blocks unanchored split before a new payment signature',async()=>{
 const f=await autoFixture();try{
  const path=f.dir+'/executor.sqlite',scope=f.scope;
  f.authorizer.intakeGate=localIntakeGate(path,scope);await f.enable();
  const a=await f.reviewer.assess(f.request),authorize=()=>f.authorizer.authorize(f.request,a.a,a.signature);
  await assert.rejects(authorize(),/INTAKE_RECEIPT_REQUIRED/);
  const insert=async(noticeId:string,claimedAmount?:string)=>{
   const payload={noticeId,policyId:f.q.quoteId,incidentCommitment:f.n.n.incidentCommitment,evidenceHash:f.n.n.evidenceHash,declaredIncidentAt:f.q.startAt.toString(),summary:'synthetic independent intake',...(claimedAmount===undefined?{}:{claimedAmount})};
   const signature=await f.c.accounts.insured.signMessage({message:intakeMessage(scope,payload)});
   f.store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',noticeId,f.q.enterpriseId,f.q.insured.toLowerCase(),json({payload,signature}),hash(payload),new Date().toISOString(),'awaiting_binding');
  };
  await seedIntake(f.store,f.makeChain('executor'),f.c.accounts.insured,f.request,800000000n);
  const childInput=f.dir+'/intake-lock-public.json';
  writeFileSync(childInput,json({path,scope,request:f.request,quote:f.q,decision:{reviewAmount:'800000000'},commitment:f.n.n.incidentCommitment}));
  const child=spawn(process.execPath,['--import','tsx','tests/intake-lock-child.ts',childInput],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  const exited=new Promise<void>((resolve,reject)=>{child.once('exit',()=>resolve());child.once('error',reject);});
  try{
   await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('INTAKE_CHILD_READY_TIMEOUT')),15000);
    child.once('message',(m:any)=>{clearTimeout(timer);m.state==='locked'?resolve():reject(Error('INTAKE_CHILD_STATE'));});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('INTAKE_CHILD_EXIT_BEFORE_READY'));});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
   });
   f.store.db.exec('PRAGMA busy_timeout=0');
   assert.throws(()=>f.store.db.exec('BEGIN IMMEDIATE'),/locked/);
   assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
   assert.equal(child.kill('SIGKILL'),true);await exited;
   f.store.db.exec('BEGIN IMMEDIATE; ROLLBACK');
   assert.equal(f.store.get('SELECT count(*) n FROM notices').n,1);
   await localIntakeGate(path,scope)(f.request,f.q,{reviewAmount:'800000000'},f.n.n.incidentCommitment);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
  const api=authorizerApp(f.authorizer,{reviewer:'r'.repeat(40),executor:'e'.repeat(40)});
  f.store.db.exec('BEGIN IMMEDIATE');
  try{
   const r=await api.inject({method:'POST',url:'/authorize',headers:{authorization:'Bearer '+'r'.repeat(40)},payload:JSON.parse(json({request:f.request,a:a.a,signature:a.signature}))});
   assert.equal(r.statusCode,503);assert.equal(r.json().error,'INTAKE_BUSY_RETRY');assert.equal(r.headers['retry-after'],'1');
  }finally{f.store.db.exec('ROLLBACK');await api.close();}
  // A separate connection cannot accept a new notice while signing is in progress.
  f.store.db.exec('PRAGMA busy_timeout=0');
  const pending=id(),sign=f.authorizer.chain.sign.bind(f.authorizer.chain);let observedLock=false;
  f.authorizer.chain.sign=async()=>{
   await assert.rejects(insert(pending,'900000000'),/locked/);observedLock=true;
   assert.equal(f.store.get('SELECT id FROM notices WHERE id=?',pending),undefined);
   throw Error('injected signing failure while intake locked');
  };
  await assert.rejects(authorize(),/injected signing failure/);assert.equal(observedLock,true);
  // finally releases the source lock, but the obligation reservation survives the signer failure.
  f.store.db.exec('BEGIN IMMEDIATE; ROLLBACK');assert.equal(f.budget.all('SELECT * FROM reservations').length,1);
  f.authorizer.chain.sign=sign;
  const job=await authorize();await f.c.send(f.c.core,'registerDecision',job.args,'executor');
  await insert(pending,'900000000');
  const before=await f.c.state(f.q,job.args[0].incidentId);
  await assert.rejects(f.authorizer.payment(job.args[0].reservationId,'800000000',id()),/MANUAL_LOCAL_AGGREGATION_REQUIRED/);
  assert.deepEqual(await f.c.state(f.q,job.args[0].incidentId),before);assert.equal(f.budget.all('SELECT * FROM payments').length,0);
  const missing=f.dir+'/missing-intake.sqlite';
  await assert.rejects(localIntakeGate(missing,scope)(f.request,f.q,job.args[0],f.n.n.incidentCommitment));assert.equal(existsSync(missing),false);
  await assert.rejects(localIntakeGate(path,'wrong-scope')(f.request,f.q,job.args[0],f.n.n.incidentCommitment),/INTAKE_DEPLOYMENT_MISMATCH/);
  console.log('Local intake gate evidence:',f.c.save('intake-gate',{status:'passed',scope,final:before}));
 }finally{f.close();await f.c.connection.close();}
});
