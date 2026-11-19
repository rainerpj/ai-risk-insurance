import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { fixture } from '../tests/incident-finance-fixture.ts';
import { roiFixture } from '../tests/incident-roi-fixture.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentRoi } from '../packages/service/incident-roi.ts';
const f=fixture(),app=createIncidentApp(f.store),runId=randomUUID();
try{const address=await app.listen({host:'127.0.0.1',port:0});
 const request=async(path:string,method='GET',body?:unknown,token?:string,key?:string)=>{const response=await fetch(`${address}/api/incidents-v1${path}`,{method,signal:AbortSignal.timeout(10000),headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`} :{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json() as any};};
 const login=await request('/session','POST',{actorId:'admin',password:f.password}),token=login.body.token;assert.equal(login.status,200);
 const route=`/workflows/${f.workflow.workflowId}/roi-periods/2026-11`,input=roiFixture();const evidence=f.add('Synthetic human cost evidence; not a real customer invoice.');input.groups[0]!.scenarios[0]!.lines[0]!.basis='actual';input.groups[0]!.scenarios[0]!.lines[0]!.sourceRefs=[`${evidence.importId}/${evidence.objectId}`];
 const saved=await request(route,'PUT',{projectId:'project',expectedVersion:0,input},token,'save');assert.equal(saved.status,200);assert.equal(saved.body.record.calculation.groups[0].platform.operatingResult.numerator,'380');assert.equal(saved.body.record.sourceChecks[0].trust,'synthetic');assert.equal(saved.body.record.independentlyVerified,false);
 const read=`/workflows/${f.workflow.workflowId}/roi?projectId=project`,loaded=await request(read,'GET',undefined,token);assert.equal(loaded.status,200);assert.equal(loaded.body.periods.length,1);
 input.groups[0]!.scenarios[1]!.lines.find(l=>l.category==='uninsured')!.amount=null;const revised=await request(route,'PUT',{projectId:'project',expectedVersion:1,input},token,'revise');assert.equal(revised.status,200);assert.equal(revised.body.record.calculation.groups[0].scenarios[1].netSavings,null);assert.equal((await request(route,'PUT',{projectId:'project',expectedVersion:0,input},token,'stale')).status,409);
 const viewer=await request('/session','POST',{actorId:'viewer',password:f.password});assert.equal((await request(route,'PUT',{projectId:'project',expectedVersion:2,input},viewer.body.token,'denied')).status,403);await request('/session','DELETE',undefined,viewer.body.token);await request('/session','DELETE',undefined,token);assert.equal((await request(read,'GET',undefined,token)).status,401);
 const reopened=new IncidentStore(f.file);try{const history=new IncidentRoi(reopened).get(f.actor,'project',f.workflow.workflowId);assert.equal(history.history.length,2);assert.equal(history.periods[0].version,2);}finally{reopened.close();}
 mkdirSync('reports',{recursive:true});const proof=`reports/incident-n10-scenario-${runId}.json`;writeFileSync(proof,JSON.stringify({runId,status:'passed',scope:'synthetic-real-loopback-http',initial:saved.body.record,updated:revised.body.record,staleDenied:true,viewerWriteDenied:true,loggedOutDenied:true,restartHistoryPreserved:true,realCustomerData:false},null,2));console.log(proof);
}finally{await app.close();f.store.close();}
