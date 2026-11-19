import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from '../tests/incident-finance-fixture.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
const f=fixture(),runId=randomUUID();f.store.provision('reviewer','tenant',f.password,[{projectId:'project',role:'reviewer'}]);f.add('Synthetic confidential note: password=DO_NOT_EXPORT_SECRET at C:\\private\\sample.txt');
const app=createIncidentApp(f.store);let closed=false;
try{
 const address=await app.listen({host:'127.0.0.1',port:0});
 const request=async(path:string,method='GET',body?:unknown,token?:string,key?:string)=>{const response=await fetch(`${address}/api/incidents-v1${path}`,{method,signal:AbortSignal.timeout(10000),headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`} :{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json() as any};};
 const tokens:Record<string,string>={};for(const id of ['admin','reviewer','viewer']){const login=await request('/session','POST',{actorId:id,password:f.password});assert.equal(login.status,200);tokens[id]=login.body.token;}
 const drafted=await request(`/incidents/${f.incident.incidentId}/investigations`,'POST',{projectId:'project'},tokens.admin,'draft');assert.equal(drafted.status,201);
 const published=await request(`/incidents/${f.incident.incidentId}/reports`,'POST',{projectId:'project',investigationId:drafted.body.report.reportId,expectedVersion:0},tokens.admin,'publish');assert.equal(published.status,201);const report=published.body.report;
 const reviewed=await request(`/reports/${report.reportId}/reviews`,'POST',{projectId:'project',expectedVersion:1,manifestDigest:report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'Synthetic review by separate test account; no actual independent human adjudication.'},tokens.reviewer,'review');assert.equal(reviewed.body.state.status,'reviewed');
 const exported=await request(`/reports/${report.reportId}/exports`,'POST',{projectId:'project',expectedVersion:1,reviewId:reviewed.body.review.reviewId,audienceActorId:'viewer',profile:'redacted_metadata_v1'},tokens.admin,'export');assert.equal(exported.status,201);
 const route=`/report-exports/${exported.body.exportId}?projectId=project`,download=await request(route,'GET',undefined,tokens.viewer);assert.equal(download.status,200);assert.ok(!JSON.stringify(download.body).includes('DO_NOT_EXPORT_SECRET'));
 mkdirSync('reports',{recursive:true});const bundlePath=resolve('reports',`incident-n08-export-${runId}.json`);writeFileSync(bundlePath,JSON.stringify(download.body,null,2));
 const verifier=await new Promise<{code:number|null;output:string}>((res,rej)=>{const child=spawn(process.execPath,['--import','tsx',resolve('scripts/verify-incident-export.ts'),bundlePath],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',rej);child.on('exit',code=>res({code,output}));});assert.equal(verifier.code,0,verifier.output);assert.equal(JSON.parse(verifier.output).originalBytesVerified,false);
 assert.equal((await request(route,'GET',undefined,tokens.reviewer)).status,403);await request('/session','DELETE',undefined,tokens.viewer);assert.equal((await request(route,'GET',undefined,tokens.viewer)).status,401);
 f.add('Synthetic new evidence');assert.equal((await request(route,'GET',undefined,tokens.admin)).status,409);
 for(const id of ['admin','reviewer'])await request('/session','DELETE',undefined,tokens[id]);await app.close();f.store.close();closed=true;
 const reopened=new IncidentStore(f.file);try{const current=new IncidentReport(reopened).get(f.actor,'project',report.reportId);assert.equal(current.status,'invalidated');assert.equal(current.review!.reason,reviewed.body.review.reason);}finally{reopened.close();}
 const proofPath=`reports/incident-n08-scenario-${runId}.json`;writeFileSync(proofPath,JSON.stringify({runId,status:'passed',scope:'synthetic-real-loopback-http-and-offline-verifier',reportId:report.reportId,bundlePath,reviewerIsSeparateTestAccount:true,independentHumanAdjudication:false,originalsIncluded:false,offlineVerifier:JSON.parse(verifier.output),audienceDenied:true,loggedOutDenied:true,newMaterialDenied:true,restartInvalidationPreserved:true},null,2));console.log(proofPath);
}finally{if(!closed){await app.close();f.store.close();}}
