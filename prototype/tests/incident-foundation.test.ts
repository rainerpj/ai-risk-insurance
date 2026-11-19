import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { parseWorkflow, parseRun, parseIncident, validateExpense, type Workflow, type AgentRun, type Incident, type ExpenseLine } from '../packages/domain/incident-schema.ts';

const password = 'local-synthetic-password-123';
const workflow = (projectId = 'project-a') => ({schemaVersion:1,projectId,enterpriseId:'enterprise-a',fdePartyId:'fde-a',repoRef:'authorized-demo-repo',allowedActions:['read','propose_patch'],approvalPolicyVersion:'v1',dataAuthorizationRef:'synthetic-authorization-1'});
const run = (workflowId: string, projectId = 'project-a') => ({schemaVersion:1,projectId,workflowId,taskRef:'task-1',agentProvider:null,modelVersion:null,toolVersions:{git:'fixture'},baseRevision:null,resultRevision:null,startedAt:null,endedAt:null,captureCoverage:{collected:[],missing:['tool_events']},environment:'synthetic'});
const incident = (workflowId: string, runIds: string[] = [], projectId = 'project-a') => ({schemaVersion:1,projectId,workflowId,runIds,detectedAt:null,severity:'unknown',affectedAssets:['isolated-db'],statement:'Synthetic incident, cause unknown',groupingReason:null,linkedIncidentIds:[]});
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(),'incident-n02-')),'incidents.sqlite');
  const store = new IncidentStore(file);
  store.provision('admin','tenant-a',password,[{projectId:'project-a',role:'enterprise_admin'},{projectId:'project-b',role:'enterprise_admin'}]);
  store.provision('fde','tenant-a',password,[{projectId:'project-a',role:'fde'}]);
  store.provision('viewer','tenant-a',password,[{projectId:'project-a',role:'viewer'}]);
  store.provision('other','tenant-b',password,[{projectId:'project-a',role:'enterprise_admin'}]);
  const token = store.login('admin',password).token, actor = store.authenticate(token);
  return {file,store,token,actor};
}

test('v1 contracts reject unknown fields, old versions, invented scope, invalid timestamps and overlapping coverage', () => {
  assert.equal(parseWorkflow(workflow()).schemaVersion,1);
  for (const extra of [{tenantId:'foreign'},{chainId:31337},{schemaVersion:0},{allowedActions:[]},{allowedActions:['read','read']}]) assert.throws(() => parseWorkflow({...workflow(),...extra}));
  assert.equal(parseRun(run('workflow-1')).modelVersion,null);
  assert.throws(() => parseRun({...run('workflow-1'),startedAt:'2026-02-30T00:00:00.000Z'}));
  assert.throws(() => parseRun({...run('workflow-1'),startedAt:'2026-11-15T00:00:00.000Z',endedAt:'2026-11-14T00:00:00.000Z'}));
  assert.throws(() => parseRun({...run('workflow-1'),captureCoverage:{collected:['git'],missing:['git']}}));
  assert.throws(() => parseIncident({...incident('workflow-1'),linkedIncidentIds:['case-1']}));
});

test('money stays exact above Number precision; unknown is null and verification requires evidence', () => {
  const expense: ExpenseLine = {schemaVersion:1,tenantId:'tenant-a',projectId:'project-a',createdAt:new Date().toISOString(),expenseId:'expense-1',category:'recovery',currency:'USD',scale:2,gross:'9007199254740993',paid:null,duplicate:null,compensation:null,recovery:null,netVerified:null,evidenceRefs:[],verificationStatus:'unknown'};
  assert.equal(validateExpense(expense).gross,'9007199254740993');
  for (const amount of [0,-1,'-1','1.1','01','1e3',undefined]) assert.throws(() => validateExpense({...expense,gross:amount} as ExpenseLine));
  assert.throws(() => validateExpense({...expense,verificationStatus:'verified'}));
  assert.throws(() => validateExpense({...expense,scale:19}));
});

