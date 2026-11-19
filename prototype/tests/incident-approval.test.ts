import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './incident-finance-fixture.ts';
import { IncidentApproval } from '../packages/service/incident-approval.ts';
import { incidentTimeline,type TimelineEvent } from '../packages/service/incident-timeline.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
function setup(){const f=fixture(),code=f.add('export const version = 1;'),service=new IncidentApproval(f.store),input={projectId:'project',decision:'approved',targetRevision:`sha256:${code.digest}`,displayedPayloadRef:{importId:code.importId,objectId:code.objectId},scope:['deploy'],expiresAt:null};return {...f,code,service,input};}
test('authenticated execution approval binds original bytes, policy, action and one code version; restart and idempotency',async()=>{
 const f=setup(),app=createIncidentApp(f.store);try{
 const response=await app.inject({method:'POST',url:`/api/incidents-v1/runs/${f.run.runId}/approvals`,headers:{authorization:`Bearer ${f.token}`,'idempotency-key':'approve'},payload:f.input});assert.equal(response.statusCode,201);
 const a=response.json().approval;assert.equal(a.actorId,'admin');assert.equal(a.recordingMode,'synthetic');assert.equal(f.service.create(f.actor,f.run.runId,f.input,'approve').replayed,true);
 assert.throws(()=>f.service.create(f.actor,f.run.runId,{...f.input,decision:'rejected'},'approve'),/IDEMPOTENCY_CONFLICT/);
 f.add(JSON.stringify({protocol:'INCIDENT-EVENT-v2',eventId:'deploy',sourceSequence:'1',eventType:'deploy',occurredAt:a.createdAt,capturedAt:a.createdAt,previousDigest:null,supersedes:null,versionRefs:[a.targetRevision],approvalRef:a.approvalId,actionDigest:a.actionDigest}),'json');
 const before=incidentTimeline(f.store,f.actor,'project',f.run.runId);assert.equal(before.events[0]!.approvalCheck.status,'synthetic_binding_matched');
 await app.close();f.store.close();const reopened=new IncidentStore(f.file);try{assert.deepEqual(incidentTimeline(reopened,f.actor,'project',f.run.runId),before);}finally{reopened.close();}
 }catch(e){await app.close();try{f.store.close();}catch{}throw e;}
});
test('approval fails closed on wrong bytes, foreign refs, viewer, wrong scope, expired requests and caller identity injection',()=>{
 const f=setup();try{
 assert.throws(()=>f.service.create(f.actor,f.run.runId,{...f.input,targetRevision:`sha256:${'0'.repeat(64)}`},'bad'),/REVISION_DIGEST_MISMATCH/);
 assert.throws(()=>f.service.create({actorId:'viewer',tenantId:'tenant'},f.run.runId,f.input,'bad'),/ROLE_DENIED/);
 assert.throws(()=>f.service.create({actorId:'foreign',tenantId:'other'},f.run.runId,f.input,'bad'),/NOT_FOUND/);
 assert.throws(()=>f.service.create(f.actor,f.run.runId,{...f.input,scope:['pay']},'bad'),/APPROVAL_SCOPE_DENIED/);
 assert.throws(()=>f.service.create(f.actor,f.run.runId,{...f.input,expiresAt:'2020-01-01T00:00:00.000Z'},'bad'),/APPROVAL_EXPIRED/);
 assert.throws(()=>f.service.create(f.actor,f.run.runId,{...f.input,actorId:'someone'},'bad'),/INVALID_FIELDS/);
 }finally{f.store.close();}
});
test('old revision, action mismatch, rejection, time bounds, wrong run, duplicates and damaged original invalidate binding',()=>{
 const f=setup();try{
 const a=f.service.create(f.actor,f.run.runId,f.input,'good').approval;
 const event:TimelineEvent={eventId:'e',sourceId:'source',sourceSequence:'1',eventType:'deploy',occurredAt:a.createdAt,capturedAt:a.createdAt,receivedAt:a.createdAt,previousDigest:null,supersedes:null,versionRefs:[a.targetRevision],approvalRef:a.approvalId,actionDigest:a.actionDigest,digest:'a'.repeat(64),trust:'synthetic',importId:'i',objectId:'o',row:1,adapter:'event-v1',warnings:[]};
 for(const change of [{versionRefs:['old']},{actionDigest:'0'.repeat(64)},{eventType:'pay'},{occurredAt:null},{occurredAt:'2020-01-01T00:00:00.000Z'},{warnings:['DUPLICATE_EVENT']},{approvalRef:'missing'}])assert.equal(f.service.check(f.actor,f.run,{...event,...change}).status,'invalid');
 assert.equal(f.service.check(f.actor,{...f.run,runId:'other'},event).status,'invalid');
 const rejected=f.service.create(f.actor,f.run.runId,{...f.input,decision:'rejected'},'reject').approval;assert.equal(f.service.check(f.actor,f.run,{...event,approvalRef:rejected.approvalId}).status,'invalid');
 const exp=f.service.create(f.actor,f.run.runId,{...f.input,expiresAt:new Date(Date.now()+60000).toISOString()},'expiry').approval;assert.equal(f.service.check(f.actor,f.run,{...event,approvalRef:exp.approvalId,occurredAt:exp.expiresAt}).status,'invalid');
 f.store.db.prepare('UPDATE incident_objects SET content=? WHERE id=?').run(Buffer.from('damaged'),f.code.objectId);assert.equal(f.service.check(f.actor,f.run,event).status,'invalid');
 }finally{f.store.close();}
});
