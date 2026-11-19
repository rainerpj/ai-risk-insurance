import test from 'node:test';
import assert from 'node:assert/strict';
import { custom } from 'viem';
import { fixture } from './incident-finance-fixture.ts';
import { bridgeSource } from './incident-bridge-fixture.ts';
import { setup } from './chain-helper.ts';
import { IncidentExpense,parseExpense } from '../packages/service/incident-expense.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentApproval } from '../packages/service/incident-approval.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { IncidentClaimBridge } from '../packages/service/incident-claim-bridge.ts';
import { parseRun,parseIncident } from '../packages/domain/incident-schema.ts';
import { parseManifest } from '../packages/service/incident-ingest.ts';
import { Store } from '../packages/service/store.ts';
import { Chain } from '../packages/service/chain.ts';

test('review R1: revoked source remains readable historically but cannot substantiate expenses, approvals or a fresh investigation',async()=>{
 const f=fixture();
 try {
  const invoice=f.add('Synthetic invoice'),payment=f.add('Synthetic payment'),expenses=new IncidentExpense(f.store);
  const input={projectId:'project',expenseId:'fee',expectedVersion:0,category:'restoration',currency:'USDC',scale:6,gross:'5000000',paid:'5000000',duplicate:'0',compensation:'0',recovery:'0',voucherRef:'v',evidenceRefs:[{importId:invoice.importId,objectId:invoice.objectId,kind:'invoice'},{importId:payment.importId,objectId:payment.objectId,kind:'payment'}],verification:'confirmed',reason:'Synthetic regression'};
  expenses.append(f.actor,f.incident.incidentId,input,'fee');
  assert.equal(expenses.summary(f.actor,'project',f.incident.incidentId).totals[0]!.netTotal,'5000000');
  const before=(await new IncidentInvestigation(f.store).start(f.actor,f.incident.incidentId,{projectId:'project'},'before')).report;
  const reports=new IncidentReport(f.store),published=reports.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:before.reportId,expectedVersion:0},'publish');
  f.ingest.revokeSource(f.actor,'project','source','Source withdrawn');
  assert.equal(f.ingest.original(f.actor,'project',invoice.importId,invoice.objectId).content.toString(),'Synthetic invoice');
  assert.throws(()=>f.ingest.usableOriginal(f.actor,'project',invoice.importId,invoice.objectId),/SOURCE_REVOKED/);
  assert.equal(reports.get(f.actor,'project',published.report.reportId).status,'invalidated');
  const summary=expenses.summary(f.actor,'project',f.incident.incidentId);
  assert.equal(summary.totals[0]!.netTotal,null);assert.equal(summary.rows[0]!.countedNet,null);
  assert.ok(summary.rows[0]!.issues.includes('EVIDENCE_UNAVAILABLE'));
  assert.throws(()=>expenses.append(f.actor,f.incident.incidentId,{...input,expectedVersion:1},'revision'),/SOURCE_REVOKED/);
  assert.throws(()=>new IncidentApproval(f.store).create(f.actor,f.run.runId,{projectId:'project',decision:'approved',targetRevision:`sha256:${invoice.digest}`,displayedPayloadRef:{importId:invoice.importId,objectId:invoice.objectId},scope:['deploy'],expiresAt:null},'approval'),/SOURCE_REVOKED/);
  const after=(await new IncidentInvestigation(f.store).start(f.actor,f.incident.incidentId,{projectId:'project'},'after')).report;
  assert.equal(after.status,'draft');assert.equal(after.gaps.length,2);
  assert.ok(after.gaps.every((g:string)=>g.startsWith('unavailable:')));
  assert.ok(!after.catalogue.some((d:any)=>d.id.startsWith('original:')));
  assert.ok(!after.findings.some((v:any)=>v.type==='fact'));
  const reopened=new IncidentStore(f.file);
  try {assert.equal(new IncidentReport(reopened).get(f.actor,'project',published.report.reportId).status,'invalidated');}
  finally {reopened.close();}
 } finally {f.store.close();}
});

test('review R2: malformed finding enum is rejected and string fact still requires an exact extract',async()=>{
 const f=fixture();
 try {
  f.add('The only original statement.');
  for(const [i,type] of [['fact'],[['fact']],null,123,{value:'fact'},'fact','hypothesis'].entries()){
   const investigation=new IncidentInvestigation(f.store,{mode:'stub',name:'enum-regression',generate:async c=>{
    const d=c.catalogue.find(x=>x.id.startsWith('original:'))!;
    const r=c.call('readEvidence',{id:d.id,start:0,end:d.length}) as any;
    return JSON.stringify({findings:[{type,statement:'Statement absent from the original',evidenceRefs:[{id:r.id,start:r.start,end:r.end,quote:r.quote}],counterEvidenceRefs:[]}]});
   }});
   const result=(await investigation.start(f.actor,f.incident.incidentId,{projectId:'project'},`enum-${i}`)).report;
   if(type==='hypothesis')assert.equal(result.status,'draft');
   else {assert.equal(result.status,'failed');assert.equal(result.error,type==='fact'?'FACT_MUST_BE_EXTRACT':'INVALID_FINDING');assert.deepEqual(result.findings,[]);}
  }
 } finally {f.store.close();}
});

