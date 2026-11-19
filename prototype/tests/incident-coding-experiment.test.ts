import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCodingExperiment, runProcess } from '../packages/service/coding-experiment.ts';
import { BASELINE_SOURCE, ACCIDENT_SOURCE, SEED_ORDERS } from '../packages/service/coding-experiment-fixture.ts';
import { byteDigest } from '../packages/service/incident-ingest.ts';

test('N04 actual faulty/control SQLite executions, rollback, Git diff and all N03 originals are verifiable after restart',async()=>{
  const result=await runCodingExperiment(mkdtempSync(join(tmpdir(),'n04-suite-')));
  assert.equal(result.status,'passed');assert.equal(result.restartVerified,true);assert.equal(result.importCount,2);assert.equal(result.incidentCount,1);
  const bad=result.scenarios.find(s=>s.scenario==='accident')!,good=result.scenarios.find(s=>s.scenario==='control')!;
  assert.equal(bad.changedRows,3);assert.equal(bad.anomalyCount,2);assert.equal(bad.rollbackPassed,true);assert.ok(bad.incidentId);
  assert.equal(good.changedRows,1);assert.equal(good.anomalyCount,0);assert.equal(good.rollbackPassed,null);assert.equal(good.incidentId,null);
  assert.equal(bad.objectCount,14);assert.equal(good.objectCount,13);
  for(const scenario of result.scenarios){
    assert.equal(scenario.downloadVerified,true);assert.equal(scenario.replayed,true);
    const pkg=join(result.directory,scenario.directory,'package');
    const baseline=JSON.parse(readFileSync(join(pkg,'baseline-test.json'),'utf8'));
    assert.ok(baseline.assertions.every((a:any)=>a.passed));
    const narrow=JSON.parse(readFileSync(join(pkg,'candidate-test.json'),'utf8'));
    assert.equal(narrow.assertions.length,1);assert.equal(narrow.assertions[0].passed,true);
    assert.match(readFileSync(join(pkg,'git-diff.txt'),'utf8'),/diff --git/);
    const gate=JSON.parse(readFileSync(join(pkg,'approval.json'),'utf8'));assert.equal(gate.perRevisionHumanApproval,null);assert.equal(gate.recordingMode,'synthetic');
    const receipt=JSON.parse(readFileSync(join(result.directory,scenario.directory,'import-receipt.json'),'utf8'));
    assert.ok(receipt.objects.every((o:any)=>o.trust==='synthetic'&&o.signatureStatus==='valid'));
  }
  const rollback=JSON.parse(readFileSync(join(result.directory,'accident','package','rollback.json'),'utf8'));
  assert.deepEqual(rollback.restored,SEED_ORDERS);assert.deepEqual(rollback.afterSafeReplay,[{id:1,status:'cancelled'},{id:2,status:'shipped'},{id:3,status:'pending'}]);
  const db=new DatabaseSync(join(result.directory,'incidents.sqlite'));
  try{assert.equal(db.prepare('SELECT count(*) AS n FROM incident_objects').get()!.n,27);assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n,0);}finally{db.close();}
});

function workerFixture(){
  const dir=join(mkdtempSync(join(tmpdir(),'n04-gate-')),'accident');mkdirSync(dir);
  writeFileSync(join(dir,'baseline.mjs'),BASELINE_SOURCE);writeFileSync(join(dir,'candidate.mjs'),ACCIDENT_SOURCE);
  writeFileSync(join(dir,'isolation.json'),JSON.stringify({protocol:'N04-ISOLATED-v1',experimentId:'test',scenario:'accident',data:'synthetic-orders-only'}));
  const gate={protocol:'N04-EXECUTION-GATE-v1',experimentId:'test',scenario:'accident',targetDigest:byteDigest(ACCIDENT_SOURCE),baselineDigest:byteDigest(BASELINE_SOURCE),scope:'new-local-synthetic-database',perRevisionHumanApproval:null};
  writeFileSync(join(dir,'execution-gate.json'),JSON.stringify(gate));return {dir,gate};
}
const worker=(dir:string,phase:string)=>runProcess(process.execPath,['--import','tsx',resolve('scripts/coding-experiment-worker.ts'),dir,phase],resolve('.'));

test('N04 gate rejects changed code/hash and requires explicit scenario command before creating databases',async()=>{
  const f=workerFixture();writeFileSync(join(f.dir,'execution-gate.json'),JSON.stringify({...f.gate,targetDigest:'wrong'}));
  const mismatch=await worker(f.dir,'deploy');assert.notEqual(mismatch.code,0);assert.match(mismatch.stderr,/EXECUTION_GATE_MISMATCH/);assert.equal(existsSync(join(f.dir,'application.sqlite')),false);
  writeFileSync(join(f.dir,'execution-gate.json'),JSON.stringify(f.gate));writeFileSync(join(f.dir,'candidate.mjs'),'throw new Error("must never execute")');
  const untrusted=await worker(f.dir,'deploy');assert.notEqual(untrusted.code,0);assert.match(untrusted.stderr,/UNTRUSTED_EXECUTABLE/);assert.equal(existsSync(join(f.dir,'application.sqlite')),false);
  const noApproval=await runProcess(process.execPath,['--import','tsx',resolve('scripts/scenario-coding-experiment.ts')],resolve('.'));assert.notEqual(noApproval.code,0);assert.match(noApproval.stderr,/approve-isolated-experiment/);
});

test('N04 worker refuses existing databases and tampered restore snapshot without modifying orders',async()=>{
  const f=workerFixture();assert.equal((await worker(f.dir,'deploy')).code,0);
  const replay=await worker(f.dir,'deploy');assert.notEqual(replay.code,0);assert.match(replay.stderr,/DATABASE_ALREADY_EXISTS/);
  writeFileSync(join(f.dir,'before-deployment.json'),JSON.stringify([{id:99,status:'invented'}]));
  const badRestore=await worker(f.dir,'rollback');assert.notEqual(badRestore.code,0);assert.match(badRestore.stderr,/INVALID_RESTORE_SNAPSHOT/);
  const db=new DatabaseSync(join(f.dir,'application.sqlite'));try{assert.equal(db.prepare("SELECT count(*) AS n FROM orders WHERE status='cancelled'").get()!.n,3);}finally{db.close();}
});
