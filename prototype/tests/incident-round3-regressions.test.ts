import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fixture } from './incident-finance-fixture.ts';
import { IncidentExpense, type ExpenseInput } from '../packages/service/incident-expense.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';

test('R7 partial invoice overlap remains unknown',()=>{
const f=fixture();
try {
 const invoices=['invoice A','invoice B','invoice C'].map(x=>f.add(x));
 const payments=['payment A+B','payment B+C'].map(x=>f.add(x));
 const service=new IncidentExpense(f.store);
 for(let i=0;i<2;i++){
  const input:ExpenseInput={projectId:'project',expenseId:`expense-${i}`,expectedVersion:0,category:'restoration',currency:'CNY',scale:2,gross:'10000',paid:'10000',duplicate:'0',compensation:'0',recovery:'0',voucherRef:`voucher-${i}`,evidenceRefs:[...invoices.slice(i,i+2).map(r=>({importId:r.importId,objectId:r.objectId,kind:'invoice' as const})),{importId:payments[i]!.importId,objectId:payments[i]!.objectId,kind:'payment'}],verification:'confirmed',reason:'Synthetic partial overlap repro'};
  service.append(f.actor,f.incident.incidentId,input,`expense-${i}`);
 }
 const summary=service.summary(f.actor,'project',f.incident.incidentId);
 assert.equal(summary.totals[0]!.netTotal,null);
 assert.ok(summary.rows.every(r=>r.countedNet===null && r.duplicateOf===null));
 assert.ok(summary.rows.every(r=>r.issues.includes('DUPLICATE_VOUCHER_CONFLICT')));
 const thirdInvoice=f.add('invoice D');
 const base=summary.rows[1]!.line;
 const {recordId,incidentId,tenantId,version,actorId,createdAt,...baseInput}=base;
 service.append(f.actor,f.incident.incidentId,{...baseInput,expenseId:'expense-2',expectedVersion:0,voucherRef:'voucher-2',evidenceRefs:[...baseInput.evidenceRefs.filter(r=>r.kind==='payment'),...[invoices[2]!,thirdInvoice].map(r=>({importId:r.importId,objectId:r.objectId,kind:'invoice' as const}))]},'third');
 const connected=service.summary(f.actor,'project',f.incident.incidentId);
 assert.equal(connected.totals[0]!.unknownCount,3);
 assert.ok(connected.rows.every(r=>r.issues.includes('DUPLICATE_VOUCHER_CONFLICT')));
 // Resolving the component to identical sets (including reordered aliases)
 // restores exact-duplicate exclusion rather than permanently marking conflict.
 for(const [i,row] of connected.rows.entries()){
  const {recordId,incidentId,tenantId,version,actorId,createdAt,...input}=row.line;
  const ordered=i%2?invoices.slice(0,2).reverse():invoices.slice(0,2);
  service.append(f.actor,f.incident.incidentId,{...input,expectedVersion:version,evidenceRefs:[...input.evidenceRefs.filter(r=>r.kind==='payment'),...ordered.map(r=>({importId:r.importId,objectId:r.objectId,kind:'invoice' as const}))]},`resolve-${i}`);
 }
 const resolved=service.summary(f.actor,'project',f.incident.incidentId);
 assert.equal(resolved.totals[0]!.netTotal,'10000');assert.equal(resolved.totals[0]!.unknownCount,0);
 assert.equal(resolved.rows.filter(r=>r.issues.includes('DUPLICATE_VOUCHER_EXCLUDED')).length,2);
} finally {f.store.close();}});

test('R8 successful export starts a fresh operation after revocation',async()=>{
const g=fixture();
try {
 g.store.provision('reviewer','tenant',g.password,[{projectId:'project',role:'reviewer'}]);
 g.add('synthetic report evidence');
 const draft=(await new IncidentInvestigation(g.store).start(g.actor,g.incident.incidentId,{projectId:'project'},'draft')).report;
 const service=new IncidentReport(g.store),published=service.publish(g.actor,g.incident.incidentId,{projectId:'project',investigationId:draft.reportId,expectedVersion:0},'publish');
 const accepted=service.review({actorId:'reviewer',tenantId:'tenant'},published.report.reportId,{projectId:'project',expectedVersion:1,manifestDigest:published.report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'synthetic independent review'},'review');
 const body={projectId:'project',expectedVersion:1,reviewId:accepted.review.reviewId,audienceActorId:'viewer',profile:'redacted_metadata_v1'};
 const elements=new Map();const context:any={document:{getElementById:(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',replaceChildren(){}});return elements.get(id);}},sessionStorage:{getItem:(id:string)=>id==='incident-session'?'synthetic-token':null,removeItem(){}},crypto:{randomUUID},fetch:async(_path:string,options:any)=>({ok:true,json:async()=>service.export(g.actor,published.report.reportId,JSON.parse(options.body),options.headers['Idempotency-Key'])})};
 runInNewContext(readFileSync(new URL('../web/incident-reports.js',import.meta.url),'utf8')+'\nglobalThis.reviewWrite=write;',context);
 const path=`/reports/${published.report.reportId}/exports`;
 const first=await context.reviewWrite(path,body);
 service.revoke(g.actor,first.exportId,{projectId:'project',reason:'synthetic withdrawal'});
 const second=await context.reviewWrite(path,body);
 assert.notEqual(second.exportId,first.exportId);assert.equal(second.replayed,false);
 assert.throws(()=>service.download(g.actor,'project',first.exportId),/EXPORT_REVOKED/);service.download(g.actor,'project',second.exportId);
 const row=g.store.db.prepare('SELECT payload FROM records WHERE id=?').get(second.exportId)!;
 const expired=JSON.parse(String(row.payload));expired.expiresAt='2020-01-01T00:00:00.000Z';
 g.store.db.prepare('UPDATE records SET payload=? WHERE id=?').run(JSON.stringify(expired),second.exportId);
 assert.throws(()=>service.download(g.actor,'project',second.exportId),/EXPORT_EXPIRED/);
 const third=await context.reviewWrite(path,body);
 assert.notEqual(third.exportId,second.exportId);service.download(g.actor,'project',third.exportId);
 // A committed request with a lost response must still retry the same key.
 const actualFetch=context.fetch,keys:string[]=[];let loseResponse=true;
 context.fetch=async(url:string,options:any)=>{
  keys.push(options.headers['Idempotency-Key']);const response=await actualFetch(url,options);
  const result=await response.json();
  return {ok:true,json:async()=>{if(loseResponse){loseResponse=false;throw Error('response lost');}return result;}};
 };
 await assert.rejects(context.reviewWrite(path,body),/response lost/);
 const recovered=await context.reviewWrite(path,body);
 assert.equal(keys[0],keys[1]);assert.equal(recovered.replayed,true);
 service.download(g.actor,'project',recovered.exportId);
 await context.reviewWrite(path,body);assert.notEqual(keys[1],keys[2]);
 const fresh=service.export(g.actor,published.report.reportId,body,'fresh-operation');
 assert.notEqual(fresh.exportId,first.exportId);service.download(g.actor,'project',fresh.exportId);
} finally {g.store.close();}});
