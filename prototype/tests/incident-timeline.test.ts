import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeEvents,incidentTimeline,type TimelineEvent } from '../packages/service/incident-timeline.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentIngest,byteDigest,type ImportBundle } from '../packages/service/incident-ingest.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import type { Workflow,AgentRun } from '../packages/domain/incident-schema.ts';
import { runCodingExperiment } from '../packages/service/coding-experiment.ts';
const t='2026-01-01T00:00:00.000Z',later='2026-01-02T00:00:00.000Z';
const event=(id:string,extra:Partial<TimelineEvent>={}):TimelineEvent=>({eventId:id,sourceId:'source',sourceSequence:'1',eventType:'test',occurredAt:t,capturedAt:t,receivedAt:later,previousDigest:null,supersedes:null,versionRefs:[],approvalRef:null,digest:'a'.repeat(64),trust:'synthetic',importId:'import',objectId:id,row:1,adapter:'event-v1',warnings:[],...extra});
test('stable order retains duplicates, conflicts and distinct sources',()=>{const input=[event('a'),event('a',{digest:'b'.repeat(64)}),event('a',{sourceId:'other'})];const out=analyzeEvents(input);assert.ok(out.filter(e=>e.sourceId==='source').every(e=>e.warnings.includes('EVENT_ID_CONFLICT')));assert.ok(!out.find(e=>e.sourceId==='other')!.warnings.includes('EVENT_ID_CONFLICT'));assert.deepEqual(input[0]!.warnings,[]);assert.ok(analyzeEvents([event('a'),event('a')])[0]!.warnings.includes('DUPLICATE_EVENT'));});
test('sequence gaps, huge sequence numbers and digest mismatch are explicit',()=>{const out=analyzeEvents([event('a'),event('b',{sourceSequence:'2',previousDigest:'b'.repeat(64)}),event('c',{sourceSequence:'999999999999999999999'})]);assert.ok(out[1]!.warnings.includes('CHAIN_MISMATCH'));assert.ok(out[2]!.warnings.includes('SEQUENCE_GAP'));assert.ok(!analyzeEvents([event('a'),event('b',{sourceSequence:'2',previousDigest:'a'.repeat(64)})])[1]!.warnings.includes('CHAIN_MISMATCH'));});
test('clock conflict, source reversal and late arrival preserve source times',()=>{const out=analyzeEvents([event('a',{occurredAt:later,capturedAt:t,receivedAt:t}),event('b',{sourceSequence:'2'})]);assert.ok(out.find(e=>e.eventId==='a')!.warnings.includes('CLOCK_CONFLICT'));assert.ok(out.find(e=>e.eventId==='b')!.warnings.includes('SOURCE_CLOCK_REVERSED'));assert.ok(out.find(e=>e.eventId==='b')!.warnings.includes('LATE_ARRIVAL'));});
test('corrections retain originals and detect missing targets and cycles',()=>{const out=analyzeEvents([event('a'),event('b',{supersedes:'a'}),event('c',{supersedes:'missing'})]);assert.ok(out[0]!.warnings.includes('HAS_CORRECTION'));assert.ok(out[2]!.warnings.includes('CORRECTION_TARGET_MISSING'));assert.ok(analyzeEvents([event('a',{supersedes:'b'}),event('b',{supersedes:'a'})]).every(e=>e.warnings.includes('CORRECTION_CYCLE')));});
test('HTTP timeline parses immutable imports, preserves quarantine, isolates tenants and survives restart',async()=>{
 const file=join(mkdtempSync(join(tmpdir(),'n05-')),'incident.sqlite');let store=new IncidentStore(file);const password='synthetic-test-password';
 store.provision('admin','tenant',password,[{projectId:'project',role:'enterprise_admin'}]);store.provision('foreign','foreign',password,[{projectId:'project',role:'viewer'}]);
 const token=store.login('admin',password).token,actor=store.authenticate(token),ingest=new IncidentIngest(store);
 const w=store.create(actor,'workflow',{schemaVersion:1,projectId:'project',enterpriseId:'enterprise',fdePartyId:null,repoRef:'fixture',allowedActions:['test'],approvalPolicyVersion:'v1',dataAuthorizationRef:'auth'},'w').record as Workflow;
 const r=store.create(actor,'run',{schemaVersion:1,projectId:'project',workflowId:w.workflowId,taskRef:'test',agentProvider:null,modelVersion:null,toolVersions:{},baseRevision:null,resultRevision:null,startedAt:null,endedAt:null,captureCoverage:{collected:[],missing:['human-approval']},environment:'synthetic'},'r').record as AgentRun;
 ingest.registerSource(actor,{schemaVersion:1,projectId:'project',sourceId:'source',controllerPartyId:'fixture',kind:'test',allowedWorkflowIds:[w.workflowId],captureMethod:'synthetic',keyId:null,publicKey:null,validFrom:t,validUntil:null});
 const raw={protocol:'INCIDENT-EVENT-v1',eventId:'e',sourceSequence:'1',eventType:'test',occurredAt:t,capturedAt:t,previousDigest:null,supersedes:null,versionRefs:['sha256:example'],approvalRef:null};
 const content=Buffer.from(JSON.stringify([raw,{...raw,eventId:'bad',occurredAt:'invalid'}]));
 const descriptor={objectId:'events',path:'events.json',sourceId:'source',mediaType:'application/json' as const,byteLength:content.length,sha256:byteDigest(content),signature:null};
 const bundle:ImportBundle={manifest:{schemaVersion:1,projectId:'project',packageId:'package',runId:r.runId,dataAuthorizationRef:'auth',dataClass:'synthetic',supersedesImportId:null,objects:[descriptor,{...descriptor,objectId:'missing',path:'missing.json'}]},objects:[{path:'events.json',contentBase64:content.toString('base64')}]};
 ingest.import(actor,bundle,'import');const expected=incidentTimeline(store,actor,'project',r.runId);assert.equal(expected.events.length,1);assert.ok(expected.materials.some(m=>m.status==='invalid-event'));assert.ok(expected.materials.some(m=>m.status==='missing'));assert.equal(expected.imports[0]!.status,'quarantined');
 store.close();store=new IncidentStore(file);const app=createIncidentApp(store);try{
 assert.deepEqual(incidentTimeline(store,actor,'project',r.runId),expected);
 const url=`/api/incidents-v1/runs/${r.runId}/timeline?projectId=project`;
 assert.equal((await app.inject({url})).statusCode,401);
 assert.equal((await app.inject({url,headers:{authorization:`Bearer ${store.login('foreign',password).token}`}})).statusCode,404);
 assert.deepEqual((await app.inject({url,headers:{authorization:`Bearer ${token}`}})).json(),expected);
 assert.equal((await app.inject({url:'/incidents'})).statusCode,200);
 store.db.prepare('UPDATE incident_objects SET content=? WHERE id=?').run(Buffer.from('corrupt'),'events');assert.ok(incidentTimeline(store,actor,'project',r.runId).materials.some(m=>m.status==='unavailable-or-corrupt'));
 }finally{await app.close();store.close();}
});
test('N04 experiment packages expose actual observations without invented approvals',async()=>{
 const report=await runCodingExperiment(mkdtempSync(join(tmpdir(),'n05-experiment-')));
 const store=new IncidentStore(join(report.directory,'incidents.sqlite'));
 try{for(const scenario of report.scenarios){const out=incidentTimeline(store,{actorId:'experiment-admin',tenantId:'experiment-tenant'},'experiment-project',scenario.runId);assert.equal(out.events.length,scenario.scenario==='accident'?6:5);assert.ok(out.events.every(e=>e.trust==='synthetic'&&e.approvalRef===null));assert.ok(out.missingCapture.includes('independent-human-revision-approval'));assert.equal(out.events.some(e=>e.eventType==='rollback'),scenario.scenario==='accident');}}finally{store.close();}
});
