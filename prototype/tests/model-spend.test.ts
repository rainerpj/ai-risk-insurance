import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {ModelSpend,estimatedMicroUSD,type ModelSpendConfig} from '../packages/service/model-spend.ts';
import {OpenAIAdapter,type ModelCallRecord} from '../packages/service/openai-adapter.ts';
import {agentTools} from '../packages/service/agent.ts';
const config:ModelSpendConfig={scope:'fixture',price:{version:'synthetic-v1',model:'fixture-model',input:'1000000',cachedInput:'100000',output:'2000000'},globalLimit:'500',runLimit:'300',runCalls:3,maxInputTokens:1000};
const digest='a'.repeat(64);
function fixture(c=config){mkdirSync('.local',{recursive:true});const path=`.local/model-cost-${randomUUID()}.sqlite`;return {path,b:new ModelSpend(path,c,true)};}
const record=(over:Partial<ModelCallRecord>={}):ModelCallRecord=>({model:'fixture-model',responseModel:'fixture-model',responseId:'resp_fixture',status:'complete',inputTokens:20,cachedInputTokens:10,outputTokens:10,startedAt:1,finishedAt:2,...over});
const input=()=>({prompt:'Return JSON',messages:[{role:'user',content:{refs:[]}}],tools:agentTools,maxOutputTokens:100,signal:new AbortController().signal});
const response=()=>Response.json({id:'resp_fixture',model:'fixture-model',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{}'}]}],usage:{input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:10}}});

test('integer price snapshots, reservation, known cost settlement and restart preserve limits and forbid replay',()=>{
 const {b,path}=fixture();
 assert.equal(estimatedMicroUSD({...config.price,input:'1',cachedInput:'0',output:'1'},1,0,1),'1');
 assert.throws(()=>estimatedMicroUSD(config.price,1,2,0),/SCHEMA/);
 const id=b.reserve('run',1,digest,'fixture-model',20,100);assert.equal(b.usage().estimatedMicroUSD,'220');
 b.settle(id,record());b.settle(id,record());assert.equal(b.usage().estimatedMicroUSD,'31');assert.equal(b.usage().unknown,0);
 assert.throws(()=>b.settle(id,record({outputTokens:11})),/CONFLICT/);b.close();
 const reopened=new ModelSpend(path,config);try{
  assert.equal(reopened.usage().estimatedMicroUSD,'31');assert.throws(()=>reopened.reserve('run',1,digest,'fixture-model',20,100),/REPLAY/);
  const second=reopened.reserve('run',2,digest,'fixture-model',20,100);reopened.settle(second,record());
  const third=reopened.reserve('run',3,digest,'fixture-model',20,100);reopened.settle(third,record());
  assert.throws(()=>reopened.reserve('run',4,digest,'fixture-model',1,1),/EXCEEDED/);
 }finally{reopened.close();}
 assert.throws(()=>new ModelSpend(path,{...config,globalLimit:'501'}),/CONFIG_MISMATCH/);
 assert.throws(()=>new ModelSpend(path,config,true),/NEW_ONLY/);
 assert.throws(()=>new ModelSpend(path+'-missing',config),/DATABASE_MISSING/);
});

test('unknown usage retains full reservation; overrun charges actual estimate and durably pauses new work',()=>{
 const {b,path}=fixture();const id=b.reserve('unknown',1,digest,'fixture-model',20,100);
 b.settle(id,record({responseModel:undefined,inputTokens:null,outputTokens:null,cachedInputTokens:null,status:'failed',reason:'MODEL_TRANSPORT_FAILED'}));
 assert.equal(b.usage().estimatedMicroUSD,'220');assert.equal(b.usage().unknown,1);
 assert.throws(()=>b.reserve('unknown',2,digest,'fixture-model',1,1),/UNRESOLVED/);
 const over=b.reserve('over',1,digest,'fixture-model',1,1);assert.throws(()=>b.settle(over,record()),/OVERRUN/);
 assert.equal(b.usage().estimatedMicroUSD,'251');b.close();
 const restarted=new ModelSpend(path,config);try{assert.throws(()=>restarted.reserve('next',1,digest,'fixture-model',1,1),/PAUSED/);}finally{restarted.close();}
});

function worker(path:string,c:ModelSpendConfig,run:string,crash=false){return new Promise<number>((resolve,reject)=>{
 const source=`import {ModelSpend} from './packages/service/model-spend.ts';const b=new ModelSpend(${JSON.stringify(path)},${JSON.stringify(c)});try{b.reserve(${JSON.stringify(run)},1,${JSON.stringify(digest)},'fixture-model',20,100);${crash?'process.exit(73)':'process.exitCode=0'};}catch(e){if(e.message==='MODEL_COST_EXCEEDED')process.exitCode=7;else throw e;}finally{b.close();}`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('exit',code=>code===0||code===7||code===73?resolve(code):reject(Error(error)));
});}
test('opening the ledger waits for a competing process before changing journal mode',async()=>{
 const {b,path}=fixture();b.db.exec('PRAGMA journal_mode=DELETE');b.close();
 const source=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(path)});db.exec('BEGIN EXCLUSIVE');process.stdout.write('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},400);`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let error='';child.stderr.on('data',d=>error+=d);
 const done=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error)));});
 await Promise.race([new Promise<void>(resolve=>child.stdout.once('data',()=>resolve())),done.then(()=>{throw Error('LOCK_NOT_ACQUIRED');})]);
 try{const reopened=new ModelSpend(path,config);try{assert.equal(reopened.usage().calls,0);assert.equal(reopened.db.prepare('PRAGMA journal_mode').get()?.journal_mode,'wal');}finally{reopened.close();}}
 finally{await done;}
});
test('eight actual processes cannot overspend global limit; pre-dispatch process exit keeps reservation after reopening',async()=>{
 const {b,path}=fixture();b.close();const codes=await Promise.all(Array.from({length:8},(_,i)=>worker(path,config,'parallel-'+i)));
 assert.equal(codes.filter(c=>c===0).length,2);assert.equal(codes.filter(c=>c===7).length,6);
 const reopened=new ModelSpend(path,config);try{assert.equal(reopened.usage().estimatedMicroUSD,'440');assert.equal(reopened.usage().unknown,2);}finally{reopened.close();}
 const crashed=fixture();crashed.b.close();assert.equal(await worker(crashed.path,config,'crash',true),73);
 const recovered=new ModelSpend(crashed.path,config);try{assert.equal(recovered.usage().estimatedMicroUSD,'220');assert.throws(()=>recovered.reserve('crash',1,digest,'fixture-model',20,100),/REPLAY/);assert.throws(()=>recovered.reserve('crash',2,digest,'fixture-model',20,100),/UNRESOLVED/);}finally{recovered.close();}
});

