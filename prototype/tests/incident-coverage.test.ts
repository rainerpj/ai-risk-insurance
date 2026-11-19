import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './incident-finance-fixture.ts';
import { emptyCoverage,parseCoverage } from '../packages/domain/incident-coverage.ts';
import { IncidentCoverage } from '../packages/service/incident-coverage.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
function setup(){const f=fixture();f.store.provision('reviewer','tenant',f.password,[{projectId:'project',role:'reviewer'}]);return {...f,coverage:new IncidentCoverage(f.store)};}
function input(coverage=emptyCoverage() as any,expectedVersion=0){return {projectId:'project',expectedVersion,coverage};}
function confirmed(ref:string){return {...emptyCoverage(),mode:'confirmed_external',insurerParty:'Synthetic insurer declaration',policyRef:'sample-policy',termsVersion:'v1',confirmationEvidence:[ref]};}
async function exportReport(f:ReturnType<typeof setup>){const draft=(await new IncidentInvestigation(f.store).start(f.actor,f.incident.incidentId,{projectId:'project'},'draft')).report,service=new IncidentReport(f.store),state=service.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:draft.reportId,expectedVersion:0},'publish');const review=service.review({actorId:'reviewer',tenantId:'tenant'},state.report.reportId,{projectId:'project',expectedVersion:1,manifestDigest:state.report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'synthetic account review'},'review');const exported=service.export(f.actor,state.report.reportId,{projectId:'project',expectedVersion:1,reviewId:review.review.reviewId,audienceActorId:'viewer',profile:'redacted_metadata_v1'},'export');return {...exported,service,reportId:state.report.reportId};}
const handoffInput=(exportId:string,version=0)=>({projectId:'project',expectedCoverageVersion:version,exportId,disclosureAccepted:true});
test('N09 strict four-mode schema keeps unknown distinct from zero and rejects contradictory/forged terms',()=>{
 for(const mode of ['none','proposed','local_test'])assert.equal(parseCoverage({...emptyCoverage(),mode}).mode,mode);
 const known={...emptyCoverage(),mode:'proposed',currency:'USD',scale:2,deductible:'0',incidentLimit:'100',share:{numerator:'1',denominator:'2'}};assert.equal(parseCoverage(known).annualLimit,null);
 for(const coverage of [{...emptyCoverage(),mode:['confirmed_external']},{...known,mode:['none']},{...known,incidentLimit:0},{...known,incidentLimit:'-1'},{...known,scale:null},{...known,share:{numerator:'2',denominator:'1'}},{...known,mode:'none'},{...emptyCoverage(),mode:'confirmed_external'},{...known,approved:true}])assert.throws(()=>parseCoverage(coverage));
});
test('N09 append-only registration, version conflict, idempotency and restart preserve all modes and authors',()=>{const f=setup();try{
 assert.equal(f.coverage.get(f.actor,'project',f.incident.incidentId).current.version,0);
 for(const [i,mode] of ['none','proposed','local_test'].entries()){const body=input({...emptyCoverage(),mode},i);const result=f.coverage.put(f.actor,f.incident.incidentId,body,`key-${i}`);assert.equal(result.record.version,i+1);assert.equal(f.coverage.put(f.actor,f.incident.incidentId,body,`key-${i}`).replayed,true);}
 assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input(), 'stale'),/COVERAGE_VERSION_CONFLICT/);
 assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input({...emptyCoverage(),mode:'proposed'}),'key-0'),/IDEMPOTENCY_CONFLICT/);
 const second=new IncidentStore(f.file);try{const result=new IncidentCoverage(second).get(f.actor,'project',f.incident.incidentId);assert.deepEqual(result.history.map(r=>r.coverage.mode),['none','proposed','local_test']);assert.ok(result.history.every(r=>r.actorId==='admin'));}finally{second.close();}
 }finally{f.store.close();}});
test('N09 only enterprise admin can register; cross-tenant and nonexistent evidence rejected',()=>{const f=setup();try{
 for(const actorId of ['viewer','investigator','reviewer'])assert.throws(()=>f.coverage.put({actorId,tenantId:'tenant'},f.incident.incidentId,input(),'deny'),/ROLE_DENIED/);
 assert.throws(()=>f.coverage.get({actorId:'foreign',tenantId:'other'},'project',f.incident.incidentId),/NOT_FOUND/);
 assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input(confirmed('absent/object')),'missing'),/NOT_FOUND/);
 assert.equal(f.coverage.get(f.actor,'project',f.incident.incidentId).history.length,0);
 }finally{f.store.close();}});
