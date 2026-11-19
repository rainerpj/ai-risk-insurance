import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IncidentStore } from './incident-store.ts';
import { createIncidentApp } from './incident-api.ts';
import { byteDigest, objectSigningBytes, type ImportBundle, type ImportManifest, type ImportReceipt } from './incident-ingest.ts';
import { loadImportDirectory } from './incident-import-directory.ts';
import { ACCIDENT_SOURCE, BASELINE_SOURCE, CONTROL_SOURCE } from './coding-experiment-fixture.ts';

export const EXPERIMENT_AUTHORIZATION='继续推进N04隔离Coding事故实验及成功对照，将实验材料通过N03导入，完成后验证并更新项目进度和交接文档。';
export async function runProcess(executable:string,args:string[],cwd:string) {
  return await new Promise<{code:number|null;stdout:string;stderr:string}>((resolveResult,reject)=>{
    const processChild=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;processChild.kill();},30000);
    processChild.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)processChild.kill();});
    processChild.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>1024*1024)processChild.kill();});
    processChild.on('error',error=>{clearTimeout(timer);reject(error);});
    processChild.on('close',code=>{clearTimeout(timer);if(timedOut)reject(new Error('EXPERIMENT_CHILD_TIMEOUT'));else resolveResult({code,stdout,stderr});});
  });
}
export type ScenarioSummary={scenario:'accident'|'control';runId:string;importId:string;incidentId:string|null;changedRows:number;anomalyCount:number;rollbackPassed:boolean|null;objectCount:number;replayed:boolean;downloadVerified:boolean;directory:string};
export type ExperimentSummary={schemaVersion:1;experimentId:string;status:'passed';data:'synthetic-orders-only';gitVersion:string;scenarios:ScenarioSummary[];restartVerified:boolean;importCount:number;incidentCount:number;directory:string;limitations:string[]};

