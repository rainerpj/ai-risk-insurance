import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {Budget,type Dimensions} from '../packages/service/budget.ts';
import {limits} from './m2b-fixture.ts';
const d:Dimensions={deploymentId:'deployment',insurerId:'insurer',token:'USDC',enterpriseId:'enterprise',fdeId:'fde',riskGroupId:'shared-risk'};
function fixture(amount=1000n,count=5){mkdirSync('.local',{recursive:true});const path=`.local/budget-${randomUUID()}.sqlite`,b=new Budget(path,'scope',true);b.configure(limits(amount,count,'1',100),1000,0);b.mapModel('model-a','shared-risk');b.ready(1000);return {b,path};}
test('rolling budget all four dimensions, separate tokens and model/version changes do not reset buckets',()=>{
 const {b}=fixture();try{b.reserve('one','one','one',d,800n,{},1000);
 for(const changed of [{enterpriseId:'other'},{fdeId:'other'},{riskGroupId:'other'},{enterpriseId:'other',fdeId:'other',riskGroupId:'other'}])assert.throws(()=>b.reserve('two','two','two',{...d,...changed},300n,{},1000),/EXCEEDED/);
 b.reserve('two','two','two',{...d,token:'USDT'},800n,{},1000);b.pause();b.mapModel('model-b','shared-risk');b.configure(limits(900n,5,'2',200),1000,0);b.ready(1000);
 assert.equal(b.usage(d,1000).riskGroup!.amount,800n);assert.equal(b.group('model-b'),d.riskGroupId);assert.throws(()=>b.reserve('three','three','three',d,101n,{},1000),/EXCEEDED/);
 }finally{b.close();}
});
test('each dimension independently constrains amount and payment count even when the other three have headroom',()=>{
 for(const dimension of ['enterprise','fde','riskGroup','GLOBAL'] as const){
   const {b}=fixture(10000n,100);try{b.pause();const config=limits(10000n,100,'2',100);config[dimension]={...config[dimension],amount:'1000',count:1};b.configure(config,1000,0);b.ready(1000);
     b.reserve('first','first','first',d,600n,{},1000);assert.throws(()=>b.reserve('large','large','large',d,401n,{},1000),/EXCEEDED/);b.reserve('second','second','second',d,400n,{},1000);b.payment('p1','first',100n,{},1000);assert.throws(()=>b.payment('p2','second',100n,{},1000),/EXCEEDED/);
     assert.equal(b.all('SELECT * FROM payments').length,1);assert.equal(b.usage(d,1000)[dimension]!.count,1);
   }finally{b.close();}
 }
});
test('600 paid + 300 outstanding costs 900, installments do not double amount, unknown survives windows',()=>{
 const {b}=fixture();try{
 b.reserve('r','d','i',d,900n,{},1000);b.payment('p','r',600n,{},1000);assert.equal(b.usage(d,1000).GLOBAL!.amount,900n);assert.equal(b.usage(d,1000).GLOBAL!.count,1);
 b.confirmed('p','block',1001);b.confirmed('p','block',1001);assert.equal(b.usage(d,1002).GLOBAL!.amount,900n);b.payment('next','r',300n,{},1002);
 assert.equal(b.usage(d,1101).GLOBAL!.amount,300n);assert.equal(b.usage(d,1101).GLOBAL!.count,1);assert.equal(b.usage(d,9999).GLOBAL!.amount,300n);
 assert.throws(()=>b.release('r'),/UNRESOLVED/);assert.throws(()=>b.migrateDecision('r','new',{}),/UNRESOLVED/);
 b.reorg('p');b.reorg('p');assert.equal(b.usage(d,9999).GLOBAL!.amount,900n);assert.equal(b.usage(d,9999).GLOBAL!.count,2);
 }finally{b.close();}
});
test('configuration history, lower limits, retained debt, risk migration and clock anomaly fail closed',()=>{
 const {b}=fixture();try{b.reserve('r','d','i',d,800n,{},1000);assert.throws(()=>b.configure(limits(),'1000' as any,0),/PAUSE/);
 b.pause();assert.throws(()=>b.configure(limits(1000n,5,'2',2000),1000,0),/HISTORY/);b.configure(limits(500n,5,'2',200),1000,0);b.migrateGroup('shared-risk','merged-risk');b.ready(1000);
 assert.equal(b.usage({...d,riskGroupId:'merged-risk'},1000).riskGroup!.amount,800n);assert.throws(()=>b.payment('p','r',100n,{},1000),/EXCEEDED/);assert.equal(b.get('SELECT remaining FROM reservations').remaining,'800');
 assert.throws(()=>b.reserve('x','x','x',d,1n,{},999),/CLOCK/);assert.equal(b.meta('ready'),'0');assert.throws(()=>b.reserve('x','x','x',d,1n,{},1000),/RECONCILIATION/);
 }finally{b.close();}
});
test('immutable IDs, expense deduplication, count cap and decision migration are atomic',()=>{
 const {b}=fixture(1000n,1);try{
 b.reserve('r','d','i',d,400n,{a:1},1000,'expense');assert.throws(()=>b.reserve('r','d','i',d,401n,{a:1},1000),/CONFLICT/);assert.throws(()=>b.reserve('r2','d2','i2',d,400n,{},1000,'expense'),/ALREADY_USED/);
 b.migrateDecision('r','new',{new:true});assert.equal(b.usage(d,1000).GLOBAL!.amount,400n);b.payment('p','r',200n,{},1000);b.confirmed('p','h',1000);assert.throws(()=>b.payment('p2','r',200n,{},1000),/EXCEEDED/);b.signature('fixed',{a:1},'signature');assert.throws(()=>b.signature('fixed',{a:2},'signature'),/CONFLICT/);
 }finally{b.close();}
});
test('independent OS processes race on the last budget: only one atomic reservation commits',async()=>{
 const {b,path}=fixture(),prefix=`.local/race-${randomUUID()}`,barrier=prefix+'.go';
 try{
 const runs=[1,2].map(n=>{const config=prefix+n+'.json';writeFileSync(config,JSON.stringify({id:'race-'+n,d,barrier}));const child=spawn(process.execPath,['--import','tsx','tests/budget-child.ts',path,'scope','reserve',config],{stdio:['ignore','pipe','pipe'],windowsHide:true});let errors='';child.stderr.on('data',v=>errors+=v);return new Promise<number>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0||code===3?resolve(code):reject(new Error(errors)));});});
 writeFileSync(barrier,'go');assert.deepEqual((await Promise.all(runs)).sort(),[0,3]);assert.equal(b.all('SELECT * FROM reservations').length,1);assert.equal(b.usage(d,1000).GLOBAL!.amount,600n);
 }finally{b.close();}
});
test('actual process exits before/after signature and during transaction preserve obligations; missing DB refuses startup',()=>{
 for(const mode of ['reserve-only','signature','uncommitted']){
   const {b,path}=fixture();b.close();const child=spawnSync(process.execPath,['--import','tsx','tests/budget-child.ts',path,'scope',mode,JSON.stringify(d)],{encoding:'utf8',windowsHide:true});assert.equal(child.status,17,child.stderr);
   const recovered=new Budget(path,'scope');try{assert.equal(recovered.meta('ready'),'0');assert.equal(recovered.get('SELECT remaining FROM reservations').remaining,'800');assert.equal(recovered.all('SELECT * FROM signatures').length,mode==='signature'?1:0);assert.throws(()=>recovered.reserve('x','x','x',d,1n,{},1000),/RECONCILIATION/);}finally{recovered.close();}
 }
 assert.throws(()=>new Budget(`.local/missing-${randomUUID()}.sqlite`,'scope'),/MISSING/);
});

