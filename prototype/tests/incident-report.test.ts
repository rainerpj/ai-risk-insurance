import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fixture } from './incident-finance-fixture.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
import { verifyRedactedBundle } from '../packages/service/incident-report-export.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { canonicalize } from '../packages/domain/evidence.ts';
import { byteDigest } from '../packages/service/incident-ingest.ts';
async function setup(){const f=fixture();
 f.store.provision('admin','tenant',f.password,[{projectId:'project',role:'enterprise_admin'},{projectId:'project',role:'reviewer'}]);
 for(const id of ['reviewer','reviewer2'])f.store.provision(id,'tenant',f.password,[{projectId:'project',role:'reviewer'}]);
 f.add('SYNTHETIC: password=DO_NOT_EXPORT_SECRET; C:\\private\\secret.txt; /home/private/key; person@example.invalid');
 const draft=(await new IncidentInvestigation(f.store).start(f.actor,f.incident.incidentId,{projectId:'project'},'draft')).report,service=new IncidentReport(f.store);
 const state=service.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:draft.reportId,expectedVersion:0},'publish');
 const reviewer={actorId:'reviewer',tenantId:'tenant'},input={projectId:'project',expectedVersion:1,manifestDigest:state.report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'Synthetic independent account review; no real human judgment asserted'};
 return {...f,draft,service,state,reviewer,input};
}
function accept(f:Awaited<ReturnType<typeof setup>>){return f.service.review(f.reviewer,f.state.report.reportId,f.input,'accept');}
function exportInput(reviewId:string){return {projectId:'project',expectedVersion:1,reviewId,audienceActorId:'viewer',profile:'redacted_metadata_v1'};}
test('N08 report/review/export records do not invalidate their own evidence; versions, review reason and author persist',async()=>{const f=await setup();try{
 assert.equal(f.state.status,'pending_review');assert.equal(new IncidentInvestigation(f.store).get(f.actor,'project',f.draft.reportId).current,true);
 const accepted=accept(f);assert.equal(accepted.state.status,'reviewed');assert.equal(f.service.review(f.reviewer,f.state.report.reportId,f.input,'accept').replayed,true);
 assert.throws(()=>f.service.review(f.reviewer,f.state.report.reportId,{...f.input,reason:'overwrite'},'accept'),/IDEMPOTENCY_CONFLICT/);
 f.store.close();const reopened=new IncidentStore(f.file);try{const state=new IncidentReport(reopened).get(f.actor,'project',f.state.report.reportId);assert.equal(state.status,'reviewed');assert.equal(state.report.authorId,'admin');assert.equal(state.review!.reason,f.input.reason);}finally{reopened.close();}
 }catch(e){try{f.store.close();}catch{}throw e;}});
test('N08 dual-role author cannot self-review; viewer, wrong version, wrong digest, foreign tenant and forged fields rejected',async()=>{const f=await setup();try{
 assert.throws(()=>f.service.review(f.actor,f.state.report.reportId,f.input,'self'),/SELF_REVIEW_DENIED/);
 assert.throws(()=>f.service.review({actorId:'viewer',tenantId:'tenant'},f.state.report.reportId,f.input,'viewer'),/ROLE_DENIED/);
 assert.throws(()=>f.service.get({actorId:'foreign',tenantId:'other'},'project',f.state.report.reportId),/NOT_FOUND/);
 for(const patch of [{expectedVersion:2},{manifestDigest:'0'.repeat(64)}])assert.throws(()=>f.service.review(f.reviewer,f.state.report.reportId,{...f.input,...patch},'bad'),/REPORT_NOT_CURRENT/);
 assert.throws(()=>f.service.review(f.reviewer,f.state.report.reportId,{...f.input,actorId:'admin'},'forged'),/INVALID_FIELDS/);
 }finally{f.store.close();}});
test('N08 new report version supersedes old review and blocks existing downloads',async()=>{const f=await setup();try{
 const accepted=accept(f),exp=f.service.export(f.actor,f.state.report.reportId,exportInput(accepted.review.reviewId),'export');
 const newer=f.service.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:f.draft.reportId,expectedVersion:1},'v2');assert.equal(newer.report.version,2);
 assert.equal(f.service.get(f.actor,'project',f.state.report.reportId).status,'invalidated');
 assert.throws(()=>f.service.review(f.reviewer,f.state.report.reportId,f.input,'old'),/REPORT_NOT_CURRENT/);
 assert.throws(()=>f.service.download(f.actor,'project',exp.exportId),/REVIEW_NOT_CURRENT/);
 assert.throws(()=>f.service.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:f.draft.reportId,expectedVersion:1},'stale'),/REPORT_VERSION_CONFLICT/);
 }finally{f.store.close();}});
