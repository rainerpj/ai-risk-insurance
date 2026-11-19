import {assertBridge} from '../packages/service/incident-bridge-gate.ts';
import test from 'node:test';
import { runBridgeScenario } from './incident-bridge-scenario.ts';
test('N11 real local chain manual bridge and stale-broadcast boundaries',async t=>{const path=await runBridgeScenario((name,fn)=>t.test(name,fn));console.log(path);});
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {custom} from 'viem';
import {setup,id} from './chain-helper.ts';
import {bridgeSource} from './incident-bridge-fixture.ts';
import {Store} from '../packages/service/store.ts';
import {Chain,grantAbi} from '../packages/service/chain.ts';
import {IncidentClaimBridge} from '../packages/service/incident-claim-bridge.ts';
import {createIncidentApp} from '../packages/service/incident-api.ts';
test('N11 missing adapter, nonlocal deployment, wrong token, non-test terms and unknown expenses fail closed',async()=>{const c=await setup(),q=await c.issue({annualLimit:10000000n,incidentLimit:10000000n});mkdirSync('.local',{recursive:true});const legacy=new Store(`.local/n11-negative-${c.runId}.sqlite`,`31337:${c.core.address}:${c.salt}`),chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{});
 try{
  for(const options of [{coverage:{mode:'proposed'}},{coverage:{currency:'USD'}},{coverage:{deductible:'1'}},{expense:{paid:null}},{expense:{verification:'pending'}},{expense:{category:'other'}}]){const f=await bridgeSource(q,options);try{const bridge=new IncidentClaimBridge(f.store,legacy,chain,[{tenantId:'tenant',projectId:'project',workflowId:f.workflow.workflowId,policyId:q.quoteId}]);await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,f.input,'negative'),/BRIDGE_LOCAL_TEST_REQUIRED|BRIDGE_TERMS_MISMATCH|BRIDGE_EXPENSE_UNVERIFIED/);assert.equal(legacy.all('SELECT * FROM outbox').length,0);}finally{f.store.close();}}
  const f=await bridgeSource(q);try{const bridge=new IncidentClaimBridge(f.store,legacy,chain,[{tenantId:'tenant',projectId:'project',workflowId:f.workflow.workflowId,policyId:q.quoteId}]),app=createIncidentApp(f.store);try{assert.equal((await app.inject({method:'POST',url:`/api/incidents-v1/incidents/${f.incident.incidentId}/test-claims`,headers:{authorization:`Bearer ${f.token}`,'idempotency-key':'off'},payload:f.input})).statusCode,503);}finally{await app.close();}
   const check=chain.check.bind(chain);chain.check=async()=>{throw Error('DEPLOYMENT_MISMATCH');};try{await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,f.input,'chain'),/DEPLOYMENT_MISMATCH/);}finally{chain.check=check;}
   const getCode=chain.client.getCode;chain.client.getCode=async()=> '0x6000';try{await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,f.input,'token'),/BRIDGE_MOCK_TOKEN_REQUIRED/);}finally{chain.client.getCode=getCode;}
   await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,{...f.input,confirmSynthetic:false},'consent'),/INVALID_INPUT/);await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,{...f.input,reviewId:id()},'review'),/BRIDGE_REPORT_NOT_CURRENT/);
   const registry={address:await c.read(c.core,'grantRegistry'),abi:grantAbi};await c.send(registry,'setChannel',[1,true,false,id()]);await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,f.input,'auto-enabled'),/BRIDGE_MANUAL_CHANNELS_REQUIRED/);await c.send(registry,'setChannel',[1,false,false,id()]);await bridge.create(f.actor,f.incident.incidentId,f.input,'valid');f.store.provision('admin','tenant',f.password,[{projectId:'project',role:'viewer'}]);await assert.rejects(()=>assertBridge(legacy,'payment',{policyId:q.quoteId}),/ROLE_DENIED|BRIDGE_REPORT_NOT_CURRENT/);f.store.provision('admin','tenant',f.password,[{projectId:'project',role:'enterprise_admin'}]);await assert.rejects(()=>assertBridge(legacy,'payment',{policyId:q.quoteId}),/BRIDGE_HALTED/);
  }finally{f.store.close();}
 }finally{legacy.close();await c.connection.close();}});