test('adapter counts full input before reserving and dispatching; errors never bypass durable money gate',async()=>{
 const {b}=fixture(),calls:any[]=[],records:ModelCallRecord[]=[];
 const transport:typeof fetch=async(url,options)=>{const body=JSON.parse(options!.body as string);calls.push({url,body});
  if(String(url).endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:20});
  assert.equal(b.usage().estimatedMicroUSD,'220');return response();
 };
 try{
  const adapter=new OpenAIAdapter({model:'fixture-model',key:()=> 'fake',record:r=>records.push(r),spend:{ledger:b,runId:'adapter'}},transport);
  assert.equal((await adapter.respond(input())).output,'{}');assert.equal(b.usage().estimatedMicroUSD,'31');assert.equal(calls.length,2);assert.equal(adapter.kind,'stub');
  for(const field of ['model','instructions','input','tools','tool_choice','parallel_tool_calls','text'])assert.deepEqual(calls[0].body[field],calls[1].body[field]);
  const retry=new OpenAIAdapter({model:'fixture-model',key:()=> 'fake',record:r=>records.push(r),spend:{ledger:b,runId:'adapter'}},transport);
  await assert.rejects(()=>retry.respond(input()),/REPLAY/);assert.equal(calls.length,3);
  const failed=new OpenAIAdapter({model:'fixture-model',key:()=> 'fake',record:()=>{},spend:{ledger:b,runId:'failure'}},async url=>{if(String(url).endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:20});throw Error('private transport text');});
  await assert.rejects(()=>failed.respond(input()),/TRANSPORT_FAILED/);assert.equal(b.usage().unknown,1);assert.equal(b.usage().estimatedMicroUSD,'251');
  await assert.rejects(()=>new OpenAIAdapter({model:'fixture-model',key:()=> 'fake',record:()=>{}}).respond(input()),/LEDGER_REQUIRED/);
 }finally{b.close();}
});