test('N08 supplements invalidate review/export and stale drafts cannot publish',async()=>{const f=await setup();try{
 const accepted=accept(f),exp=f.service.export(f.actor,f.state.report.reportId,exportInput(accepted.review.reviewId),'export');f.add('new material');
 assert.throws(()=>f.service.download(f.actor,'project',exp.exportId),/REVIEW_NOT_CURRENT/);
 const state=f.service.get(f.actor,'project',f.state.report.reportId);assert.equal(state.invalidation.reason,'EVIDENCE_CHANGED');assert.equal(state.review!.decision,'accepted');
 assert.throws(()=>f.service.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:f.draft.reportId,expectedVersion:1},'stale'),/DRAFT_NOT_CURRENT/);
 }finally{f.store.close();}});
test('N08 changes-requested review blocks export; optimistic review race retains original opinions',async()=>{const f=await setup();try{
 const changed=f.service.review(f.reviewer,f.state.report.reportId,{...f.input,decision:'changes_requested'},'changes');assert.equal(changed.state.status,'changes_requested');
 assert.throws(()=>f.service.export(f.actor,f.state.report.reportId,exportInput(changed.review.reviewId),'bad'),/REVIEW_NOT_CURRENT/);
 assert.throws(()=>f.service.review({actorId:'reviewer2',tenantId:'tenant'},f.state.report.reportId,f.input,'race'),/REVIEW_VERSION_CONFLICT/);
 const accepted=f.service.review({actorId:'reviewer2',tenantId:'tenant'},f.state.report.reportId,{...f.input,expectedReviewId:changed.review.reviewId},'second');assert.equal(accepted.state.status,'reviewed');assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='report_review'").get()!.n,2);
 }finally{f.store.close();}});
test('N08 metadata export omits secrets paths identities quotations and original bytes; offline tampering fails',async()=>{const f=await setup();try{
 const accepted=accept(f),input=exportInput(accepted.review.reviewId),exp=f.service.export(f.actor,f.state.report.reportId,input,'export');assert.equal(f.service.export(f.actor,f.state.report.reportId,input,'export').exportId,exp.exportId);
 const bundle=f.service.download({actorId:'viewer',tenantId:'tenant'},'project',exp.exportId);assert.equal(verifyRedactedBundle(bundle).valid,true);const json=JSON.stringify(bundle);
 for(const forbidden of ['DO_NOT_EXPORT_SECRET','private','example.invalid',f.actor.actorId,f.state.report.reportId,f.draft.reportId,f.input.reason])assert.ok(!json.includes(forbidden),forbidden);
 assert.equal(bundle.payload.originalsIncluded,false);assert.ok(bundle.payload.manifest.length>0);assert.equal(bundle.payload.reviewDecision,'accepted');
 const bad=structuredClone(bundle);bad.payload.reportVersion++;assert.throws(()=>verifyRedactedBundle(bad),/EXPORT_DIGEST_MISMATCH/);
 const reference=structuredClone(bundle);reference.payload.findings[0].evidenceRefs[0].documentId='document-999999';reference.payloadSha256=byteDigest(canonicalize(JSON.stringify(reference.payload)));assert.throws(()=>verifyRedactedBundle(reference),/INVALID_EXPORT_REFERENCE/);
 const field=structuredClone(bundle);field.payload.secret='leak';field.payloadSha256=byteDigest(canonicalize(JSON.stringify(field.payload)));assert.throws(()=>verifyRedactedBundle(field),/INVALID_FIELDS/);
 }finally{f.store.close();}});
test('N08 export audience, expiry, revocation and reviewer revocation are checked on each access',async()=>{const f=await setup();try{
 const accepted=accept(f),input=exportInput(accepted.review.reviewId),exp=f.service.export(f.actor,f.state.report.reportId,input,'export');
 assert.throws(()=>f.service.download(f.reviewer,'project',exp.exportId),/EXPORT_AUDIENCE_DENIED/);
 f.service.revoke(f.actor,exp.exportId,{projectId:'project',reason:'withdraw'});assert.throws(()=>f.service.download(f.actor,'project',exp.exportId),/EXPORT_REVOKED/);
 const expired=f.service.export(f.actor,f.state.report.reportId,input,'expire'),row=f.store.db.prepare('SELECT payload FROM records WHERE id=?').get(expired.exportId)!;const receipt=JSON.parse(String(row.payload));receipt.expiresAt='2020-01-01T00:00:00.000Z';f.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(receipt),expired.exportId);assert.throws(()=>f.service.download(f.actor,'project',expired.exportId),/EXPORT_EXPIRED/);
 const valid=f.service.export(f.actor,f.state.report.reportId,input,'valid');f.store.db.prepare('DELETE FROM grants WHERE actor_id=?').run('reviewer');assert.throws(()=>f.service.download(f.actor,'project',valid.exportId),/REVIEW_NOT_CURRENT/);f.store.db.prepare('INSERT INTO grants VALUES(?,?,?)').run('reviewer','project','reviewer');assert.equal(f.service.get(f.actor,'project',f.state.report.reportId).status,'invalidated');
 }finally{f.store.close();}});
