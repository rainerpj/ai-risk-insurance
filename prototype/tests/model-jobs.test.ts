import {remoteIntakePortal} from '../packages/service/intake-portal.ts';
import {operations} from '../packages/service/operations.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {renameSync} from 'node:fs';
import {semanticFixture} from './m2c-fixture.ts';
import {Store,json} from '../packages/service/store.ts';
import {ModelJobs} from '../packages/service/model-jobs.ts';
import {SemanticIntake} from '../packages/service/supplement.ts';
import {reviewerApp} from '../packages/service/automatic-api.ts';
import type {AgentAdapter} from '../packages/service/agent.ts';
import {OpenAIAdapter} from '../packages/service/openai-adapter.ts';
import {ModelSpend} from '../packages/service/model-spend.ts';

test('model queue API is private, deduplicates concurrent claims and preserves validated result across restart',async()=>{
 const f=await semanticFixture(),path=resolve(f.dir,'model-jobs.sqlite'),scope=f.store.getMeta('scope')!;let store=new Store(path,scope),calls=0;
 const factory=():AgentAdapter=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{calls++;return {inputTokens:20,outputTokens:40,output:json(f.proposal)};}});
 let jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',factory);const app=reviewerApp(f.reviewer,'i'.repeat(40),store,{[f.q.enterpriseId]:'p'.repeat(40)},jobs);
 try{
  for(const authorization of [undefined,'Bearer '+'p'.repeat(40)]){const denied=await app.inject({method:'POST',url:'/model-intake',headers:authorization?{authorization}:{},payload:{request:f.request}});assert.equal(denied.statusCode,403);}
  const injected=await app.inject({method:'POST',url:'/model-intake',headers:{authorization:'Bearer '+'i'.repeat(40)},payload:{request:f.request,proposal:f.proposal}});assert.equal(injected.statusCode,409);
  const created=await app.inject({method:'POST',url:'/model-intake',headers:{authorization:'Bearer '+'i'.repeat(40)},payload:{request:f.request}});assert.equal(created.statusCode,200,created.body);const id=created.json().id;
  await Promise.all([jobs.tick(),jobs.tick()]);const ready=jobs.get(id);assert.equal(ready.state,'ready');assert.equal(calls,1);assert.equal(ready.report.kind,'stub');assert.equal(ready.report.semanticValidated,false);assert(ready.assessment.signature);
  assert.equal((await jobs.enqueue(f.request)).state,'ready');assert.equal(calls,1);
  assert.equal((await app.inject({url:'/model-jobs/'+id,headers:{authorization:'Bearer '+'p'.repeat(40)}})).statusCode,403);
  await app.close();store.close();store=new Store(path,scope);jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',factory);jobs.recover();await jobs.tick();assert.equal(calls,1);assert.deepEqual(jobs.get(id).assessment,ready.assessment);
  await f.enable();const authorized=await f.authorizer.authorize(f.request,ready.assessment.a,ready.assessment.signature,ready.report.proposal);assert.equal(authorized.args[0].netApproved,5000000000n);
  console.log('Durable model queue evidence:',f.c.save('model-jobs',{ready,authorized,model:'stub; no live API call'}));
 }finally{await app.close();store.close();f.close();await f.c.connection.close();}
});

test('persisted model proposal survives independent-review outage and is revalidated without another model call',async()=>{
 const f=await semanticFixture(),path=resolve(f.dir,'model-jobs.sqlite'),scope=f.store.getMeta('scope')!;let store=new Store(path,scope),calls=0;
 const assess=f.reviewer.assess.bind(f.reviewer),factory=():AgentAdapter=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{calls++;return {inputTokens:1,outputTokens:1,output:json(f.proposal)};}});
 try{
  let jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',factory);const first=await jobs.enqueue(f.request);
  // Simulate a provider/RPC outage after the proposal has been durably stored, before intake can run.
  const policy=f.reviewer.chain.policy.bind(f.reviewer.chain);let broken=false;
  f.reviewer.chain.policy=async id=>{if(broken)throw Error('offline');return policy(id);};
  const offlineFactory=():AgentAdapter=>({...factory(),respond:async()=>{calls++;broken=true;return {inputTokens:1,outputTokens:1,output:json(f.proposal)};}});
  jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',offlineFactory);await jobs.tick();assert.equal(jobs.get(first.id).state,'proposed');assert.equal(calls,1);
  store.close();store=new Store(path,scope);broken=false;jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',factory);jobs.recover();await jobs.tick();assert.equal(jobs.get(first.id).state,'ready');assert.equal(calls,1);
 }finally{f.reviewer.assess=assess;store.close();f.close();await f.c.connection.close();}
});