test('review R2: incident input enums reject arrays before persisting',async()=>{
 const f=fixture(),app=createIncidentApp(f.store);
 try {
  const {runId,tenantId,createdAt,version,...run}=f.run;
  const {incidentId,declaredAt,status,tenantId:it,createdAt:ic,version:iv,...incident}=f.incident;
  assert.equal(parseRun(run).environment,'synthetic');assert.equal(parseIncident(incident).severity,'low');
  for(const bad of [['synthetic'],[['synthetic']],null,1,{value:'synthetic'}])assert.throws(()=>parseRun({...run,environment:bad}));
  assert.throws(()=>parseIncident({...incident,severity:['low']}));
  const original=f.add('original'),receipt=f.ingest.get(f.actor,'project',original.importId);
  assert.throws(()=>parseManifest({...receipt.manifest,dataClass:['synthetic']}));
  const source=f.ingest.source(f.actor,'project','source'),{revokedAt,revocationReason,...sourceInput}=source;
  assert.throws(()=>f.ingest.registerSource(f.actor,{...sourceInput,sourceId:'array-source',captureMethod:['synthetic']}));
  const expense={projectId:'project',expenseId:'fee',expectedVersion:0,category:'restoration',currency:'USD',scale:2,gross:'0',paid:'0',duplicate:'0',compensation:'0',recovery:'0',voucherRef:'v',evidenceRefs:[],verification:'confirmed',reason:'test'};
  for(const patch of [{category:['restoration']},{verification:['confirmed']},{evidenceRefs:[{importId:original.importId,objectId:original.objectId,kind:['invoice']}]}])assert.throws(()=>parseExpense({...expense,...patch}));
  assert.throws(()=>new IncidentApproval(f.store).create(f.actor,f.run.runId,{projectId:'project',decision:['approved'],targetRevision:`sha256:${original.digest}`,displayedPayloadRef:{importId:original.importId,objectId:original.objectId},scope:['deploy'],expiresAt:null},'bad-approval'));
  const response=await app.inject({method:'POST',url:'/api/incidents-v1/runs',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':'bad-enum'},payload:{...run,environment:['approved_redacted']}});
  assert.equal(response.statusCode,400);assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='run'").get()!.n,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM requests WHERE key='bad-enum'").get()!.n,0);
 } finally {await app.close();f.store.close();}
});

test('review R1/R3: revoked evidence blocks bridge; endAt rejection leaves no mapping or reservation and allows corrected retry',async()=>{
 const c=await setup(),q=await c.issue({annualLimit:10000000n,incidentLimit:10000000n});
 const legacy=new Store(`.local/review-fixed-${c.runId}.sqlite`,`31337:${c.core.address}:${c.salt}`),f=await bridgeSource(q);
 try {
  const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{}),targets=[{tenantId:'tenant',projectId:'project',workflowId:f.workflow.workflowId,policyId:q.quoteId}];
  const bridge=new IncidentClaimBridge(f.store,legacy,chain,targets);
  for(const time of [q.startAt-1n,q.endAt,q.endAt+1n])await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,{...f.input,declaredIncidentAt:String(time)},'retry'),/BRIDGE_TIME_OUTSIDE_POLICY/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='claim_bridge'").get()!.n,0);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM requests WHERE operation='claim_bridge'").get()!.n,0);
  assert.ok(!legacy.getMeta(`incident-bridge:${q.quoteId}`));
  const mapped=await bridge.create(f.actor,f.incident.incidentId,f.input,'retry');assert.equal(mapped.installed,true);
  assert.equal((await bridge.create(f.actor,f.incident.incidentId,f.input,'retry')).mapping.bridgeId,mapped.mapping.bridgeId);
  // Separate source/store: a new report made after revocation must not restore bridge eligibility.
  const g=await bridgeSource(q),other=new Store(`.local/review-revoked-${c.runId}.sqlite`,`31337:${c.core.address}:${c.salt}`);
  try {
   g.ingest.revokeSource(g.actor,'project','source','withdrawn');
   const draft=(await new IncidentInvestigation(g.store).start(g.actor,g.incident.incidentId,{projectId:'project'},'new')).report;
   const reports=new IncidentReport(g.store),published=reports.publish(g.actor,g.incident.incidentId,{projectId:'project',investigationId:draft.reportId,expectedVersion:1},'new');
   const reviewed=reports.review({actorId:'reviewer',tenantId:'tenant'},published.report.reportId,{projectId:'project',expectedVersion:2,manifestDigest:published.report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'Review acknowledges missing evidence'},'new');
   const guarded=new IncidentClaimBridge(g.store,other,chain,[{...targets[0]!,workflowId:g.workflow.workflowId}]);
   await assert.rejects(()=>guarded.create(g.actor,g.incident.incidentId,{...g.input,reportId:published.report.reportId,reviewId:reviewed.review.reviewId},'revoked'),/BRIDGE_EVIDENCE_INCOMPLETE/);
   assert.ok(!other.getMeta(`incident-bridge:${q.quoteId}`));
  } finally {g.store.close();other.close();}
 } finally {f.store.close();legacy.close();await c.connection.close();}
});
