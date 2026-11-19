import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fixture } from './incident-finance-fixture.ts';
import { bridgeSource } from './incident-bridge-fixture.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
import { IncidentRoi } from '../packages/service/incident-roi.ts';
import { roiFixture } from './incident-roi-fixture.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';

test('R4 invalid event rows survive as referenced investigation gaps and reviewed report warnings',async()=>{
 const f=await bridgeSource({quoteId:'0x'+'a'.repeat(64),termsHash:'0x'+'b'.repeat(64),incidentLimit:10000000n,annualLimit:10000000n});
 try {
  const event={protocol:'INCIDENT-EVENT-v2',eventId:'bad-event',sourceSequence:'1',eventType:'deploy',occurredAt:'invalid-time',capturedAt:null,previousDigest:null,supersedes:null,versionRefs:[],approvalRef:null,actionDigest:'c'.repeat(64)};
  const ref=f.add(JSON.stringify([event,{...event,eventId:'bad-two'}]),'json');
  const service=new IncidentInvestigation(f.store),report=(await service.start(f.actor,f.incident.incidentId,{projectId:'project'},'invalid-event')).report;
  assert.equal(report.status,'draft');assert.equal(report.gaps.length,2);
  for(const row of [1,2])assert.ok(report.gaps.includes(`invalid-event:${ref.importId}/${ref.objectId}:row ${row}`));
  const finding=report.findings.find((v:any)=>v.statement.includes('部分事件无法解析'));
  assert.equal(finding.type,'unknown');assert.ok(finding.evidenceRefs[0].id.startsWith('material-diagnostics:'));
  const document=report.derivedSnapshot.find((d:any)=>d.id===finding.evidenceRefs[0].id);
  assert.equal(document.content.slice(finding.evidenceRefs[0].start,finding.evidenceRefs[0].end),finding.evidenceRefs[0].quote);
  const reports=new IncidentReport(f.store),published=reports.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:report.reportId,expectedVersion:1},'warning-report');
  assert.deepEqual(published.report.snapshot.gaps,report.gaps);
 } finally {f.store.close();}
});

function dom(){
 const elements=new Map<string,any>();
 const make=()=>({value:'',textContent:'',hidden:false,disabled:false,selected:false,children:[] as any[],style:{},get options(){return this.children;},get selectedOptions(){return this.children.filter((o:any)=>o.selected);},append(...children:any[]){this.children.push(...children);},replaceChildren(...children:any[]){this.children=children;}});
 const get=(id:string)=>{if(!elements.has(id))elements.set(id,make());return elements.get(id);};
 return {get,document:{getElementById:get,createElement:make}};
}
const flush=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
test('R5 expense reason-only edit preserves every reference; explicit removal and fresh entry work',async()=>{
 const d=dom(),writes:any[]=[];
 const line={expenseId:'fee',version:1,category:'restoration',currency:'USD',scale:2,gross:'1000',paid:'1000',duplicate:'0',compensation:'0',recovery:'0',voucherRef:'v',verification:'confirmed',reason:'Original reason',evidenceRefs:[{importId:'batch-a',objectId:'invoice-a',kind:'invoice'},{importId:'batch-b',objectId:'invoice-b',kind:'invoice'},{importId:'batch-c',objectId:'payment',kind:'payment'}]};
 const context:any={document:d.document,sessionStorage:{getItem:(k:string)=>k==='incident-session'?'test-token':null,removeItem(){}},crypto:{randomUUID},fetch:async(url:string,options:any)=>{
  if(options.method==='POST'){writes.push(JSON.parse(options.body));return {ok:true,json:async()=>({})};}
  if(url.includes('/expenses?'))return {ok:true,json:async()=>({totals:[],rows:[],history:[]})};
  return {ok:true,json:async()=>({runIds:[],statement:'synthetic'})};
 },line};
 // Exercise the actual page edit/save handlers; absent options model revoked/historical references.
 runInNewContext(readFileSync('web/incident-expenses.js','utf8')+'\nincident="incident"; edit(line);globalThis.reedit=()=>{incident="incident";edit(line);};',context);
 d.get('project').value='project';d.get('reason').value='Only changed the reason';
 d.get('expense').onsubmit({preventDefault(){}});await flush();
 assert.deepEqual(writes[0].evidenceRefs,line.evidenceRefs);assert.equal(writes[0].expectedVersion,1);
 context.reedit();d.get('invoice-ref').options[1].selected=false;
 d.get('expense').onsubmit({preventDefault(){}});await flush();
 assert.deepEqual(writes[1].evidenceRefs,[line.evidenceRefs[0],line.evidenceRefs[2]]);
 context.reedit();d.get('new').onclick();
 for(const kind of ['invoice','payment','compensation','recovery'])assert.equal(d.get(kind+'-ref').selectedOptions.length,0);
 for(const kind of ['invoice','payment','compensation','recovery'])assert.ok(readFileSync('web/incident-expenses.html','utf8').includes(`id="${kind}-ref" multiple`));
});

