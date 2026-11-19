import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentIngest,byteDigest,objectSigningBytes,parseManifest,INGEST_LIMITS,type ImportBundle,type SourceInput } from '../packages/service/incident-ingest.ts';
import { loadImportDirectory } from '../packages/service/incident-import-directory.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import type { Workflow, AgentRun } from '../packages/domain/incident-schema.ts';

const password='synthetic-local-password-123';
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'incident-n03-')),file=join(dir,'incidents.sqlite'),store=new IncidentStore(file);
  store.provision('admin','tenant-a',password,[{projectId:'project-a',role:'enterprise_admin'},{projectId:'project-b',role:'enterprise_admin'}]);
  store.provision('fde','tenant-a',password,[{projectId:'project-a',role:'fde'}]);
  store.provision('viewer','tenant-a',password,[{projectId:'project-a',role:'viewer'}]);
  store.provision('foreign','tenant-b',password,[{projectId:'project-a',role:'enterprise_admin'}]);
  const token=store.login('admin',password).token,actor=store.authenticate(token),ingest=new IncidentIngest(store);
  const w=store.create(actor,'workflow',{schemaVersion:1,projectId:'project-a',enterpriseId:'enterprise',fdePartyId:'fde',repoRef:'synthetic-repo',allowedActions:['read'],approvalPolicyVersion:'v1',dataAuthorizationRef:'authorization-1'},'w').record as Workflow;
  const r=store.create(actor,'run',{schemaVersion:1,projectId:'project-a',workflowId:w.workflowId,taskRef:'task-1',agentProvider:null,modelVersion:null,toolVersions:{},baseRevision:null,resultRevision:null,startedAt:null,endedAt:null,captureCoverage:{collected:[],missing:['events']},environment:'synthetic'},'r').record as AgentRun;
  const source:SourceInput={schemaVersion:1,projectId:'project-a',sourceId:'source-a',controllerPartyId:'controller',kind:'git-export',allowedWorkflowIds:[w.workflowId],captureMethod:'synthetic',keyId:null,publicKey:null,validFrom:'2020-01-01T00:00:00.000Z',validUntil:null};
  ingest.registerSource(actor,source);
  const content=Buffer.from(JSON.stringify({tenantId:'tenant-a',projectId:'project-a',runId:r.runId,sourceId:'source-a',message:'synthetic original'}));
  const bundle:ImportBundle={manifest:{schemaVersion:1,projectId:'project-a',packageId:'package-a',runId:r.runId,dataAuthorizationRef:'authorization-1',dataClass:'synthetic',supersedesImportId:null,objects:[{objectId:'object-a',path:'data/original.json',sourceId:'source-a',mediaType:'application/json',byteLength:content.length,sha256:byteDigest(content),signature:null}]},objects:[{path:'data/original.json',contentBase64:content.toString('base64')}]};
  return {dir,file,store,ingest,actor,token,w,r,source,content,bundle};
}
function replaceContent(bundle:ImportBundle,content:Buffer){bundle.objects[0]!.contentBase64=content.toString('base64');bundle.manifest.objects[0]!.byteLength=content.length;bundle.manifest.objects[0]!.sha256=byteDigest(content);}
function child(script:string,args:string[]):Promise<{code:number|null;out:string;err:string}> {
  return new Promise((res,rej)=>{const p=spawn(process.execPath,['--import','tsx',resolve(script),...args],{stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',rej);p.on('exit',code=>res({code,out,err}));});
}

test('v1 migration preserves original records, sessions and audit; v2 reopen is idempotent',()=>{
  const f=fixture();const prior=f.store.db.prepare('SELECT count(*) AS n FROM records').get()!.n;
  // Reconstruct the exact pre-N03 schema in this disposable fixture only.
  f.store.db.exec('DROP TABLE incident_import_keys; DROP TABLE incident_imports; DROP TABLE incident_objects; DROP TABLE incident_sources; DELETE FROM migrations WHERE version=2; PRAGMA user_version=1;');f.store.close();
  const migrated=new IncidentStore(f.file);
  try{assert.equal(migrated.db.prepare('PRAGMA user_version').get()!.user_version,2);assert.equal(migrated.db.prepare('SELECT count(*) AS n FROM records').get()!.n,prior);assert.deepEqual(migrated.authenticate(f.token),f.actor);assert.equal(migrated.db.prepare('SELECT count(*) AS n FROM migrations').get()!.n,2);}finally{migrated.close();}
  const reopened=new IncidentStore(f.file);try{assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM migrations').get()!.n,2);}finally{reopened.close();}
});

test('source registration is admin-only, immutable, project-scoped and revocable without rewriting history',()=>{
  const f=fixture();try{
    const fde=f.store.authenticate(f.store.login('fde',password).token);assert.throws(()=>f.ingest.registerSource(fde,f.source),/ROLE_DENIED/);
    assert.deepEqual(f.ingest.registerSource(f.actor,f.source),f.source);
    assert.throws(()=>f.ingest.registerSource(f.actor,{...f.source,kind:'changed'}),/SOURCE_CONFLICT/);
    assert.throws(()=>f.ingest.registerSource(f.actor,{...f.source,sourceId:'bad-key',keyId:'key',publicKey:'broken'}),/INVALID_SOURCE_KEY/);
    const old=f.ingest.import(f.actor,f.bundle,'one').receipt;
    f.ingest.revokeSource(f.actor,'project-a','source-a','retired');
    assert.throws(()=>f.ingest.import(f.actor,f.bundle,'one'),/SOURCE_INACTIVE/);
    assert.equal(f.ingest.get(f.actor,'project-a',old.importId).status,'accepted');
    assert.equal(f.ingest.source(f.actor,'project-a','source-a').revocationReason,'retired');
    assert.throws(()=>f.ingest.revokeSource(f.actor,'project-a','source-a','different'),/REVOCATION_CONFLICT/);
  }finally{f.store.close();}
});

test('accepted original bytes, manifest and import receipt survive restart; duplicate package/key never increments objects',()=>{
  const f=fixture();const first=f.ingest.import(f.actor,f.bundle,'one');assert.equal(first.receipt.status,'accepted');assert.equal(first.receipt.objects[0]!.trust,'synthetic');
  assert.equal(f.ingest.import(f.actor,f.bundle,'two').receipt.importId,first.receipt.importId);f.store.close();
  const s=new IncidentStore(f.file),ingest=new IncidentIngest(s);try{
    assert.equal(ingest.import(s.authenticate(f.token),f.bundle,'one').replayed,true);
    assert.deepEqual(ingest.original(f.actor,'project-a',first.receipt.importId,'object-a').content,f.content);
    assert.deepEqual(ingest.get(f.actor,'project-a',first.receipt.importId).manifest,f.bundle.manifest);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM incident_objects').get()!.n,1);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM incident_imports').get()!.n,1);
  }finally{s.close();}
});

test('missing originals quarantine an immutable receipt; new supplemental package links old receipt',()=>{
  const f=fixture();try{
    const missing=structuredClone(f.bundle);missing.objects=[];
    const first=f.ingest.import(f.actor,missing,'missing').receipt;
    assert.equal(first.status,'quarantined');assert.deepEqual(first.missingPaths,['data/original.json']);assert.equal(first.manifest.objects.length,1);
    assert.throws(()=>f.ingest.import(f.actor,f.bundle,'missing'),/IDEMPOTENCY_CONFLICT/);
    assert.throws(()=>f.ingest.import(f.actor,f.bundle,'fresh-key'),/PACKAGE_CONFLICT/);
    const supplemental=structuredClone(f.bundle);supplemental.manifest.packageId='supplement';supplemental.manifest.supersedesImportId=first.importId;
    assert.equal(f.ingest.import(f.actor,supplemental,'supplement').receipt.status,'accepted');
    assert.equal(f.ingest.get(f.actor,'project-a',first.importId).status,'quarantined');
  }finally{f.store.close();}
});

test('tampered bytes are rejected on retries; object-ID and package-ID conflicts preserve original bytes',()=>{
  const f=fixture();try{
    const first=f.ingest.import(f.actor,f.bundle,'one').receipt;
    const changed=structuredClone(f.bundle);changed.objects[0]!.contentBase64=Buffer.from('tampered').toString('base64');
    assert.throws(()=>f.ingest.import(f.actor,changed,'one'),/OBJECT_DIGEST_MISMATCH/);
    replaceContent(changed,Buffer.from('{"different":true}'));assert.throws(()=>f.ingest.import(f.actor,changed,'two'),/PACKAGE_CONFLICT/);
    changed.manifest.packageId='new';assert.throws(()=>f.ingest.import(f.actor,changed,'new'),/OBJECT_ID_CONFLICT/);
    assert.deepEqual(f.ingest.original(f.actor,'project-a',first.importId,'object-a').content,f.content);
  }finally{f.store.close();}
});

test('Ed25519 binds scope and bytes; synthetic remains synthetic even when signature is valid',()=>{
  const f=fixture();try{
    const keys=generateKeyPairSync('ed25519');f.ingest.registerSource(f.actor,{...f.source,sourceId:'signed-source',captureMethod:'source_export',keyId:'key-1',publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()});
    const b=structuredClone(f.bundle);b.manifest.objects[0]!.sourceId='signed-source';replaceContent(b,Buffer.from('{"note":"signed synthetic"}'));
    b.manifest.objects[0]!.signature=sign(null,objectSigningBytes('tenant-a',b.manifest,b.manifest.objects[0]!),keys.privateKey).toString('hex');
    const receipt=f.ingest.import(f.actor,b,'signed').receipt;assert.equal(receipt.objects[0]!.signatureStatus,'valid');assert.equal(receipt.objects[0]!.trust,'synthetic');
    const forged=structuredClone(b);forged.manifest.objects[0]!.signature='00'.repeat(64);assert.throws(()=>f.ingest.import(f.actor,forged,'forged'),/SIGNATURE_INVALID/);
    const wrong=structuredClone(b);wrong.manifest.objects[0]!.signature=sign(null,objectSigningBytes('tenant-b',b.manifest,b.manifest.objects[0]!),keys.privateKey).toString('hex');assert.throws(()=>f.ingest.import(f.actor,wrong,'wrong'),/SIGNATURE_INVALID/);
    const unsigned=structuredClone(b);unsigned.manifest.objects[0]!.signature=null;assert.throws(()=>f.ingest.import(f.actor,unsigned,'unsigned'),/SIGNATURE_INVALID/);
  }finally{f.store.close();}
});

test('authorization ref, source workflow, expiry, roles and cross-tenant/project references are checked',()=>{
  const f=fixture();try{
    const viewer=f.store.authenticate(f.store.login('viewer',password).token),foreign=f.store.authenticate(f.store.login('foreign',password).token),fde=f.store.authenticate(f.store.login('fde',password).token);
    assert.throws(()=>f.ingest.import(viewer,f.bundle,'one'),/ROLE_DENIED/);assert.throws(()=>f.ingest.import(foreign,f.bundle,'one'),/NOT_FOUND/);
    const wrong=structuredClone(f.bundle);wrong.manifest.projectId='project-b';assert.throws(()=>f.ingest.import(fde,wrong,'one'),/NOT_FOUND/);assert.throws(()=>f.ingest.import(f.actor,wrong,'one'),/NOT_FOUND/);
    wrong.manifest.projectId='project-a';wrong.manifest.dataAuthorizationRef='unapproved';assert.throws(()=>f.ingest.import(f.actor,wrong,'one'),/AUTHORIZATION_MISMATCH/);
    f.ingest.registerSource(f.actor,{...f.source,sourceId:'expired',validUntil:'2021-01-01T00:00:00.000Z'});
    wrong.manifest.dataAuthorizationRef='authorization-1';wrong.manifest.objects[0]!.sourceId='expired';assert.throws(()=>f.ingest.import(f.actor,wrong,'one'),/SOURCE_INACTIVE/);
    const originalWrong=structuredClone(f.bundle);replaceContent(originalWrong,Buffer.from('{"tenantId":"tenant-b"}'));assert.throws(()=>f.ingest.import(f.actor,originalWrong,'one'),/ORIGINAL_SCOPE_MISMATCH/);
    replaceContent(originalWrong,Buffer.from('[{"tenantId":"tenant-b"}]'));assert.throws(()=>f.ingest.import(f.actor,originalWrong,'one'),/ORIGINAL_SCOPE_MISMATCH/);
    const good=f.ingest.import(fde,f.bundle,'fde').receipt;assert.throws(()=>f.ingest.get(foreign,'project-a',good.importId),/NOT_FOUND/);
    f.store.db.prepare('DELETE FROM grants WHERE actor_id=?').run('fde');assert.throws(()=>f.ingest.original(fde,'project-a',good.importId,'object-a'),/NOT_FOUND/);
  }finally{f.store.close();}
});

test('manifest paths, duplicates, MIME, counts and sizes fail before persistence',()=>{
  const f=fixture();try{
    for(const path of ['../secret.json','C:/secret.json','/root.json','data\\secret.json','data/a.json:stream','data/CON.txt','data/a.exe','data/%2e%2e.json']) {const b=structuredClone(f.bundle);b.manifest.objects[0]!.path=path;assert.throws(()=>f.ingest.import(f.actor,b,'one'),/INVALID_OBJECT_PATH/);}
    const duplicate=structuredClone(f.bundle);duplicate.manifest.objects.push({...duplicate.manifest.objects[0]!,objectId:'second'});assert.throws(()=>parseManifest(duplicate.manifest),/DUPLICATE_OBJECT/);
    const size=structuredClone(f.bundle);size.manifest.objects[0]!.byteLength=INGEST_LIMITS.objectBytes+1;assert.throws(()=>parseManifest(size.manifest),/OBJECT_SIZE_LIMIT/);
    const many=structuredClone(f.bundle);many.manifest.objects=Array.from({length:33},()=>many.manifest.objects[0]!);assert.throws(()=>parseManifest(many.manifest),/OBJECT_COUNT_LIMIT/);
    const extra=structuredClone(f.bundle);extra.objects.push({path:'extra.txt',contentBase64:'eA=='});assert.throws(()=>f.ingest.import(f.actor,extra,'one'),/UNLISTED_OR_DUPLICATE_OBJECT/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM incident_imports').get()!.n,0);
  }finally{f.store.close();}
});

test('strict original JSON, JSONL, UTF8 and structured record limits reject malformed input',()=>{
  const f=fixture();try{
    for(const content of [Buffer.from('{"a":1,"a":2}'),Buffer.from('{broken'),Buffer.from([0xff]),Buffer.from(JSON.stringify(Array.from({length:1001},()=>({a:1}))))]) {
      const b=structuredClone(f.bundle);replaceContent(b,content);assert.throws(()=>f.ingest.import(f.actor,b,'one'),/INVALID_ORIGINAL_JSON|INVALID_UTF8|RECORD_COUNT_LIMIT/);
    }
    const b=structuredClone(f.bundle);b.manifest.objects[0]!.path='data/events.jsonl';b.manifest.objects[0]!.mediaType='application/x-ndjson';b.objects[0]!.path='data/events.jsonl';replaceContent(b,Buffer.from('{"step":1}\n{"step":2}\n'));
    assert.equal(f.ingest.import(f.actor,b,'jsonl').receipt.status,'accepted');
  }finally{f.store.close();}
});

test('import transaction rolls back original bytes, receipt and key together on audit failure',()=>{
  const f=fixture();try{
    f.store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON audit WHEN NEW.action='import_evidence' BEGIN SELECT RAISE(ABORT,'injected'); END;");
    assert.throws(()=>f.ingest.import(f.actor,f.bundle,'one'),/injected/);
    for(const table of ['incident_objects','incident_imports','incident_import_keys'])assert.equal(f.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
    f.store.db.exec('DROP TRIGGER fail_import');assert.equal(f.ingest.import(f.actor,f.bundle,'one').replayed,false);
  }finally{f.store.close();}
});

test('four independent ingest processes persist exactly one package and original',async()=>{
  const f=fixture();try{
    const results=await Promise.all(Array.from({length:4},()=>child('tests/incident-ingest-child.ts',[f.file,f.token,JSON.stringify(f.bundle)])));
    for(const result of results)assert.equal(result.code,0,result.err);
    const receipts=results.map(r=>JSON.parse(r.out));assert.equal(new Set(receipts.map(r=>r.receipt.importId)).size,1);assert.equal(receipts.filter(r=>!r.replayed).length,1);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM incident_objects').get()!.n,1);
  }finally{f.store.close();}
});

test('directory loader rejects symlink directories, reads only manifest entries and preserves missing status',()=>{
  const f=fixture();try{
    const pkg=join(f.dir,'package');mkdirSync(join(pkg,'data'),{recursive:true});writeFileSync(join(pkg,'manifest.json'),JSON.stringify(f.bundle.manifest));writeFileSync(join(pkg,'data','original.json'),f.content);writeFileSync(join(pkg,'ignored.txt'),'not imported');
    assert.deepEqual(JSON.parse(JSON.stringify(loadImportDirectory(pkg))),f.bundle);
    const link=join(f.dir,'package-link');symlinkSync(pkg,link,'junction');assert.throws(()=>loadImportDirectory(link),/SYMLINK_OR_SPECIAL_FILE/);
    const missing=join(f.dir,'missing');mkdirSync(missing);writeFileSync(join(missing,'manifest.json'),JSON.stringify(f.bundle.manifest));assert.equal(loadImportDirectory(missing).objects.length,0);
  }finally{f.store.close();}
});

test('real HTTP + CLI imports directory, repeats idempotently, downloads bytes and rejects unauthenticated access',async()=>{
  const f=fixture(),app=createIncidentApp(f.store);try{
    const address=await app.listen({host:'127.0.0.1',port:0}),pkg=join(f.dir,'package');mkdirSync(join(pkg,'data'),{recursive:true});writeFileSync(join(pkg,'manifest.json'),JSON.stringify(f.bundle.manifest));writeFileSync(join(pkg,'data','original.json'),f.content);
    const sessionFile=join(f.dir,'session.private.json');writeFileSync(sessionFile,JSON.stringify({token:f.token}));
    const first=await child('scripts/import-incidents.ts',[address,pkg,sessionFile,'cli']);assert.equal(first.code,0,first.err);const result=JSON.parse(first.out);assert.equal(result.status,'accepted');
    const again=await child('scripts/import-incidents.ts',[address,pkg,sessionFile,'cli']);assert.equal(again.code,0,again.err);assert.equal(JSON.parse(again.out).replayed,true);
    const url=`${address}/api/incidents-v1/imports/${result.importId}/objects/object-a?projectId=project-a`;
    assert.equal((await fetch(url)).status,401);
    const response=await fetch(url,{headers:{authorization:`Bearer ${f.token}`}});assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.content);assert.match(response.headers.get('content-disposition')!,/attachment/);
    const invalid=await child('scripts/import-incidents.ts',['https://example.com',pkg,sessionFile,'no-network']);assert.equal(invalid.code,1);assert.match(invalid.err,/LOCAL_ORIGIN_REQUIRED/);assert.ok(!first.out.includes(f.token));
  }finally{await app.close();f.store.close();}
});

test('original download detects storage corruption without returning altered bytes',()=>{
  const f=fixture();try{const receipt=f.ingest.import(f.actor,f.bundle,'one').receipt;f.store.db.prepare('UPDATE incident_objects SET content=?').run(Buffer.from('corrupt'));assert.throws(()=>f.ingest.original(f.actor,'project-a',receipt.importId,'object-a'),/STORED_ORIGINAL_CORRUPT/);}finally{f.store.close();}
});

test('redacted gateway signature proves receipt only; unsigned gateway stays unverified and future sources fail',()=>{
  const f=fixture();try{
    const {runId:_id,tenantId:_tenant,createdAt:_created,version:_version,...input}=f.r;
    const redacted=f.store.create(f.actor,'run',{...input,environment:'approved_redacted'},'redacted').record as AgentRun;
    const keys=generateKeyPairSync('ed25519');
    f.ingest.registerSource(f.actor,{...f.source,sourceId:'gateway',captureMethod:'gateway_receipt',keyId:'gateway-key',publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()});
    const b=structuredClone(f.bundle);b.manifest.runId=redacted.runId;b.manifest.dataClass='approved_redacted';b.manifest.objects[0]!.sourceId='gateway';replaceContent(b,Buffer.from('{"redacted":"test fixture only"}'));
    b.manifest.objects[0]!.signature=sign(null,objectSigningBytes('tenant-a',b.manifest,b.manifest.objects[0]!),keys.privateKey).toString('hex');
    assert.equal(f.ingest.import(f.actor,b,'gateway').receipt.objects[0]!.trust,'gateway_received');
    f.ingest.registerSource(f.actor,{...f.source,sourceId:'unsigned-gateway',captureMethod:'gateway_receipt'});
    b.manifest.packageId='unsigned';b.manifest.objects[0]!.objectId='unsigned';b.manifest.objects[0]!.sourceId='unsigned-gateway';b.manifest.objects[0]!.signature=null;
    assert.equal(f.ingest.import(f.actor,b,'unsigned').receipt.objects[0]!.trust,'unverified');
    f.ingest.registerSource(f.actor,{...f.source,sourceId:'future',validFrom:'2099-01-01T00:00:00.000Z'});
    const future=structuredClone(f.bundle);future.manifest.objects[0]!.sourceId='future';assert.throws(()=>f.ingest.import(f.actor,future,'future'),/SOURCE_INACTIVE/);
    const synthetic=structuredClone(f.bundle);synthetic.manifest.runId=redacted.runId;synthetic.manifest.dataClass='approved_redacted';assert.throws(()=>f.ingest.import(f.actor,synthetic,'synthetic'),/SOURCE_DATA_CLASS_MISMATCH/);
  }finally{f.store.close();}
});

test('source workflow restriction, total size and MIME checks do not trust caller declarations',()=>{
  const f=fixture();try{
    const {workflowId:_id,tenantId:_tenant,createdAt:_created,version:_version,status:_status,...input}=f.w;
    const other=f.store.create(f.actor,'workflow',{...input,repoRef:'other'},'other-w').record as Workflow;
    f.ingest.registerSource(f.actor,{...f.source,sourceId:'other-workflow',allowedWorkflowIds:[other.workflowId]});
    const b=structuredClone(f.bundle);b.manifest.objects[0]!.sourceId='other-workflow';assert.throws(()=>f.ingest.import(f.actor,b,'scope'),/SOURCE_SCOPE_DENIED/);
    const mime=structuredClone(f.bundle);mime.manifest.objects[0]!.mediaType='text/plain';assert.throws(()=>parseManifest(mime.manifest),/MEDIA_TYPE_MISMATCH/);
    const total=structuredClone(f.bundle);total.manifest.objects=Array.from({length:9},(_,i)=>({...f.bundle.manifest.objects[0]!,objectId:`object-${i}`,path:`file-${i}.json`,byteLength:INGEST_LIMITS.objectBytes}));assert.throws(()=>parseManifest(total.manifest),/PACKAGE_SIZE_LIMIT/);
  }finally{f.store.close();}
});

test('HTTP source routes enforce registration roles and import-specific body limit',async()=>{
  const f=fixture(),app=createIncidentApp(f.store);try{
    const prefix='/api/incidents-v1',headers={authorization:`Bearer ${f.token}`};
    assert.equal((await app.inject({method:'POST',url:`${prefix}/sources`,headers,payload:{...f.source,sourceId:'http-source'}})).statusCode,200);
    const fde=f.store.login('fde',password).token;
    assert.equal((await app.inject({method:'POST',url:`${prefix}/sources`,headers:{authorization:`Bearer ${fde}`},payload:{...f.source,sourceId:'fde-source'}})).statusCode,403);
    assert.equal((await app.inject({url:`${prefix}/sources/http-source?projectId=project-a`,headers})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:`${prefix}/sources/http-source/revocation`,headers,payload:{projectId:'project-a',reason:'retired'}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:`${prefix}/runs/imports`,headers:{...headers,'content-type':'application/json','idempotency-key':'oversized'},payload:'x'.repeat(INGEST_LIMITS.requestBytes+1)})).statusCode,413);
  }finally{await app.close();f.store.close();}
});