/** Runs only trusted fixtures in a newly created unique directory; never uses caller databases. */
export async function runCodingExperiment(parent=resolve('.local')):Promise<ExperimentSummary> {
  const experimentId=randomUUID(),directory=join(parent,`coding-experiment-${experimentId}`);
  mkdirSync(parent,{recursive:true});mkdirSync(directory);
  const database=join(directory,'incidents.sqlite'),store=new IncidentStore(database),app=createIncidentApp(store);
  let closed=false;
  const scenarios:ScenarioSummary[]=[];
  const writeJSON=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  const limitations=[
    'Actual SQLite mutations and child-process observations on synthetic orders; no customer system or financial loss.',
    'Codex-authored deterministic fault fixture; no captured live model/tool audit trace or provider/model snapshot.',
    'Task-level user authorization is recorded as attestation; per-revision human approval was not collected. Execution gate is synthetic harness enforcement.',
    'Git --no-index produces actual file diffs; no Git commit is created and code versions are SHA256 digests, not commit IDs.',
    'All sources are controlled by one local harness. Separate processes and signatures do not establish independent business provenance.',
    'N03 dataClass remains synthetic for isolated-test originals; accepted/signature-valid does not mean verified facts or insurance approval.'
  ];
  try {
    const git=await runProcess('git',['--version'],directory);assert.equal(git.code,0,git.stderr);
    const password=randomBytes(24).toString('hex');
    store.provision('experiment-admin','experiment-tenant',password,[{projectId:'experiment-project',role:'enterprise_admin'}]);
    const address=await app.listen({host:'127.0.0.1',port:0});
    const request=async(path:string,method:string,body?:unknown,token?:string,key?:string)=>{
      const response=await fetch(`${address}/api/incidents-v1${path}`,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:`Bearer ${token}`} :{}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const value=await response.json() as any;assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);return value;
    };
    const session=await request('/session','POST',{actorId:'experiment-admin',password});
    const token=session.token as string;
    const workflow=(await request('/workflows','POST',{schemaVersion:1,projectId:'experiment-project',enterpriseId:'synthetic-enterprise',fdePartyId:null,repoRef:'local-trusted-order-fixture',allowedActions:['isolated-test','synthetic-database-write','restore-synthetic-snapshot'],approvalPolicyVersion:'N04-task-authorized-synthetic-gate-v1',dataAuthorizationRef:`n04-task-${experimentId}`},token,'workflow')).record;
    for(const scenario of ['accident','control'] as const) {
      const dir=join(directory,scenario),pkg=join(dir,'package');mkdirSync(dir);mkdirSync(pkg);
      const candidate=scenario==='accident'?ACCIDENT_SOURCE:CONTROL_SOURCE;
      writeFileSync(join(dir,'baseline.mjs'),BASELINE_SOURCE,{flag:'wx'});writeFileSync(join(dir,'candidate.mjs'),candidate,{flag:'wx'});
      writeJSON(join(dir,'isolation.json'),{protocol:'N04-ISOLATED-v1',experimentId,scenario,data:'synthetic-orders-only'});
      const gate={protocol:'N04-EXECUTION-GATE-v1',experimentId,scenario,targetDigest:byteDigest(candidate),baselineDigest:byteDigest(BASELINE_SOURCE),scope:'new-local-synthetic-database',recordingMode:'synthetic',taskAuthorization:{mode:'attested',instruction:EXPERIMENT_AUTHORIZATION},perRevisionHumanApproval:null,recordedAt:new Date().toISOString()};
      writeJSON(join(dir,'execution-gate.json'),gate);
      const run=(await request('/runs','POST',{schemaVersion:1,projectId:'experiment-project',workflowId:workflow.workflowId,taskRef:`n04-${scenario}`,agentProvider:'Codex-assisted-fixture-authoring',modelVersion:null,toolVersions:{node:process.version,git:git.stdout.trim()},baseRevision:`sha256:${byteDigest(BASELINE_SOURCE)}`,resultRevision:`sha256:${byteDigest(candidate)}`,startedAt:new Date().toISOString(),endedAt:null,captureCoverage:{collected:['code-snapshots','git-file-diff','child-process-tests','local-deployment','sqlite-monitoring','task-authorization-attestation','synthetic-execution-gate',...(scenario==='accident'?['snapshot-restore']:[])],missing:['live-model-tool-audit','independent-human-revision-approval','independent-customer-sources']},environment:'isolated_test'},token,`${scenario}-run`)).record;
      const keys=generateKeyPairSync('ed25519'),sourceId=`n04-${scenario}-${experimentId}`;
      await request('/sources','POST',{schemaVersion:1,projectId:'experiment-project',sourceId,controllerPartyId:'local-experiment-harness',kind:'isolated-experiment-observations',allowedWorkflowIds:[workflow.workflowId],captureMethod:'source_export',keyId:`ephemeral-${scenario}`,publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),validFrom:new Date(Date.now()-60000).toISOString(),validUntil:null},token);
      const diff=await runProcess('git',['diff','--no-index','--no-ext-diff','--no-textconv','--','baseline.mjs','candidate.mjs'],dir);
      assert.equal(diff.code,1,'Both fixture variants must produce actual file diffs.');assert.ok(diff.stdout.includes('@@'));
      const traces:unknown[]=[],observations:Record<string,any>={};
      for(const phase of ['baseline-test','candidate-test','deploy','monitor',...(scenario==='accident'?['rollback']:[])]) {
        const result=await runProcess(process.execPath,['--import','tsx',resolve('scripts/coding-experiment-worker.ts'),dir,phase],resolve('.'));
        const expected=phase==='monitor'&&scenario==='accident'?20:0;
        assert.equal(result.code,expected,`${scenario}/${phase}: ${result.stderr}`);
        const observed=JSON.parse(result.stdout);assert.equal(observed.exitCode,expected);assert.equal(observed.scenario,scenario);
        observations[phase]=observed;
        traces.push({phase,executor:'trusted-local-worker',executable:'project-pinned-node',arguments:['coding-experiment-worker',scenario,phase],exitCode:result.code,stdout:result.stdout.trim(),stderr:result.stderr.trim()});
      }
      assert.equal(observations.deploy.changedRows,scenario==='accident'?3:1);
      assert.equal(observations.monitor.anomalies.length,scenario==='accident'?2:0);
      if(scenario==='accident')assert.equal(observations.rollback.passed,true);
      const materials:Record<string,string>={
        'task.json':JSON.stringify({experimentId,scenario,authoring:'Codex-authored deterministic fault injection',taskAuthorization:EXPERIMENT_AUTHORIZATION,providerTrace:null,limitations},null,2),
        'provenance.json':JSON.stringify({experimentId,scenario,runId:run.runId,tenantId:'experiment-tenant',projectId:'experiment-project',sourceId,environment:'isolated_test',dataClass:'synthetic',singleController:true,gitCommit:null,baselineDigest:byteDigest(BASELINE_SOURCE),candidateDigest:byteDigest(candidate),rawModelTrace:null},null,2),
        'baseline-code.txt':BASELINE_SOURCE,'candidate-code.txt':candidate,'git-diff.txt':diff.stdout,
        'git-export.json':JSON.stringify({tool:git.stdout.trim(),arguments:['diff','--no-index','--no-ext-diff','--no-textconv','--','baseline.mjs','candidate.mjs'],exitCode:diff.code,stderr:diff.stderr,commit:null}),
        'approval.json':JSON.stringify(gate,null,2),
        'execution.jsonl':traces.map(record=>JSON.stringify(record)).join('\n')+'\n',
        'costs.json':JSON.stringify({basis:'synthetic-fixture',actualEconomicLoss:null,paid:null,currency:null,invoiceEvidence:[],note:'No real invoice, cost or insurance payment is claimed.'})
      };
      for(const [phase,record] of Object.entries(observations))materials[`${phase}.json`]=JSON.stringify(record,null,2);
      const manifest:ImportManifest={schemaVersion:1,projectId:'experiment-project',packageId:`n04-${scenario}-${experimentId}`,runId:run.runId,dataAuthorizationRef:workflow.dataAuthorizationRef,dataClass:'synthetic',supersedesImportId:null,objects:[]};
      for(const [path,content] of Object.entries(materials)) {
        const bytes=Buffer.from(content);writeFileSync(join(pkg,path),bytes,{flag:'wx'});
        manifest.objects.push({objectId:`${scenario}-${path.replaceAll('.','-')}-${experimentId}`,path,sourceId,mediaType:path.endsWith('.jsonl')?'application/x-ndjson':path.endsWith('.json')?'application/json':'text/plain',byteLength:bytes.length,sha256:byteDigest(bytes),signature:null});
      }
      for(const object of manifest.objects)object.signature=sign(null,objectSigningBytes('experiment-tenant',manifest,object),keys.privateKey).toString('hex');
      writeJSON(join(pkg,'manifest.json'),manifest);
      const bundle:ImportBundle=loadImportDirectory(pkg);
      const imported=await request('/runs/imports','POST',bundle,token,`${scenario}-import`);
      const receipt=imported.receipt as ImportReceipt;assert.equal(receipt.status,'accepted');assert.equal(receipt.objects.length,Object.keys(materials).length);
      assert.ok(receipt.objects.every(o=>o.signatureStatus==='valid'&&o.trust==='synthetic'));
      const replay=await request('/runs/imports','POST',bundle,token,`${scenario}-import`);assert.equal(replay.replayed,true);assert.equal(replay.receipt.importId,receipt.importId);
      // Protocol integrity check: the served originals must match the observed experiment bytes.
      for(const object of manifest.objects) {
        const response=await fetch(`${address}/api/incidents-v1/imports/${receipt.importId}/objects/${object.objectId}?projectId=experiment-project`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
        assert.equal(response.status,200);assert.ok(Buffer.from(await response.arrayBuffer()).equals(readFileSync(join(pkg,object.path))));
      }
      const incident=scenario==='accident'?(await request('/incidents','POST',{schemaVersion:1,projectId:'experiment-project',workflowId:workflow.workflowId,runIds:[run.runId],detectedAt:observations.monitor.finishedAt,severity:'low',affectedAssets:['synthetic-orders'],statement:'Isolated SQLite experiment observed two non-target orders cancelled after a missing-WHERE mutation; restoration and safe replay passed. No real economic loss.',groupingReason:null,linkedIncidentIds:[]},token,'accident-declaration')).record:null;
      writeJSON(join(dir,'import-receipt.json'),receipt);
      scenarios.push({scenario,runId:run.runId,importId:receipt.importId,incidentId:incident?.incidentId??null,changedRows:observations.deploy.changedRows,anomalyCount:observations.monitor.anomalies.length,rollbackPassed:scenario==='accident'?observations.rollback.passed:null,objectCount:receipt.objects.length,replayed:true,downloadVerified:true,directory:scenario});
    }
    await request('/session','DELETE',undefined,token);await app.close();store.close();closed=true;
    const reopened=new IncidentStore(database);
    let importCount:number,incidentCount:number;
    try {
      importCount=Number(reopened.db.prepare('SELECT count(*) AS n FROM incident_imports').get()!.n);
      incidentCount=Number(reopened.db.prepare("SELECT count(*) AS n FROM records WHERE kind='incident'").get()!.n);
      assert.equal(importCount,2);assert.equal(incidentCount,1);
      for(const scenario of scenarios)assert.ok(reopened.db.prepare('SELECT payload FROM incident_imports WHERE id=?').get(scenario.importId));
      assert.throws(()=>reopened.authenticate(token),/AUTH_REQUIRED/);
    }finally{reopened.close();}
    const summary:ExperimentSummary={schemaVersion:1,experimentId,status:'passed',data:'synthetic-orders-only',gitVersion:git.stdout.trim(),scenarios,restartVerified:true,importCount,incidentCount,directory,limitations};
    writeJSON(join(directory,'summary.json'),summary);return summary;
  }catch(error){writeJSON(join(directory,'failure.json'),{experimentId,status:'failed',message:error instanceof Error?error.message:'UNKNOWN'});throw error;}
  finally{if(!closed){await app.close();store.close();}}
}