test('independent SQLite WAL, persisted session and records survive reopen without chain or insurance tables', () => {
  const {file,store,token,actor} = fixture();
  const w = store.create(actor,'workflow',workflow(),'w1').record as Workflow;
  const r = store.create(actor,'run',run(w.workflowId),'r1').record as AgentRun;
  const i = store.create(actor,'incident',incident(w.workflowId,[r.runId]),'i1').record as Incident;
  assert.equal(store.db.prepare('PRAGMA journal_mode').get()!.journal_mode,'wal');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('outbox','notices','meta')").get()!.n,0);
  store.close();
  const reopened = new IncidentStore(file);
  try {
    const a = reopened.authenticate(token);
    assert.deepEqual(reopened.get(a,'project-a','incident',i.incidentId),i);
    assert.equal(reopened.create(a,'incident',incident(w.workflowId,[r.runId]),'i1').replayed,true);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM migrations').get()!.n,2);
  } finally { reopened.close(); }
});

test('foreign and old/future incident schemas are refused before application migration', () => {
  for (const version of ['foreign','old','future']) {
    const file = join(mkdtempSync(join(tmpdir(),'incident-schema-')),'db.sqlite');
    if (version === 'foreign') {
      const db = new DatabaseSync(file);db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES(\'schema\',\'1\')');db.close();
    } else {
      const s = new IncidentStore(file);s.db.exec(`PRAGMA user_version=${version === 'old' ? 0 : 3}`);s.close();
    }
    assert.throws(() => new IncidentStore(file),/NOT_INCIDENT_DATABASE|UNSUPPORTED_DATABASE_SCHEMA/);
    const check = new DatabaseSync(file);
    try { if(version === 'foreign')assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='accounts'").get()!.n,0);else assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,version === 'old' ? 0 : 3); } finally {check.close();}
  }
});

test('same canonical request replays once, changed content conflicts and failed writes roll back all records', () => {
  const {store,actor} = fixture();
  try {
    const first = store.create(actor,'workflow',workflow(),'key');
    const reordered = Object.fromEntries(Object.entries(workflow()).reverse());
    assert.deepEqual(store.create(actor,'workflow',reordered,'key').record,first.record);
    assert.throws(() => store.create(actor,'workflow',{...workflow(),repoRef:'different'},'key'),/IDEMPOTENCY_CONFLICT/);
    store.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit WHEN NEW.action='create_incident' BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
    assert.throws(() => store.create(actor,'incident',incident((first.record as Workflow).workflowId),'rollback'),/injected failure/);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='incident'").get()!.n,0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM requests WHERE key='rollback'").get()!.n,0);
    store.db.exec('DROP TRIGGER fail_audit');
    assert.equal(store.create(actor,'incident',incident((first.record as Workflow).workflowId),'rollback').replayed,false);
  } finally {store.close();}
});

test('scope and live delegated role checks prevent cross-tenant, cross-project and read-only writes', () => {
  const {store,actor} = fixture();
  try {
    const wa = store.create(actor,'workflow',workflow(),'a').record as Workflow;
    const wb = store.create(actor,'workflow',workflow('project-b'),'b').record as Workflow;
    const other = store.authenticate(store.login('other',password).token), fde = store.authenticate(store.login('fde',password).token), viewer = store.authenticate(store.login('viewer',password).token);
    assert.throws(() => store.get(other,'project-a','workflow',wa.workflowId),/NOT_FOUND/);
    assert.throws(() => store.get(fde,'project-b','workflow',wb.workflowId),/NOT_FOUND/);
    assert.throws(() => store.create(fde,'workflow',workflow(),'fde-w'),/ROLE_DENIED/);
    assert.throws(() => store.create(viewer,'incident',incident(wa.workflowId),'view-i'),/ROLE_DENIED/);
    assert.throws(() => store.create(actor,'incident',incident(wb.workflowId),'wrong-project'),/NOT_FOUND/);
    assert.throws(() => store.create(other,'incident',incident(wa.workflowId),'foreign-ref'),/NOT_FOUND/);
    assert.equal((store.create(fde,'incident',incident(wa.workflowId),'fde-i').record as Incident).tenantId,'tenant-a');
    assert.equal(store.list(other,'project-a','workflow').items.length,0);
    store.db.prepare('DELETE FROM grants WHERE actor_id=?').run('fde');
    assert.throws(() => store.list(fde,'project-a','workflow'),/NOT_FOUND/);
  } finally {store.close();}
});

