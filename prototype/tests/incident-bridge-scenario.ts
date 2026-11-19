import {assertBridge} from '../packages/service/incident-bridge-gate.ts';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { custom } from 'viem';
import { setup,H,id,json } from './chain-helper.ts';
import { bridgeSource } from './incident-bridge-fixture.ts';
import { Store } from '../packages/service/store.ts';
import { Chain } from '../packages/service/chain.ts';
import { Indexer,Worker } from '../packages/service/indexer.ts';
import { createApp,intakeMessage } from '../packages/service/api.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { IncidentClaimBridge } from '../packages/service/incident-claim-bridge.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
export async function runBridgeScenario(check:(name:string,fn:()=>Promise<void>)=>Promise<unknown>){const c=await setup(),proofs:any[]=[];mkdirSync('.local',{recursive:true});
 try{for(const mode of ['paid','retry_same_raw','changed_before_sign','changed_after_sign'] as const){const q=await c.issue({annualLimit:10000000n,incidentLimit:10000000n}),f=await bridgeSource(q),scope=`31337:${c.core.address}:${c.salt}`,file=`.local/incident-n11-${c.runId}-${mode}.sqlite`;let legacy=new Store(file,scope);const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),Object.fromEntries(Object.values(c.accounts).map(a=>[a.address.toLowerCase(),a])));const targets=[{tenantId:'tenant',projectId:'project',workflowId:f.workflow.workflowId,policyId:q.quoteId}];let bridge=new IncidentClaimBridge(f.store,legacy,chain,targets),app=createApp(legacy,chain),incidentApp=createIncidentApp(f.store,'http://127.0.0.1:3200',bridge),worker=new Worker(legacy,chain),index=new Indexer(legacy,chain,0n);const tokens:Record<string,string>={};let mapping:any,draft:any,pay:any;
 const req=async(method:any,url:string,name:string,body?:unknown)=>app.inject({method,url,headers:{authorization:`Bearer ${tokens[name]}`},...(body?{payload:JSON.parse(json(body))}:{})});
 const mine=async()=>{await c.connection.provider.request({method:'evm_mine'});await c.connection.provider.request({method:'evm_mine'});await index.sync();};
 const execute=async()=>{await worker.tick();await mine();};
 try{
 for(const [name,role] of [['insured','insured'],['assessor','ASSESSOR'],['approver','CLAIM_APPROVER']] as const){legacy.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[name].address.toLowerCase(),H('enterprise'),role);const challenge=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts[name].address}})).json();const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{id:challenge.id,signature:await c.accounts[name].signMessage({message:challenge.message})}});assert.equal(login.statusCode,200);tokens[name]=login.json().token;}
 await check(`${mode}: local allowlist, role and exact versions gate mapping`,async()=>{
  await assert.rejects(()=>bridge.create({actorId:'viewer',tenantId:'tenant'},f.incident.incidentId,f.input,'viewer'),/ROLE_DENIED/);
  await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,{...f.input,policyId:id()},'foreign-policy'),/BRIDGE_POLICY_NOT_ALLOWLISTED/);
  await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,{...f.input,coverageVersion:2},'version'),/BRIDGE_LOCAL_TEST_REQUIRED/);
  if(mode==='paid'){
   const audit=f.store.audit.bind(f.store);f.store.audit=(actor,action,target)=>{if(action==='create_claim_bridge')throw Error('synthetic source audit failure');audit(actor,action,target);};try{await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,f.input,'audit'),/synthetic source audit failure/);}finally{f.store.audit=audit;}assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='claim_bridge'").get()!.n,0);
   const legacyAudit=legacy.audit.bind(legacy);legacy.audit=(actor,action,target)=>{if(action==='install_incident_bridge')throw Error('synthetic installation failure');legacyAudit(actor,action,target);};try{await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,f.input,'partial'),/synthetic installation failure/);}finally{legacy.audit=legacyAudit;}assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='claim_bridge'").get()!.n,1);assert.equal(legacy.getMeta('incident-bridge:'+q.quoteId),undefined);
  }
  const response=await incidentApp.inject({method:'POST',url:`/api/incidents-v1/incidents/${f.incident.incidentId}/test-claims`,headers:{authorization:`Bearer ${f.token}`,'idempotency-key':'map'},payload:f.input});assert.equal(response.statusCode,200,response.body);mapping=response.json();
  const retried=await bridge.create(f.actor,f.incident.incidentId,f.input,'retry');assert.equal(retried.mapping.bridgeId,mapping.mapping.bridgeId);assert.equal(f.store.db.prepare("SELECT count(*) n FROM records WHERE kind='claim_bridge'").get()!.n,1);assert.equal(new IncidentReport(f.store).get(f.actor,'project',f.input.reportId).status,'reviewed');const parallel=await Promise.all(['parallel1','parallel2'].map(key=>bridge.create(f.actor,f.incident.incidentId,f.input,key)));assert.equal(parallel[0]!.mapping.bridgeId,parallel[1]!.mapping.bridgeId);await assert.rejects(()=>bridge.create(f.actor,f.incident.incidentId,{...f.input,declaredIncidentAt:String(BigInt(f.input.declaredIncidentAt)+1n)},'alter'),/BRIDGE_MAPPING_CONFLICT/);
 });
 await check(`${mode}: signed notice binds report digest and durable mapping`,async()=>{
  const payload=mapping.noticePayload,signature=await c.accounts.insured.signMessage({message:intakeMessage(scope,payload)});const intake=await req('POST','/api/notices','insured',{payload,signature});assert.equal(intake.statusCode,202,intake.body);
  const authorization={noticeId:payload.noticeId,policyId:q.quoteId,incidentCommitment:payload.incidentCommitment,evidenceHash:payload.evidenceHash,declaredIncidentAt:payload.declaredIncidentAt,submitter:c.accounts.insured.address,signerEpoch:String(await c.read(c.core,'epochs',[c.accounts.insured.address])),expiresAt:String((await c.now())+20000n)};
  const sig=await req('POST','/api/sign','insured',{type:'NoticeAuthorization',message:authorization,policyId:q.quoteId});assert.equal(sig.statusCode,200,sig.body);const bound=await req('POST',`/api/notices/${payload.noticeId}/bind`,'insured',{authorization,signature:sig.json().signature});assert.equal(bound.statusCode,200,bound.body);await execute();assert.equal(legacy.get('SELECT state FROM outbox WHERE id=?',payload.noticeId).state,'confirmed');
 });
 await check(`${mode}: independent manual draft and approval reject changed loss and raw signing`,async()=>{
  await assert.rejects(()=>assertBridge(legacy,'raw-sign',{policyId:'0x'+q.quoteId.slice(2).toUpperCase()}),/BRIDGE_USE_MANUAL_DRAFT/);const input={...mapping.draftInput,approver:c.accounts.approver.address};assert.equal((await req('POST','/api/drafts','insured',input)).statusCode,403);const altered=structuredClone(input);altered.expenses[0].gross='6000000';assert.equal((await req('POST','/api/drafts','assessor',altered)).statusCode,409);
  const result=await req('POST','/api/drafts','assessor',input);assert.equal(result.statusCode,200,result.body);draft=result.json();assert.equal((await req('POST','/api/sign','approver',{type:'ClaimDecision',message:draft.draft.d,policyId:q.quoteId})).statusCode,409);
  assert.equal((await req('POST',`/api/drafts/${draft.id}/sign`,'insured',{})).statusCode,403);assert.equal((await req('POST',`/api/drafts/${draft.id}/sign`,'approver',{})).statusCode,200);const submitted=await req('POST',`/api/drafts/${draft.id}/submit`,'approver',{});assert.equal(submitted.statusCode,200,submitted.body);assert.equal((await req('POST',`/api/drafts/${draft.id}/submit`,'approver',{})).json().id,submitted.json().id);await execute();assert.equal(legacy.get('SELECT state FROM outbox WHERE id=?',draft.id).state,'confirmed');
 });
 await check(`${mode}: payment queue and broadcast invariants`,async()=>{
  const result=await req('POST','/api/manual/payment','approver',{incidentId:mapping.mapping.chainIncidentId,reason:'Synthetic manual installment',amount:'5000000'});assert.equal(result.statusCode,200,result.body);pay=result.json();
  const send=chain.client.sendRawTransaction;let broadcasts=0;chain.client.sendRawTransaction=async(args:any)=>{broadcasts++;if(mode==='retry_same_raw')throw Error('injected network failure before broadcast');const receipt=await send(args);if(mode==='paid')throw Error('injected lost broadcast response');return receipt;};
  const prepare=chain.prepare.bind(chain);if(mode==='changed_before_sign')f.add('Synthetic supplement before signing');if(mode==='changed_after_sign')chain.prepare=async(...args:Parameters<Chain['prepare']>)=>{const signed=await prepare(...args);f.add('Synthetic supplement after raw signature, before broadcast');return signed;};
  try{await worker.tick();}finally{chain.client.sendRawTransaction=send;chain.prepare=prepare;}
  const job=legacy.get('SELECT * FROM outbox WHERE id=?',pay.id);
  if(mode==='changed_before_sign'){assert.equal(job.state,'queued');assert.equal(job.raw,null);assert.equal(broadcasts,0);assert.equal((await c.read(c.core,'getIncident',[mapping.mapping.chainIncidentId])).P,0n);}
  else {assert.equal(job.state,'unknown');assert.ok(job.raw);assert.ok(job.tx_hash);assert.equal(broadcasts,mode==='paid'||mode==='retry_same_raw'?1:0);}
  assert.equal((await req('POST','/api/manual/payment','approver',{incidentId:mapping.mapping.chainIncidentId,reason:'duplicate attempt',amount:'5000000'})).statusCode,409);
 });
 await check(`${mode}: restart preserves verifier lock, raw transaction and reconciliation`,async()=>{
  const before=legacy.get('SELECT * FROM outbox WHERE id=?',pay.id);await app.close();await incidentApp.close();legacy.close();legacy=new Store(file,scope);worker=new Worker(legacy,chain);index=new Indexer(legacy,chain,0n);await worker.tick();const blocked=legacy.get('SELECT * FROM outbox WHERE id=?',pay.id);assert.equal(blocked.raw,before.raw);assert.equal(blocked.tx_hash,before.tx_hash);assert.match(blocked.error,/BRIDGE_VERIFIER_UNAVAILABLE/);
  bridge=new IncidentClaimBridge(f.store,legacy,chain,targets);await mine();await worker.tick();await mine();const after=legacy.get('SELECT * FROM outbox WHERE id=?',pay.id),state=await c.read(c.core,'getIncident',[mapping.mapping.chainIncidentId]);assert.equal(state.P,mode==='paid'||mode==='retry_same_raw'?5000000n:0n);if(mode==='paid'||mode==='retry_same_raw'){assert.equal(after.state,'confirmed');await worker.tick();await mine();assert.equal((await c.read(c.core,'getIncident',[mapping.mapping.chainIncidentId])).P,5000000n);}else{assert.equal(after.raw,before.raw);assert.equal(after.tx_hash,before.tx_hash);assert.equal(bridge.get(f.actor,'project',f.incident.incidentId).current,false);assert.ok(bridge.get(f.actor,'project',f.incident.incidentId).haltReason);}
  proofs.push({mode,bridgeId:mapping.mapping.bridgeId,chainIncidentId:mapping.mapping.chainIncidentId,noticeId:mapping.mapping.noticeId,paymentId:pay.id,txHash:after.tx_hash,state:after.state,paid:String(state.P),bindingHash:mapping.mapping.bindingHash,sameRaw:after.raw===before.raw});
 });
 }finally{await app.close();await incidentApp.close();legacy.close();f.store.close();}
 }
 const path=`reports/incident-n11-scenario-${c.runId}.json`;mkdirSync('reports',{recursive:true});writeFileSync(path,json({runId:c.runId,chainId:31337,scope:'local MockUSDC, synthetic data, API injection plus real EVM',proofs,independentHumanAcceptance:false}));return path;
 }finally{await c.connection.close();}
}