test('ambiguous running job is manual after recovery and late model result cannot reopen or sign it',async()=>{
 const f=await semanticFixture(),store=new Store(resolve(f.dir,'model-jobs.sqlite'),f.store.getMeta('scope')!);let finish!:(v:any)=>void,started!:()=>void;
 const entered=new Promise<void>(r=>started=r),response=new Promise<any>(r=>finish=r);let calls=0;
 const jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',()=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{calls++;started();return response;}}));
 try{const job=await jobs.enqueue(f.request),pending=jobs.tick();await entered;jobs.recover();finish({inputTokens:1,outputTokens:1,output:json(f.proposal)});await pending;await jobs.tick();assert.equal(calls,1);assert.equal(jobs.get(job.id).state,'manual');assert.equal(jobs.get(job.id).assessment,null);assert.equal(jobs.get(job.id).error,'MODEL_RUN_INTERRUPTED');assert.equal(JSON.parse(store.get('SELECT payload FROM semantic_intake WHERE id=?',job.id).payload).state,'manual');}
 finally{store.close();f.close();await f.c.connection.close();}
});

test('missing evidence waits for the once-only supplement; resumed case keeps its original job identity',async()=>{
 const f=await semanticFixture(),store=new Store(resolve(f.dir,'model-jobs.sqlite'),f.store.getMeta('scope')!);let calls=0;
 const jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',()=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{calls++;return {inputTokens:1,outputTokens:1,output:json(f.proposal)};}}));
 const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
 try{const job=await jobs.enqueue(f.request);await jobs.tick();assert.equal(calls,0);assert.equal(jobs.get(job.id).state,'waiting');renameSync(file+'.offline',file);
  await new SemanticIntake(store,f.reviewer).run(f.request,null,true);await jobs.tick();assert.equal(calls,1);assert.equal(jobs.get(job.id).state,'ready');assert.equal((await jobs.enqueue(f.request)).id,job.id);
 }finally{store.close();f.close();await f.c.connection.close();}
});

test('changed model/profile, failed extraction and deadline expiry never produce an assessment',async()=>{
 for(const mode of ['model','profile','manual','deadline']){
  const f=await semanticFixture(),store=new Store(resolve(f.dir,'model-jobs.sqlite'),f.store.getMeta('scope')!);let calls=0;
  try{
   if(mode==='model'){assert.throws(()=>new ModelJobs(store,f.reviewer,'other-model',()=>{throw Error('never');}),/VERSION_MISMATCH/);continue;}
   const factory=():AgentAdapter=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{calls++;return {inputTokens:1,outputTokens:1,output:json({route:'manual',items:[],reason:'uncertain'})};}});
   let jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',factory);const job=await jobs.enqueue(f.request);
   if(mode==='profile'){f.trust.runtimeDeployment='different-runtime';jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',factory);}
   if(mode==='deadline'){const s=JSON.parse(store.get('SELECT payload FROM semantic_intake WHERE id=?',job.id).payload);s.deadline=Date.now()-1;store.run('UPDATE semantic_intake SET payload=? WHERE id=?',json(s),job.id);}
   await jobs.tick();assert.equal(jobs.get(job.id).state,'manual');assert.equal(jobs.get(job.id).assessment,null);assert.equal(calls,mode==='manual'?1:0);
  }finally{store.close();f.close();await f.c.connection.close();}
 }
});

test('serial read-only model loop can read all eleven originals, terms and both loss calculations within bounded job limits',async()=>{
 const f=await semanticFixture(),store=new Store(resolve(f.dir,'model-jobs.sqlite'),f.store.getMeta('scope')!);let calls=0;
 const steps=[...f.refs.map(ref=>({name:'readEvidence',arguments:json({ref})})),{name:'readTerms',arguments:'{}'},...f.proposal.items.map(i=>({name:'calculateLoss',arguments:json({workRef:i.workRef,paymentRef:i.paymentRef})}))];
 const jobs=new ModelJobs(store,f.reviewer,'stub-semantic-v1',()=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{
  const step=steps[calls++];return {inputTokens:1000,outputTokens:100,...(step?{toolCalls:[{id:'sequential-'+calls,...step}]}:{output:json(f.proposal)})};
 }}));
 try{const job=await jobs.enqueue(f.request);await jobs.tick();const done=jobs.get(job.id);assert.equal(done.state,'ready');assert.equal(calls,15);assert.equal(done.report.trace.filter((t:any)=>t.type==='tool').length,14);assert.equal(done.report.tokens,16500);}
 finally{store.close();f.close();await f.c.connection.close();}
});

