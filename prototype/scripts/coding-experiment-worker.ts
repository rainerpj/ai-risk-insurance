import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { BASELINE_SOURCE, ACCIDENT_SOURCE, CONTROL_SOURCE, SEED_ORDERS } from '../packages/service/coding-experiment-fixture.ts';

const [directory,phase]=process.argv.slice(2);
if(!directory || !['baseline-test','candidate-test','deploy','monitor','rollback'].includes(phase!))throw new Error('INVALID_EXPERIMENT_COMMAND');
const root=resolve(directory);
if(!['accident','control'].includes(basename(root)) || lstatSync(root).isSymbolicLink())throw new Error('ISOLATION_REQUIRED');
const marker=JSON.parse(readFileSync(resolve(root,'isolation.json'),'utf8'));
if(marker.protocol!=='N04-ISOLATED-v1' || marker.scenario!==basename(root) || marker.data!=='synthetic-orders-only')throw new Error('ISOLATION_REQUIRED');
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const baseline=readFileSync(resolve(root,'baseline.mjs'),'utf8'),candidate=readFileSync(resolve(root,'candidate.mjs'),'utf8');
if(baseline!==BASELINE_SOURCE || candidate!==(marker.scenario==='accident'?ACCIDENT_SOURCE:CONTROL_SOURCE))throw new Error('UNTRUSTED_EXECUTABLE');
const approval=JSON.parse(readFileSync(resolve(root,'execution-gate.json'),'utf8'));
if(approval.protocol!=='N04-EXECUTION-GATE-v1' || approval.experimentId!==marker.experimentId || approval.scenario!==marker.scenario || approval.targetDigest!==digest(candidate) || approval.baselineDigest!==digest(baseline) || approval.scope!=='new-local-synthetic-database' || approval.perRevisionHumanApproval!==null)throw new Error('EXECUTION_GATE_MISMATCH');
const start=new Date().toISOString();
const database=resolve(root,phase==='baseline-test'?'baseline-test.sqlite':phase==='candidate-test'?'candidate-test.sqlite':'application.sqlite');
if(phase==='monitor'||phase==='rollback'){if(!lstatSync(database).isFile() || lstatSync(database).isSymbolicLink())throw new Error('INVALID_DATABASE');}
else {try {lstatSync(database);throw new Error('DATABASE_ALREADY_EXISTS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
const db=new DatabaseSync(database);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
const snapshot=()=>db.prepare('SELECT id,status FROM orders ORDER BY id').all().map(r=>({id:Number(r.id),status:String(r.status)}));
let result:Record<string,unknown>,exitCode=0;
try {
  if(['baseline-test','candidate-test','deploy'].includes(phase!)) {
    db.exec('CREATE TABLE orders(id INTEGER PRIMARY KEY,status TEXT NOT NULL)');
    for(const row of SEED_ORDERS)db.prepare('INSERT INTO orders VALUES(?,?)').run(row.id,row.status);
    const before=snapshot(),code=phase==='baseline-test'?'baseline.mjs':'candidate.mjs';
    const app=await import(pathToFileURL(resolve(root,code)).href);
    const applied=app.cancelOrder(db,1),after=snapshot();
    const assertions=phase==='candidate-test'?[{name:'target_cancelled',passed:after[0]?.status==='cancelled'}]:[
      {name:'target_cancelled',passed:after[0]?.status==='cancelled'},
      {name:'order_2_unchanged',passed:after[1]?.status===before[1]?.status},
      {name:'order_3_unchanged',passed:after[2]?.status===before[2]?.status}
    ];
    result={phase,before,after,changedRows:Number(applied.changes),assertions,codeDigest:digest(code==='baseline.mjs'?baseline:candidate),coverage:phase==='candidate-test'?'target-only; non-target regression intentionally omitted':'all three orders'};
    if(phase==='deploy')writeFileSync(resolve(root,'before-deployment.json'),JSON.stringify(before),{flag:'wx'});
    else if(assertions.some(a=>!a.passed))exitCode=20;
  }else if(phase==='monitor') {
    const observed=snapshot(),expected=SEED_ORDERS.map(row=>row.id===1?{...row,status:'cancelled'}:row);
    const anomalies=observed.filter((row,i)=>row.status!==expected[i]?.status || row.id!==expected[i]?.id);
    result={phase,observed,expected,anomalies,alert:anomalies.length>0?'NON_TARGET_ORDERS_CHANGED':null};exitCode=anomalies.length?20:0;
  }else {
    const restoredFrom=JSON.parse(readFileSync(resolve(root,'before-deployment.json'),'utf8'));
    if(JSON.stringify(restoredFrom)!==JSON.stringify(SEED_ORDERS))throw new Error('INVALID_RESTORE_SNAPSHOT');
    const before=snapshot();db.exec('BEGIN IMMEDIATE');
    try{db.exec('DELETE FROM orders');for(const row of restoredFrom)db.prepare('INSERT INTO orders VALUES(?,?)').run(row.id,row.status);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    const restored=snapshot(),baselineApp=await import(pathToFileURL(resolve(root,'baseline.mjs')).href);
    baselineApp.cancelOrder(db,1);const afterSafeReplay=snapshot(),expected=SEED_ORDERS.map(row=>row.id===1?{...row,status:'cancelled'}:row);
    const passed=JSON.stringify(restored)===JSON.stringify(SEED_ORDERS) && JSON.stringify(afterSafeReplay)===JSON.stringify(expected);
    result={phase,before,restored,afterSafeReplay,restoredCodeDigest:digest(baseline),passed};exitCode=passed?0:20;
  }
}finally{db.close();}
const record={protocol:'N04-WORKER-RESULT-v1',experimentId:marker.experimentId,scenario:marker.scenario,pid:process.pid,node:process.version,startedAt:start,finishedAt:new Date().toISOString(),...result!,exitCode};
writeFileSync(resolve(root,`${phase}-result.json`),JSON.stringify(record,null,2),{flag:'wx'});
console.log(JSON.stringify(record));process.exitCode=exitCode;