test('incident references require matching workflow and existing same-scope runs/linked incidents', () => {
  const {store,actor} = fixture();
  try {
    const a = store.create(actor,'workflow',workflow(),'a').record as Workflow;
    const b = store.create(actor,'workflow',{...workflow(),repoRef:'second'},'b').record as Workflow;
    const r = store.create(actor,'run',run(b.workflowId),'r').record as AgentRun;
    assert.throws(() => store.create(actor,'incident',incident(a.workflowId,[r.runId]),'i'),/RUN_WORKFLOW_MISMATCH/);
    assert.throws(() => store.create(actor,'incident',incident(a.workflowId,['missing']),'i'),/NOT_FOUND/);
    assert.throws(() => store.create(actor,'incident',{...incident(a.workflowId),linkedIncidentIds:['missing'],groupingReason:'manual link'},'i'),/NOT_FOUND/);
  } finally {store.close();}
});

test('cursor pagination is stable and scope-bound with bounded input', () => {
  const {store,actor} = fixture();
  try {
    for(let n=0;n<3;n++)store.create(actor,'workflow',workflow(),`key-${n}`);
    const page = store.list(actor,'project-a','workflow','0',2);
    assert.equal(page.items.length,2);assert.ok(page.nextCursor);
    const last = store.list(actor,'project-a','workflow',page.nextCursor!,2);
    assert.equal(last.items.length,1);assert.equal(last.nextCursor,null);
    assert.notEqual((page.items[0] as Workflow).workflowId,(last.items[0] as Workflow).workflowId);
    assert.throws(() => store.list(actor,'project-a','workflow','-1'),/INVALID_PAGE/);
    assert.throws(() => store.list(actor,'project-a','workflow','0',101),/INVALID_PAGE/);
  } finally {store.close();}
});

test('logout, expiry, account disable and reprovision invalidate sessions; plaintext credentials are not stored', () => {
  const {store,token} = fixture();
  try {
    assert.throws(() => store.login('admin','wrong'),/AUTH_REQUIRED/);
    assert.throws(() => store.login('absent',password),/AUTH_REQUIRED/);
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM accounts').all()).includes(password));
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM sessions').all()).includes(token));
    store.logout(token);assert.throws(() => store.authenticate(token),/AUTH_REQUIRED/);
    const expired = store.login('admin',password).token;store.db.exec('UPDATE sessions SET expires_at=0');assert.throws(() => store.authenticate(expired),/AUTH_REQUIRED/);
    const disabled = store.login('admin',password).token;store.db.exec("UPDATE accounts SET enabled=0 WHERE actor_id='admin'");assert.throws(() => store.authenticate(disabled),/AUTH_REQUIRED/);
    store.provision('admin','tenant-a',password,[{projectId:'project-a',role:'enterprise_admin'}]);
    assert.throws(() => store.authenticate(disabled),/AUTH_REQUIRED/);
    assert.throws(() => store.provision('admin','tenant-b',password,[]),/ACCOUNT_TENANT_IMMUTABLE/);
  } finally {store.close();}
});

