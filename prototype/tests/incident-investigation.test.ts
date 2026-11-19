import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInvestigationCase,type FixedCase } from './incident-investigation-fixture.ts';
import { fixture } from './incident-finance-fixture.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/incident-investigation-cases.json',import.meta.url),'utf8'));
for(const c of corpus.cases as FixedCase[])test(`N07 fixed: ${c.id}`,async()=>{await runInvestigationCase(c);});
test('N07 unknown sequence/chain remains unknown; contradictory event IDs are separately marked conflict',async()=>{
 const f=fixture();try{const event={protocol:'INCIDENT-EVENT-v1',eventId:'event',sourceSequence:null,eventType:'deploy',occurredAt:null,capturedAt:null,previousDigest:null,supersedes:null,versionRefs:[],approvalRef:null};f.add(JSON.stringify(event),'json');const service=new IncidentInvestigation(f.store);const first=(await service.start(f.actor,f.incident.incidentId,{projectId:'project'},'first')).report;assert.equal(first.findings.find((x:any)=>x.evidenceRefs[0].id.startsWith('diagnostics:')).type,'unknown');f.add(JSON.stringify({...event,eventType:'changed'}),'json');const second=(await service.start(f.actor,f.incident.incidentId,{projectId:'project'},'second')).report;assert.equal(second.findings.find((x:any)=>x.evidenceRefs[0].id.startsWith('diagnostics:')).type,'conflict');}finally{f.store.close();}
});
test('N07 HTTP persists draft, replay returns same report, restart and fresh material invalidation',async()=>{
 const f=fixture(),app=createIncidentApp(f.store);try{
 f.add('Synthetic evidence');const url=`/api/incidents-v1/incidents/${f.incident.incidentId}/investigations`,headers={authorization:`Bearer ${f.token}`,'idempotency-key':'one'};
 assert.equal((await app.inject({method:'POST',url,payload:{projectId:'project'}})).statusCode,401);
 const response=await app.inject({method:'POST',url,headers,payload:{projectId:'project'}});assert.equal(response.statusCode,201);const report=response.json().report;
 assert.equal((await app.inject({method:'POST',url,headers,payload:{projectId:'project'}})).json().report.reportId,report.reportId);
 const service=new IncidentInvestigation(f.store);assert.equal(service.get(f.actor,'project',report.reportId).current,true);
 assert.throws(()=>service.get({actorId:'foreign',tenantId:'other'},'project',report.reportId),/NOT_FOUND/);
 f.add('Supplement');assert.equal(service.get(f.actor,'project',report.reportId).current,false);assert.equal(service.get(f.actor,'project',report.reportId).status,'draft');
 await app.close();f.store.close();const reopened=new IncidentStore(f.file);try{const saved=new IncidentInvestigation(reopened).get(f.actor,'project',report.reportId);assert.equal(saved.current,false);assert.deepEqual(saved.findings,report.findings);}finally{reopened.close();}
 }catch(e){await app.close();try{f.store.close();}catch{}throw e;}
});
test('N07 an unfinished persisted job is reported interrupted after its deadline, never silently rerun',async()=>{
 const f=fixture();try{const service=new IncidentInvestigation(f.store),created=await service.start(f.actor,f.incident.incidentId,{projectId:'project'},'job');const saved={...created.report,status:'running',deadlineAt:'2020-01-01T00:00:00.000Z',findings:[]};f.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(saved),saved.reportId);assert.equal(service.get(f.actor,'project',saved.reportId).executionState,'interrupted');assert.equal((await service.start(f.actor,f.incident.incidentId,{projectId:'project'},'job')).replayed,true);}finally{f.store.close();}
});