test('N09 confirmation binds accepted same-incident originals with digest/trust; synthetic is never authenticity',()=>{const f=setup();try{
 const evidence=f.add('Synthetic external confirmation document'),ref=`${evidence.importId}/${evidence.objectId}`;
 const record=f.coverage.put(f.actor,f.incident.incidentId,input(confirmed(ref)),'confirm').record;assert.equal(record.coverage.mode,'confirmed_external');assert.equal(record.externalAuthenticityVerified,false);assert.equal(record.confirmationChecks[0].trust,'synthetic');assert.equal(record.confirmationChecks[0].sha256,evidence.digest);
 f.store.db.prepare('UPDATE incident_objects SET content=? WHERE id=?').run(Buffer.from('corrupted'),evidence.objectId);
 assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input(confirmed(ref),1),'corrupt'),/STORED_ORIGINAL_CORRUPT/);
 }finally{f.store.close();}});
test('N09 confirmation from another run, quarantined imports or revoked source rejected',()=>{const f=setup();try{
 const evidence=f.add('Synthetic confirmation'),ref=`${evidence.importId}/${evidence.objectId}`,row=f.store.db.prepare('SELECT payload FROM incident_imports WHERE id=?').get(evidence.importId)!;const original=JSON.parse(String(row.payload));
 for(const patch of [{runId:'other-run'},{status:'quarantined'}]){f.store.db.prepare('UPDATE incident_imports SET payload=? WHERE id=?').run(JSON.stringify({...original,...patch}),evidence.importId);assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input(confirmed(ref)),'bad'),/CONFIRMATION_SCOPE_MISMATCH/);}
 f.store.db.prepare('UPDATE incident_imports SET payload=? WHERE id=?').run(JSON.stringify(original),evidence.importId);f.ingest.revokeSource(f.actor,'project','source','synthetic revoke');assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input(confirmed(ref)),'revoked'),/CONFIRMATION_SOURCE_REVOKED/);
 }finally{f.store.close();}});
test('N09 none-mode handoff works without policy/chain; audience, disclosure, immutability and audit enforced',async()=>{const f=setup();try{
 const exp=await exportReport(f),body=handoffInput(exp.exportId);assert.throws(()=>f.coverage.handoff(f.actor,f.incident.incidentId,{...body,disclosureAccepted:false},'bad'),/HANDOFF_DISCLOSURE_REQUIRED/);
 const result=f.coverage.handoff(f.actor,f.incident.incidentId,body,'handoff');assert.equal(f.coverage.handoff(f.actor,f.incident.incidentId,body,'handoff').handoffId,result.handoffId);
 const packet=f.coverage.download({actorId:'viewer',tenantId:'tenant'},'project',result.handoffId);assert.equal(packet.payload.coverage.mode,'none');assert.equal(packet.payload.deliveryStatus,'prepared_only');assert.equal(packet.payload.reportIndex.payload.originalsIncluded,false);
 assert.equal(exp.service.get(f.actor,'project',exp.reportId).status,'reviewed');assert.throws(()=>f.coverage.download({actorId:'reviewer',tenantId:'tenant'},'project',result.handoffId),/EXPORT_AUDIENCE_DENIED/);
 exp.service.revoke(f.actor,exp.exportId,{projectId:'project',reason:'revoked'});assert.throws(()=>f.coverage.download(f.actor,'project',result.handoffId),/EXPORT_REVOKED/);
 }finally{f.store.close();}});
test('N09 confirmed handoff retains unknown limits and evidence references across restart',async()=>{const f=setup();try{
 const ref=f.add('Synthetic policy confirmation');f.coverage.put(f.actor,f.incident.incidentId,input(confirmed(`${ref.importId}/${ref.objectId}`)),'confirmed');const exp=await exportReport(f),result=f.coverage.handoff(f.actor,f.incident.incidentId,handoffInput(exp.exportId,1),'handoff');const reopened=new IncidentStore(f.file);try{const packet=new IncidentCoverage(reopened).download(f.actor,'project',result.handoffId);assert.equal(packet.payload.coverage.annualLimit,null);assert.equal(packet.payload.confirmationChecks[0].dataClass,'synthetic');assert.equal(packet.payload.externalAuthenticityVerified,false);}finally{reopened.close();}
 }finally{f.store.close();}});