test('actual independent processes race for one idempotent write', async () => {
  const {store,file,token} = fixture();
  const child = () => new Promise<any>((resolveResult,reject) => {
    const p = spawn(process.execPath,['--import','tsx',resolve('tests/incident-child.ts'),file,token,JSON.stringify(workflow())],{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let output='',errors='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>errors+=d);p.on('error',reject);
    p.on('exit',code=>{if(code !== 0)reject(new Error(errors));else try{resolveResult(JSON.parse(output));}catch(e){reject(e);}});
  });
  try {
    const results = await Promise.all([child(),child(),child(),child()]);
    assert.equal(new Set(results.map(r=>r.record.workflowId)).size,1);
    assert.equal(results.filter(r=>!r.replayed).length,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM records').get()!.n,1);
  } finally {store.close();}
});

test('busy store refuses write without partial side effects and succeeds on same-key retry', () => {
  const {store,file,actor} = fixture(), second = new IncidentStore(file);
  try {
    second.db.exec('PRAGMA busy_timeout=1');store.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => second.create(actor,'workflow',workflow(),'busy'),/locked/);
    store.db.exec('ROLLBACK');
    assert.equal(second.create(actor,'workflow',workflow(),'busy').replayed,false);
  } finally {second.close();store.close();}
});

test('HTTP API authenticates, rejects scope injection/duplicates/old schema and enforces roles', async () => {
  const {store} = fixture(), app = createIncidentApp(store);
  const root = '/api/incidents-v1';
  try {
    assert.equal((await app.inject({url:`${root}/workflows?projectId=project-a`})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:`${root}/session`,payload:{actorId:'admin',password},headers:{origin:'https://foreign.example'}})).statusCode,403);
    const login = await app.inject({method:'POST',url:`${root}/session`,payload:{actorId:'admin',password}});
    assert.equal(login.statusCode,200);
    const headers = {authorization:`Bearer ${login.json().token}`,'idempotency-key':'http-key'};
    const created = await app.inject({method:'POST',url:`${root}/workflows`,headers,payload:workflow()});
    assert.equal(created.statusCode,201);assert.equal(created.json().record.tenantId,'tenant-a');
    assert.equal((await app.inject({method:'POST',url:`${root}/workflows`,headers,payload:workflow()})).statusCode,200);
    for(const payload of [{...workflow(),schemaVersion:0},{...workflow(),tenantId:'tenant-b'}])assert.equal((await app.inject({method:'POST',url:`${root}/workflows`,headers,payload})).statusCode,400);
    const duplicate = '{"actorId":"admin","actorId":"other","password":"unused"}';
    assert.equal((await app.inject({method:'POST',url:`${root}/session`,headers:{'content-type':'application/json'},payload:duplicate})).statusCode,400);
    assert.equal((await app.inject({url:`${root}/workflows?projectId=project-a&limit=1e2`,headers})).statusCode,400);
    const viewer = await app.inject({method:'POST',url:`${root}/session`,payload:{actorId:'viewer',password}});
    assert.equal((await app.inject({method:'POST',url:`${root}/workflows`,headers:{...headers,authorization:`Bearer ${viewer.json().token}`},payload:workflow()})).statusCode,403);
    assert.equal((await app.inject({method:'DELETE',url:`${root}/session`,headers})).statusCode,200);
    assert.equal((await app.inject({url:`${root}/session`,headers})).statusCode,401);
  } finally {await app.close();store.close();}
});

test('real loopback HTTP completes workflow/run/incident registration without wallet or RPC', async () => {
  const {store} = fixture(), app = createIncidentApp(store);
  try {
    const address = await app.listen({host:'127.0.0.1',port:0});
    const root = `${address}/api/incidents-v1`;
    const login = await fetch(`${root}/session`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actorId:'admin',password})});
    const session = await login.json() as {token:string};assert.equal(login.status,200);
    const create = async (path: string,payload: unknown,key: string) => {
      const r = await fetch(`${root}/${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${session.token}`,'idempotency-key':key},body:JSON.stringify(payload)});
      assert.equal(r.status,201);return (await r.json() as {record:any}).record;
    };
    const w = await create('workflows',workflow(),'w');
    const r = await create('runs',run(w.workflowId),'r');
    const i = await create('incidents',incident(w.workflowId,[r.runId]),'i');
    const response = await fetch(`${root}/incidents/${i.incidentId}?projectId=project-a`,{headers:{authorization:`Bearer ${session.token}`}});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),i);
    assert.equal(response.headers.get('cache-control'),'no-store');
  } finally {await app.close();store.close();}
});
