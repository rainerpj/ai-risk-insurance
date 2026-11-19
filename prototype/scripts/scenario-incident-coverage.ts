import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { fixture } from '../tests/incident-finance-fixture.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { emptyCoverage } from '../packages/domain/incident-coverage.ts';
import { canonicalize } from '../packages/domain/evidence.ts';
import { byteDigest } from '../packages/service/incident-ingest.ts';
import { verifyRedactedBundle } from '../packages/service/incident-report-export.ts';
const runId=randomUUID(),results=[];
for(const mode of ['none','confirmed_external'] as const){
 const f=fixture();f.store.provision('reviewer','tenant',f.password,[{projectId:'project',role:'reviewer'}]);const app=createIncidentApp(f.store);
 try{
  const address=await app.listen({host:'127.0.0.1',port:0});
  const request=async(path:string,method='GET',body?:unknown,token?:string,key?:string)=>{const response=await fetch(`${address}/api/incidents-v1${path}`,{method,signal:AbortSignal.timeout(10000),headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`} :{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json() as any};};
  const tokens:Record<string,string>={};for(const actorId of ['admin','reviewer','viewer']){const login=await request('/session','POST',{actorId,password:f.password});assert.equal(login.status,200);tokens[actorId]=login.body.token;}
  const coverage=emptyCoverage() as any;if(mode==='confirmed_external'){const evidence=f.add('SYNTHETIC confirmation fixture only. No real insurance policy.');Object.assign(coverage,{mode,insurerParty:'Synthetic insurance party',policyRef:'synthetic-policy',termsVersion:'v1',confirmationEvidence:[`${evidence.importId}/${evidence.objectId}`]});}
  const registered=await request(`/incidents/${f.incident.incidentId}/coverage`,'PUT',{projectId:'project',expectedVersion:0,coverage},tokens.admin,'coverage');assert.equal(registered.status,200);assert.equal(registered.body.record.externalAuthenticityVerified,false);
  const drafted=await request(`/incidents/${f.incident.incidentId}/investigations`,'POST',{projectId:'project'},tokens.admin,'draft');assert.equal(drafted.status,201);
  const published=await request(`/incidents/${f.incident.incidentId}/reports`,'POST',{projectId:'project',investigationId:drafted.body.report.reportId,expectedVersion:0},tokens.admin,'publish');assert.equal(published.status,201);const report=published.body.report;
  const reviewed=await request(`/reports/${report.reportId}/reviews`,'POST',{projectId:'project',expectedVersion:1,manifestDigest:report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'Separate synthetic test account, not independent human underwriting.'},tokens.reviewer,'review');assert.equal(reviewed.status,200);
  const exported=await request(`/reports/${report.reportId}/exports`,'POST',{projectId:'project',expectedVersion:1,reviewId:reviewed.body.review.reviewId,audienceActorId:'viewer',profile:'redacted_metadata_v1'},tokens.admin,'export');assert.equal(exported.status,201);
  const handoff=await request(`/incidents/${f.incident.incidentId}/underwriting-handoffs`,'POST',{projectId:'project',expectedCoverageVersion:1,exportId:exported.body.exportId,disclosureAccepted:true},tokens.admin,'handoff');assert.equal(handoff.status,201);
  const route=`/underwriting-handoffs/${handoff.body.handoffId}?projectId=project`,download=await request(route,'GET',undefined,tokens.viewer);assert.equal(download.status,200);assert.equal(download.body.payload.coverage.mode,mode);assert.equal(download.body.payload.coverage.annualLimit,null);assert.equal(download.body.payload.deliveryStatus,'prepared_only');assert.equal(byteDigest(canonicalize(JSON.stringify(download.body.payload))),download.body.payloadSha256);verifyRedactedBundle(download.body.payload.reportIndex);
  mkdirSync('reports',{recursive:true});const packetPath=`reports/incident-n09-${mode}-${runId}.json`;writeFileSync(packetPath,JSON.stringify(download.body,null,2));
  assert.equal((await request(route,'GET',undefined,tokens.reviewer)).status,403);await request('/session','DELETE',undefined,tokens.viewer);assert.equal((await request(route,'GET',undefined,tokens.viewer)).status,401);
  const revised=await request(`/incidents/${f.incident.incidentId}/coverage`,'PUT',{projectId:'project',expectedVersion:1,coverage:{...emptyCoverage(),mode:'proposed'}},tokens.admin,'revise');assert.equal(revised.status,200);assert.equal((await request(route,'GET',undefined,tokens.admin)).status,409);
  for(const actorId of ['admin','reviewer'])await request('/session','DELETE',undefined,tokens[actorId]);results.push({mode,status:'passed',packetPath,unauthorizedDenied:true,loggedOutDenied:true,coverageChangeDenied:true,externalAuthenticityVerified:false,externalDelivery:false});
 }finally{await app.close();f.store.close();}
}
const proof=`reports/incident-n09-scenario-${runId}.json`;writeFileSync(proof,JSON.stringify({runId,scope:'synthetic-real-loopback-http',results},null,2));console.log(proof);