test('N08 review audit failure rolls back record and idempotency key',async()=>{const f=await setup();try{
 f.store.db.exec("CREATE TRIGGER fail_review BEFORE INSERT ON audit WHEN NEW.action='report_review' BEGIN SELECT RAISE(ABORT,'injected'); END;");assert.throws(()=>accept(f),/injected/);assert.equal(f.service.get(f.actor,'project',f.state.report.reportId).status,'pending_review');assert.equal(f.store.db.prepare("SELECT count(*) n FROM requests WHERE operation='report_review'").get()!.n,0);
 }finally{f.store.close();}});
test('N08 HTTP multiple authenticated roles complete review and download, unauthenticated and stale downloads fail',async()=>{const f=await setup(),app=createIncidentApp(f.store);try{
 const admin=f.store.login('admin',f.password).token,reviewer=f.store.login('reviewer',f.password).token,viewer=f.store.login('viewer',f.password).token;
 const review=await app.inject({method:'POST',url:`/api/incidents-v1/reports/${f.state.report.reportId}/reviews`,headers:{authorization:`Bearer ${reviewer}`,'idempotency-key':'http-review'},payload:f.input});assert.equal(review.statusCode,200);
 const exp=await app.inject({method:'POST',url:`/api/incidents-v1/reports/${f.state.report.reportId}/exports`,headers:{authorization:`Bearer ${admin}`,'idempotency-key':'http-export'},payload:exportInput(review.json().review.reviewId)});assert.equal(exp.statusCode,201);
 const url=`/api/incidents-v1/report-exports/${exp.json().exportId}?projectId=project`;assert.equal((await app.inject({url})).statusCode,401);const download=await app.inject({url,headers:{authorization:`Bearer ${viewer}`}});assert.equal(download.statusCode,200);assert.match(String(download.headers['content-disposition']),/attachment/);assert.equal(verifyRedactedBundle(download.json()).valid,true);
 f.store.logout(viewer);assert.equal((await app.inject({url,headers:{authorization:`Bearer ${viewer}`}})).statusCode,401);f.add('late');assert.equal((await app.inject({url,headers:{authorization:`Bearer ${admin}`}})).statusCode,409);
 assert.ok(Number(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action='download_report_export'").get()!.n)>0);
 }finally{await app.close();f.store.close();}});
test('N08 separate processes racing the same review version yield exactly one accepted review',async()=>{const f=await setup();try{
 const child=(actor:string)=>new Promise<{code:number|null;out:string}>((res,rej)=>{const p=spawn(process.execPath,['--import','tsx',resolve('tests/incident-review-child.ts'),f.file,f.state.report.reportId,f.state.report.evidenceManifestDigest,actor],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.on('error',rej);p.on('exit',code=>res({code,out}));});
 const results=await Promise.all([child('reviewer'),child('reviewer2')]);assert.deepEqual(results.map(r=>r.code).sort(),[0,2]);assert.ok(results.some(r=>r.out.includes('REVIEW_VERSION_CONFLICT')));assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='report_review'").get()!.n,1);
 }finally{f.store.close();}});

test('N08 corrupted stored bundle cannot be downloaded',async()=>{const f=await setup();try{
 const reviewed=accept(f),receipt=f.service.export(f.actor,f.state.report.reportId,exportInput(reviewed.review.reviewId),'export');
 const row=f.store.db.prepare('SELECT payload FROM records WHERE id=?').get(receipt.exportId)!;const value=JSON.parse(String(row.payload));value.bundle.payload.reportVersion=99;
 f.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(value),receipt.exportId);
 assert.throws(()=>f.service.download(f.actor,'project',receipt.exportId),/EXPORT_DIGEST_MISMATCH/);
 }finally{f.store.close();}});