test('R6 per-period source failure hides stale totals, retains healthy months, and allows UI correction with optimistic version',async()=>{
 const f=fixture(),service=new IncidentRoi(f.store),app=createIncidentApp(f.store);
 try {
  const evidence=f.add('Synthetic November receipt'),november=roiFixture();
  const cost=november.groups[0]!.scenarios[0]!.lines[0]!;cost.basis='actual';cost.sourceRefs=[`${evidence.importId}/${evidence.objectId}`];
  service.put(f.actor,f.workflow.workflowId,'2026-11',{projectId:'project',expectedVersion:0,input:november},'november');
  service.put(f.actor,f.workflow.workflowId,'2026-12',{projectId:'project',expectedVersion:0,input:roiFixture()},'december');
  f.ingest.revokeSource(f.actor,'project','source','withdrawn');
  const result=service.get(f.actor,'project',f.workflow.workflowId);
  assert.equal(result.periods[0].calculation,null);assert.equal(result.periods[0].sourceError,'ROI_SOURCE_REVOKED');assert.deepEqual(result.periods[0].sourceChecks,[]);
  assert.ok(result.periods[1].calculation);assert.equal(result.periods[1].sourceStatus,'available');
  assert.throws(()=>service.get({actorId:'foreign',tenantId:'other'},'project',f.workflow.workflowId),/NOT_FOUND/);
  const d=dom(),writes:any[]=[],context:any={document:d.document,sessionStorage:{getItem:(k:string)=>k==='incident-session'?f.token:null,removeItem(){},setItem(){}},crypto:{randomUUID},structuredClone,fetch:async(url:string,options:any)=>{
   if(options.method==='PUT')writes.push(JSON.parse(options.body));
   const response=await app.inject({method:options.method??'GET',url,headers:options.headers,...(options.body?{payload:options.body}:{})});
   return {ok:response.statusCode<400,status:response.statusCode,json:async()=>response.json()};
  }};
  runInNewContext(readFileSync('web/incident-roi.js','utf8'),context);
  d.get('project').value='project';d.get('workflow').value=f.workflow.workflowId;d.get('period').value='2026-12';
  d.get('load').onsubmit({preventDefault(){}});await flush();assert.ok(d.get('editor').children.length>0);
  d.get('save').onsubmit({preventDefault(){}});await flush();assert.equal(writes[0].expectedVersion,1);
  d.get('period').value='2026-11';d.get('load').onsubmit({preventDefault(){}});await flush();
  assert.ok(d.get('editor').children.length>0);assert.match(d.get('results').children[0].textContent,/金额与ROI结果未知/);
  const walk=(e:any):any[]=>[e,...e.children.flatMap(walk)],all=walk(d.get('editor'));
  const refs=all.find(e=>e.value===`${evidence.importId}/${evidence.objectId}`);assert.ok(refs);refs.value='';refs.oninput();
  // Replace the unsupported actual amount with explicit unknown; do not silently reclassify as estimated or zero.
  const amount=all.find(e=>e.value==='1000');assert.ok(amount);amount.value='';amount.oninput();
  d.get('save').onsubmit({preventDefault(){}});await flush();
  assert.equal(writes[1].expectedVersion,1);
  const corrected=service.get(f.actor,'project',f.workflow.workflowId).periods[0];
  assert.equal(corrected.version,2);assert.equal(corrected.sourceStatus,'available');assert.equal(corrected.calculation.groups[0].scenarios[0].periodCost,null);
  assert.throws(()=>service.put(f.actor,f.workflow.workflowId,'2026-11',{projectId:'project',expectedVersion:1,input:roiFixture()},'stale'),/ROI_VERSION_CONFLICT/);
 } finally {await app.close();f.store.close();}
});