test('AC40 independent processes atomically compete for each dimension amount and count separately',async()=>{
 for(const dimension of ['enterprise','fde','riskGroup','GLOBAL'] as const)for(const mode of ['reserve','payment'] as const){
  const {b,path}=fixture(10000n,100),prefix=`.local/dimension-race-${randomUUID()}`,barrier=prefix+'.go';
  try{
   b.pause();const config=limits(10000n,100,'2',100);config[dimension]={...config[dimension],amount:'1000',count:1};b.configure(config,1000,0);b.ready(1000);
   if(mode==='payment')for(const n of [1,2])b.reserve('r'+n,'d'+n,'i'+n,d,400n,{},1000);
   const runs=[1,2].map(n=>{
    const file=prefix+n+'.json';writeFileSync(file,JSON.stringify({id:'race-'+n,reservationId:'r'+n,d,barrier}));
    const child=spawn(process.execPath,['--import','tsx','tests/budget-child.ts',path,'scope',mode,file],{stdio:['ignore','pipe','pipe'],windowsHide:true});let errors='';child.stderr.on('data',v=>errors+=v);
    return new Promise<number>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0||code===3?resolve(code):reject(new Error(errors)));});
   });
   writeFileSync(barrier,'go');assert.deepEqual((await Promise.all(runs)).sort(),[0,3],`${dimension} ${mode}`);
   const usage=b.usage(d,1000)[dimension]!;assert.equal(usage.amount,mode==='reserve'?600n:800n);assert.equal(usage.count,mode==='reserve'?0:1);
   assert.equal(b.all('SELECT * FROM reservations').length,mode==='reserve'?1:2);assert.equal(b.all('SELECT * FROM payments').length,mode==='reserve'?0:1);
  }finally{b.close();}
 }
});
