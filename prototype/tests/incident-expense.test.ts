import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './incident-finance-fixture.ts';
import { IncidentExpense,localTestCoverage,type ExpenseInput } from '../packages/service/incident-expense.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
function setup(){const f=fixture(),invoice=f.add('synthetic invoice'),payment=f.add('synthetic payment'),comp=f.add('synthetic compensation'),recovery=f.add('synthetic recovery'),service=new IncidentExpense(f.store);
 const ref=(r:typeof invoice,kind:'invoice'|'payment'|'compensation'|'recovery')=>({importId:r.importId,objectId:r.objectId,kind});
 const input:ExpenseInput={projectId:'project',expenseId:'expense-1',expectedVersion:0,category:'restoration',currency:'CNY',scale:2,gross:'100000',paid:'90000',duplicate:'10000',compensation:'20000',recovery:'5000',voucherRef:'issuer/invoice-1',evidenceRefs:[ref(invoice,'invoice'),ref(payment,'payment'),ref(comp,'compensation'),ref(recovery,'recovery')],verification:'confirmed',reason:'Synthetic manual attestation; not a real loss'};return {...f,invoice,payment,service,input};}
test('expense net uses paid less duplicate/compensation/recovery, preserves versions and restart, replays idempotently',()=>{
 const f=setup();try{const first=f.service.append(f.actor,f.incident.incidentId,f.input,'one');assert.equal(f.service.summary(f.actor,'project',f.incident.incidentId).totals[0]!.netTotal,'55000');assert.equal(f.service.append(f.actor,f.incident.incidentId,f.input,'one').replayed,true);
 assert.throws(()=>f.service.append(f.actor,f.incident.incidentId,{...f.input,paid:'80000'},'one'),/IDEMPOTENCY_CONFLICT/);
 assert.throws(()=>f.service.append(f.actor,f.incident.incidentId,f.input,'stale'),/EXPENSE_VERSION_CONFLICT/);
 f.service.append(f.actor,f.incident.incidentId,{...f.input,expectedVersion:1,paid:'80000'},'two');const summary=f.service.summary(f.actor,'project',f.incident.incidentId);assert.equal(summary.history.length,2);assert.equal(summary.history[0]!.recordId,first.expense.recordId);assert.equal(summary.totals[0]!.netTotal,'45000');f.store.close();const reopened=new IncidentStore(f.file);try{assert.deepEqual(new IncidentExpense(reopened).summary(f.actor,'project',f.incident.incidentId),summary);}finally{reopened.close();}
 }catch(e){try{f.store.close();}catch{}throw e;}
});
test('unknown, absent evidence, pending verification and contradictory deductions never become zero',()=>{
 const f=setup();try{let version=0;for(const patch of [{paid:null},{evidenceRefs:[]},{verification:'pending' as const},{recovery:'100000'},{paid:'100001'}]){f.service.append(f.actor,f.incident.incidentId,{...f.input,...patch,expectedVersion:version++},`v${version}`);assert.equal(f.service.summary(f.actor,'project',f.incident.incidentId).totals[0]!.netTotal,null);}
 }finally{f.store.close();}
});
test('same invoice bytes with different voucher labels counted once; conflicting duplicates remain unknown across currency',()=>{
 const f=setup();try{f.service.append(f.actor,f.incident.incidentId,f.input,'one');f.service.append(f.actor,f.incident.incidentId,{...f.input,expenseId:'expense-2',voucherRef:'alias'},'two');let s=f.service.summary(f.actor,'project',f.incident.incidentId);assert.equal(s.totals[0]!.netTotal,'55000');assert.equal(s.rows[1]!.duplicateOf,'expense-1');
 f.service.append(f.actor,f.incident.incidentId,{...f.input,expenseId:'expense-2',expectedVersion:1,currency:'USD'},'three');s=f.service.summary(f.actor,'project',f.incident.incidentId);assert.equal(s.totals.length,2);assert.ok(s.totals.every(g=>g.netTotal===null));assert.ok(s.rows.every(r=>r.issues.includes('DUPLICATE_VOUCHER_CONFLICT')));
 }finally{f.store.close();}
});
test('amount precision uses BigInt, rejects floats/negative/scientific syntax and separates currency scales',()=>{
 const f=setup();try{for(const gross of ['-1','1.5','1e5',1.5,'01'])assert.throws(()=>f.service.append(f.actor,f.incident.incidentId,{...f.input,gross},'bad'),/INVALID_AMOUNT/);
 const big='900719925474099312345678';f.service.append(f.actor,f.incident.incidentId,{...f.input,gross:big,paid:big,duplicate:'0',compensation:'0',recovery:'0'},'big');assert.equal(f.service.summary(f.actor,'project',f.incident.incidentId).totals[0]!.netTotal,big);
 const invoice=f.add('another invoice'),payment=f.add('another payment');f.service.append(f.actor,f.incident.incidentId,{...f.input,expenseId:'other',voucherRef:'other',scale:6,evidenceRefs:[{importId:invoice.importId,objectId:invoice.objectId,kind:'invoice'},{importId:payment.importId,objectId:payment.objectId,kind:'payment'}],compensation:'0',recovery:'0'},'other');assert.equal(f.service.summary(f.actor,'project',f.incident.incidentId).totals.length,2);
 }finally{f.store.close();}
});
test('API guards identity, tenant, incident/run evidence and stale versions; missing session denied',async()=>{
 const f=setup(),app=createIncidentApp(f.store);try{const url=`/api/incidents-v1/incidents/${f.incident.incidentId}/expenses`;
 assert.equal((await app.inject({url:url+'?projectId=project'})).statusCode,401);
 for(const [id,status] of [['viewer',403],['foreign',404]] as const){const token=f.store.login(id,f.password).token;assert.equal((await app.inject({url,method:'POST',headers:{authorization:`Bearer ${token}`,'idempotency-key':'write'},payload:f.input})).statusCode,status);}
 const token=f.store.login('investigator',f.password).token;assert.equal((await app.inject({url,method:'POST',headers:{authorization:`Bearer ${token}`,'idempotency-key':'write'},payload:f.input})).statusCode,201);
 assert.equal((await app.inject({url:url+'?projectId=project',headers:{authorization:`Bearer ${token}`}})).json().totals[0].netTotal,'55000');
 const bad={...f.input,expenseId:'bad',evidenceRefs:[{importId:'missing',objectId:'missing',kind:'payment'}]};assert.throws(()=>f.service.append(f.actor,f.incident.incidentId,bad,'bad'),/NOT_FOUND/);
 f.store.db.prepare('UPDATE incident_objects SET content=? WHERE id=?').run(Buffer.from('damaged'),f.invoice.objectId);assert.equal(f.service.summary(f.actor,'project',f.incident.incidentId).totals[0]!.netTotal,null);
 }finally{await app.close();f.store.close();}
});
test('write failure rolls back expense and idempotency record together',()=>{
 const f=setup();try{f.store.db.exec("CREATE TRIGGER fail_expense_audit BEFORE INSERT ON audit WHEN NEW.action='append_expense' BEGIN SELECT RAISE(ABORT,'injected'); END;");assert.throws(()=>f.service.append(f.actor,f.incident.incidentId,f.input,'one'),/injected/);assert.equal(f.service.summary(f.actor,'project',f.incident.incidentId).history.length,0);assert.equal(f.store.db.prepare("SELECT count(*) n FROM requests WHERE operation='expense'").get()!.n,0);}finally{f.store.close();}
});
test('local-test mapping locks explicit terms, floors exact shares and caps incident and annual remaining',()=>{
 const terms={mode:'local_test',termsVersion:'test-v1',currency:'CNY',scale:2,deductible:'100',shareNumerator:'2',shareDenominator:'3',incidentLimit:'800',annualRemaining:'500'};
 assert.equal(localTestCoverage('1001',terms).proposedAmount,'500');assert.equal(localTestCoverage('1001',{...terms,annualRemaining:'900'}).proposedAmount,'600');assert.equal(localTestCoverage('50',terms).proposedAmount,'0');assert.equal(localTestCoverage(null,terms).proposedAmount,null);assert.equal(localTestCoverage('99999',{...terms,annualRemaining:'900'}).proposedAmount,'800');
 assert.throws(()=>localTestCoverage('1',{...terms,shareDenominator:'0'}),/INVALID_TEST_SHARE/);assert.throws(()=>localTestCoverage('1',{...terms,mode:'production'}),/INVALID_TEST_TERMS/);assert.throws(()=>localTestCoverage('1',{...terms,annualRemaining:null}),/INVALID_TEST_TERMS/);
});