test('failed count, budget rejection, missing schema and excess input fail closed without generation',async()=>{
 for(const count of [null,{object:'response.input_tokens',input_tokens:1001},{object:'response.input_tokens',input_tokens:400}]){
  const {b}=fixture();let requests=0;
  try{const a=new OpenAIAdapter({model:'fixture-model',key:()=> 'fake',record:()=>{},spend:{ledger:b,runId:'bad'}},async url=>{requests++;assert(String(url).endsWith('/input_tokens'));return Response.json(count);});
   await assert.rejects(()=>a.respond(input()),/MODEL_TOKEN_COUNT_FAILED|MODEL_COST_REQUEST|MODEL_COST_EXCEEDED/);assert.equal(requests,1);assert.equal(b.usage().calls,0);
  }finally{b.close();}
 }
 const {b,path}=fixture();b.db.exec('DROP TABLE model_calls');b.close();assert.throws(()=>new ModelSpend(path,config),/SCHEMA/);
});

test('failed durable settlement suppresses successful provider output and retains reservation after restart',async()=>{
 const {b,path}=fixture();const a=new OpenAIAdapter({model:'fixture-model',key:()=> 'fake',record:()=>{},spend:{ledger:b,runId:'disk-failure'}},async url=>{
  if(String(url).endsWith('/input_tokens'))return Response.json({object:'response.input_tokens',input_tokens:20});
  b.close();return response();
 });
 await assert.rejects(()=>a.respond(input()),/MODEL_AUDIT_FAILED/);
 const recovered=new ModelSpend(path,config);try{assert.equal(recovered.usage().estimatedMicroUSD,'220');assert.equal(recovered.usage().unknown,1);assert.throws(()=>recovered.reserve('disk-failure',2,digest,'fixture-model',20,100),/UNRESOLVED/);}finally{recovered.close();}
});

test('cost projection separates settled estimates from unresolved occupancy and never expands an empty filter',()=>{
 const {b}=fixture();try{
  const a=b.reserve('tenant-a',1,digest,'fixture-model',20,100);b.settle(a,record());
  b.reserve('tenant-b',1,digest,'fixture-model',20,100);
  const unknown=b.reserve('tenant-a',2,digest,'fixture-model',20,100);b.settle(unknown,record({inputTokens:null,outputTokens:null,cachedInputTokens:null}));
  const own=b.snapshot(['tenant-a','tenant-a']);assert.equal(own.calls,2);assert.equal(own.settledEstimatedMicroUSD,'31');assert.equal(own.unresolvedReservedMicroUSD,'220');assert.equal(own.budgetOccupiedMicroUSD,'251');assert.equal(own.unknownCalls,1);assert.equal(own.reservedCalls,0);assert.equal(own.complete,false);assert.deepEqual(own.tokens,{knownCalls:1,input:'20',cachedInput:'10',output:'10'});
  const other=b.snapshot(['tenant-b']);assert.equal(other.calls,1);assert.equal(other.reservedCalls,1);assert.equal(other.tokens.input,null);assert.equal(other.settledEstimatedMicroUSD,'0');
  assert.equal(b.snapshot([]).calls,0);assert.equal(b.snapshot(['absent']).calls,0);assert(!JSON.stringify(own).includes('resp_fixture'));
 }finally{b.close();}
});
