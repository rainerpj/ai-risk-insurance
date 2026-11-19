import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenAIAdapter,type ModelCallRecord} from '../packages/service/openai-adapter.ts';
import {agentTools,runAgent} from '../packages/service/agent.ts';
import {semanticFixture} from './m2c-fixture.ts';
const model='fixture-model-snapshot',key='synthetic-test-credential';
const input=()=>({prompt:'Return JSON.',messages:[{role:'user',content:{refs:[]}}],tools:agentTools,maxOutputTokens:100,signal:new AbortController().signal});
const envelope=(output:any[],rest:any={})=>({id:'resp_test',model,status:'completed',output,usage:{input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:5}},...rest});
const message=(text:string)=>({type:'message',role:'assistant',content:[{type:'output_text',text}]});

test('Responses transport maps bounded read-only function loop and never reports mocked calls as real validation',async()=>{
 const f=await semanticFixture(),records:ModelCallRecord[]=[],requests:any[]=[];
 try{
  const transport:typeof fetch=async(url,options)=>{
   assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options?.redirect,'error');assert.equal((options?.headers as any).authorization,'Bearer '+key);
   const body=JSON.parse(options!.body as string);requests.push(body);assert.equal(body.store,false);assert.equal(body.model,model);assert.equal(body.parallel_tool_calls,false);assert(body.tools.every((t:any)=>t.type==='function'&&t.strict&&t.parameters.additionalProperties===false));assert.deepEqual(body.tools.map((t:any)=>t.name),agentTools);
   assert(body.input.some((m:any)=>m.role==='user'&&/json/i.test(m.content)),'JSON mode requires JSON in input messages, not only instructions');
   return Response.json(envelope(requests.length===1?[{type:'reasoning',id:'rs_test',summary:[{text:'not for logs'}],encrypted_content:'opaque-transient-state'},{type:'function_call',call_id:'call_1',name:'readTerms',arguments:'{}'}]:[message(JSON.stringify(f.proposal))]));
  };
  const adapter=new OpenAIAdapter({model,key:()=>key,record:r=>records.push(r)},transport),result=await runAgent(adapter,f.tools,f.refs);
  assert.equal(result.kind,'stub');assert.equal(result.proposal.route,'recommend');assert.equal(result.calls,2);assert.equal(result.tokens,60);assert.equal(result.usageComplete,true);assert.equal(result.semanticValidated,false);
  assert.equal(requests[1].input[1].type,'reasoning');assert.equal(requests[1].input[2].type,'function_call');assert.equal(requests[1].input[3].type,'function_call_output');assert.equal(requests[1].input[2].call_id,requests[1].input[3].call_id);
  for(const forbidden of [key,'opaque-transient-state','not for logs'])assert(!JSON.stringify({result,records}).includes(forbidden));
  assert(records.every(r=>r.inputTokens===20&&r.cachedInputTokens===5&&r.finishedAt>=r.startedAt));
  console.log('OpenAI mock protocol evidence:',f.c.save('openai-mock-protocol',{result,records,transport:'mock; no API credential or network call'}));
 }finally{f.close();await f.c.connection.close();}
});

test('provider failures and invalid outputs produce sanitized records with unknown usage kept null',async()=>{
 const cases:[any,string][]=[
  [new Response('secret '+key,{status:401}),'MODEL_AUTH_FAILED'],[new Response(key,{status:429}),'MODEL_RATE_LIMITED'],
  [Response.json(envelope([],{status:'incomplete'})),'MODEL_INCOMPLETE'],
  [Response.json(envelope([message('{}')],{model:'another-snapshot'})),'MODEL_VERSION_MISMATCH'],
  [Response.json(envelope([{type:'function_call',call_id:'x',name:'signPayment',arguments:'{}'}])),'MODEL_TOOL_SCHEMA'],
  [Response.json(envelope([{type:'message',role:'assistant',content:[{type:'refusal',refusal:key}]}])),'MODEL_REFUSAL'],
  [Response.json(envelope([message('{}')],{usage:null})),'MODEL_USAGE_SCHEMA'],
  [new Response('{bad '+key),'MODEL_RESPONSE_JSON'],[new Response('x'.repeat(1048577)),'MODEL_RESPONSE_SIZE']
 ];
 for(const [response,reason] of cases){const records:ModelCallRecord[]=[];const adapter=new OpenAIAdapter({model,key:()=>key,record:r=>records.push(r)},async()=>response);
  await assert.rejects(()=>adapter.respond(input()),new RegExp(reason));assert.equal(records.length,1);assert.equal(records[0]!.status,'failed');assert(!JSON.stringify(records).includes(key));
  if(['MODEL_AUTH_FAILED','MODEL_RATE_LIMITED','MODEL_USAGE_SCHEMA','MODEL_RESPONSE_JSON','MODEL_RESPONSE_SIZE'].includes(reason))assert.equal(records[0]!.inputTokens,null);
  else assert.equal(records[0]!.inputTokens,20);
 }
 const records:ModelCallRecord[]=[];await assert.rejects(()=>new OpenAIAdapter({model,key:()=>key,record:r=>records.push(r)},async()=>{throw Error(key);}).respond(input()),/MODEL_TRANSPORT_FAILED/);assert(!JSON.stringify(records).includes(key));
 await assert.rejects(()=>new OpenAIAdapter({model,key:()=>'',record:()=>{}},async()=>{throw Error('must not call');}).respond(input()),/MODEL_CREDENTIAL_REQUIRED/);
});

test('audit failure, response cancellation and duplicate tool ids stop the loop',async()=>{
 const f=await semanticFixture();try{
  const failing=new OpenAIAdapter({model,key:()=>key,record:()=>{throw Error('disk full');}},async()=>Response.json(envelope([message(JSON.stringify(f.proposal))])));
  const result=await runAgent(failing,f.tools,f.refs);assert.equal(result.proposal.route,'manual');assert.equal(result.proposal.reason,'MODEL_AUDIT_FAILED');assert.equal(result.calls,1);assert.equal(result.usageComplete,false);
  const duplicate=new OpenAIAdapter({model,key:()=>key,record:()=>{}},async()=>Response.json(envelope([{type:'function_call',call_id:'same',name:'readTerms',arguments:'{}'}])));
  const repeated=await runAgent(duplicate,f.tools,f.refs);assert.equal(repeated.proposal.reason,'DUPLICATE_TOOL_CALL');assert.equal(repeated.calls,2);
  let aborted=false;const hanging=new OpenAIAdapter({model,key:()=>key,record:()=>{}},async(_url,options)=>new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>{aborted=true;reject(Error(key));})));
  const timeout=await runAgent(hanging,f.tools,f.refs,{timeoutMs:10});assert.equal(timeout.proposal.route,'manual');assert.equal(aborted,true);assert.equal(timeout.usageComplete,false);
 }finally{f.close();await f.c.connection.close();}
});