test('queued adapter uses stable case ID for durable API spending; unknown transport outcome remains manual and reserved',async()=>{
 for(const unknown of [false,true]){
  const f=await semanticFixture(),scope=f.store.getMeta('scope')!,store=new Store(resolve(f.dir,'model-jobs.sqlite'),scope),model='stub-semantic-v1';
  const ledger=new ModelSpend(resolve(f.dir,'model-cost.sqlite'),{scope,price:{version:'synthetic-v1',model,input:'1000000',cachedInput:'100000',output:'2000000'},globalLimit:'10000',runLimit:'10000',runCalls:16,maxInputTokens:10000},true);let network=0;
  const jobs=new ModelJobs(store,f.reviewer,model,runId=>new OpenAIAdapter({model,key:()=> 'synthetic-test-only',record:()=>{},spend:{ledger,runId}},async url=>{
   network++;if(String(url).endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:20});
   assert.equal(ledger.usage(runId).estimatedMicroUSD,'4020');
   if(unknown)throw Error('simulated lost response');
   return Response.json({id:'resp_queue',model,status:'completed',usage:{input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:0}},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:json(f.proposal)}]}]});
  }));
  try{const job=await jobs.enqueue(f.request);await jobs.tick();await jobs.tick();assert.equal(network,2);assert.equal(jobs.get(job.id).state,unknown?'manual':'ready');assert.equal(ledger.usage(job.id).estimatedMicroUSD,unknown?'4020':'40');assert.equal(ledger.usage(job.id).unknown,unknown?1:0);assert.equal(jobs.get(job.id).report.kind,'stub');}
  finally{ledger.close();store.close();f.close();await f.c.connection.close();}
 }
});

test('tenant capability exposes only linked model cost aggregates and rejects cross-scope ledgers',async()=>{
 const f=await semanticFixture(),scope=f.store.getMeta('scope')!,jobs=new ModelJobs(f.store,f.reviewer,'stub-semantic-v1',()=>({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>{throw Error('NOT_USED');}}));
 const ledger=new ModelSpend(resolve(f.dir,'cost-projection.sqlite'),{scope,price:{version:'synthetic-v1',model:'stub-semantic-v1',input:'1000000',cachedInput:'0',output:'1000000'},globalLimit:'1000',runLimit:'1000',runCalls:2,maxInputTokens:1000},true);
 const tenant=f.q.enterpriseId,other='0x'+'a'.repeat(64),app=reviewerApp(f.reviewer,'i'.repeat(40),f.store,{[tenant]:'p'.repeat(40),[other]:'q'.repeat(40)},jobs,ledger);
 try{
  const job=await jobs.enqueue(f.request);ledger.reserve(job.id,1,'b'.repeat(64),'stub-semantic-v1',20,10);ledger.reserve('unassigned',1,'c'.repeat(64),'stub-semantic-v1',40,10);
  const result=await app.inject({url:'/portal/'+tenant+'/model-costs',headers:{authorization:'Bearer '+'p'.repeat(40)}});assert.equal(result.statusCode,200);assert.equal(result.json().budgetOccupiedMicroUSD,'30');assert.equal(result.json().calls,1);assert.equal(result.json().tokens.input,null);
  assert.equal((await app.inject({url:'/portal/'+other+'/model-costs',headers:{authorization:'Bearer '+'p'.repeat(40)}})).statusCode,403);
  const empty=await app.inject({url:'/portal/'+other+'/model-costs',headers:{authorization:'Bearer '+'q'.repeat(40)}});assert.equal(empty.statusCode,200);assert.equal(empty.json().calls,0);  await app.listen({host:'127.0.0.1',port:0});const url='http://127.0.0.1:'+(app.server.address() as any).port;
  const portal=remoteIntakePortal(url,{[tenant]:'p'.repeat(40),[other]:'q'.repeat(40)},scope);
  const projection=await operations(f.reviewer.chain,tenant,{intakePortal:portal});assert.equal(projection.modelCosts.state,'available');assert.equal(projection.modelCosts.budgetOccupiedMicroUSD,'30');
  assert.equal((await operations(f.reviewer.chain,other,{intakePortal:portal})).modelCosts.calls,0);
  assert.equal((await operations(f.reviewer.chain,tenant,{intakePortal:remoteIntakePortal(url,{[tenant]:'p'.repeat(40)},'wrong')})).modelCosts.state,'unavailable');
  await app.close();assert.equal((await operations(f.reviewer.chain,tenant,{intakePortal:portal})).modelCosts.state,'unavailable');
  assert.throws(()=>jobs.costSnapshot(tenant,{config:{scope:'wrong',price:{model:'stub-semantic-v1'}}} as ModelSpend),/SCOPE_OR_VERSION/);
 }finally{await app.close();ledger.close();f.close();await f.c.connection.close();}
});