test('N09 coverage update invalidates reviewed report and existing handoff; stale version rejects',async()=>{const f=setup();try{
 const exp=await exportReport(f);assert.throws(()=>f.coverage.handoff(f.actor,f.incident.incidentId,handoffInput(exp.exportId,1),'stale'),/COVERAGE_VERSION_CONFLICT/);const result=f.coverage.handoff(f.actor,f.incident.incidentId,handoffInput(exp.exportId),'handoff');f.coverage.put(f.actor,f.incident.incidentId,input({...emptyCoverage(),mode:'proposed'}),'new');assert.throws(()=>f.coverage.download(f.actor,'project',result.handoffId),/REVIEW_NOT_CURRENT/);assert.equal(exp.service.get(f.actor,'project',exp.reportId).status,'invalidated');
 }finally{f.store.close();}});
test('N09 transactional audit failure rolls back coverage version and idempotency key',()=>{const f=setup();try{
 f.store.db.exec("CREATE TRIGGER deny_coverage BEFORE INSERT ON audit WHEN NEW.action='coverage_reference' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");assert.throws(()=>f.coverage.put(f.actor,f.incident.incidentId,input(),'retry'),/synthetic failure/);f.store.db.exec('DROP TRIGGER deny_coverage');assert.equal(f.coverage.put(f.actor,f.incident.incidentId,input(),'retry').record.version,1);
 }finally{f.store.close();}});
test('N09 HTTP requires session and handles registration, handoff, download and logout',async()=>{const f=setup(),app=createIncidentApp(f.store);try{
 const url=`/api/incidents-v1/incidents/${f.incident.incidentId}/coverage`,headers={authorization:`Bearer ${f.token}`,'idempotency-key':'coverage'};assert.equal((await app.inject({method:'PUT',url,payload:input()})).statusCode,401);assert.equal((await app.inject({method:'PUT',url,headers,payload:input()})).statusCode,200);
 const exp=await exportReport(f),created=await app.inject({method:'POST',url:`/api/incidents-v1/incidents/${f.incident.incidentId}/underwriting-handoffs`,headers:{...headers,'idempotency-key':'handoff'},payload:handoffInput(exp.exportId,1)});assert.equal(created.statusCode,201);const download=`/api/incidents-v1/underwriting-handoffs/${created.json().handoffId}?projectId=project`;const response=await app.inject({method:'GET',url:download,headers});assert.equal(response.statusCode,200);assert.match(response.headers['content-disposition']!,/attachment/);assert.equal(response.json().payload.deliveryStatus,'prepared_only');await app.inject({method:'DELETE',url:'/api/incidents-v1/session',headers});assert.equal((await app.inject({method:'GET',url:download,headers})).statusCode,401);
 }finally{await app.close();f.store.close();}});


test('N09 handoff inherits expiry, rejects mismatched incident and corrupt payload',async()=>{const f=setup();try{
 const exp=await exportReport(f);assert.throws(()=>f.coverage.handoff(f.actor,'other-incident',handoffInput(exp.exportId),'wrong'),/REPORT_SCOPE_MISMATCH/);
 const result=f.coverage.handoff(f.actor,f.incident.incidentId,handoffInput(exp.exportId),'handoff');const stored=f.store.db.prepare('SELECT payload FROM records WHERE id=?').get(result.handoffId)!;const modified=JSON.parse(String(stored.payload));modified.payload.coverage.mode='confirmed_external';f.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(modified),result.handoffId);assert.throws(()=>f.coverage.download(f.actor,'project',result.handoffId),/HANDOFF_DIGEST_MISMATCH/);f.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(String(stored.payload),result.handoffId);
 const receipt=JSON.parse(String(f.store.db.prepare('SELECT payload FROM records WHERE id=?').get(exp.exportId)!.payload));receipt.expiresAt='2000-01-01T00:00:00.000Z';f.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(receipt),exp.exportId);assert.throws(()=>f.coverage.download(f.actor,'project',result.handoffId),/EXPORT_EXPIRED/);
 }finally{f.store.close();}});
test('N09 handoff audit failure rolls back package and retry key without invalidating report',async()=>{const f=setup();try{
 const exp=await exportReport(f);f.store.db.exec("CREATE TRIGGER deny_handoff BEFORE INSERT ON audit WHEN NEW.action='underwriting_handoff' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");assert.throws(()=>f.coverage.handoff(f.actor,f.incident.incidentId,handoffInput(exp.exportId),'retry'),/synthetic failure/);assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='underwriting_handoff'").get()!.n,0);assert.equal(f.store.db.prepare("SELECT count(*) n FROM requests WHERE operation='underwriting_handoff'").get()!.n,0);f.store.db.exec('DROP TRIGGER deny_handoff');assert.equal(f.coverage.handoff(f.actor,f.incident.incidentId,handoffInput(exp.exportId),'retry').replayed,false);
 }finally{f.store.close();}});

