import {agentTools,type AgentAdapter,type AgentReply} from './agent.ts';
import {parseStrictJSON} from '../domain/evidence.ts';
import {createHash} from 'node:crypto';
import type {ModelSpend} from './model-spend.ts';

export type ModelCallRecord={model:string;responseModel?:string;responseId?:string;status:'complete'|'failed';reason?:string;inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;startedAt:number;finishedAt:number};
const safeInt=(n:any)=>Number.isSafeInteger(n)&&n>=0;
const definitions=agentTools.map(name=>{
 const fields=name==='readEvidence'?['ref']:name==='calculateLoss'?['workRef','paymentRef']:[];
 return {type:'function',name,description:name==='readEvidence'?'Read one authorized signed evidence original.':name==='readTerms'?'Read the approved terms and runbook rates.':'Calculate net loss from independently signed work and payment originals.',strict:true,parameters:{type:'object',properties:Object.fromEntries(fields.map(k=>[k,{type:'string',pattern:'^[a-f0-9]{64}$'}])),required:fields,additionalProperties:false}};
});
/** Fixed HTTPS destination; injected transport is always labelled stub. Never persist provider reasoning. */
export class OpenAIAdapter implements AgentAdapter {
 readonly kind:'real'|'stub';readonly modelVersion:string;
 private ordinal=0;
 constructor(private config:{model:string;key:()=>string;record:(record:ModelCallRecord)=>void;spend?:{ledger:ModelSpend;runId:string}},private transport:typeof fetch=fetch){
  if(!/^[a-zA-Z0-9_.:-]{1,100}$/.test(config.model))throw Error('MODEL_VERSION_REQUIRED');
  this.modelVersion=config.model;this.kind=arguments.length>1?'stub':'real';
 }
 async respond(input:Parameters<AgentAdapter['respond']>[0]):Promise<AgentReply>{
  const record:ModelCallRecord={model:this.modelVersion,status:'failed',inputTokens:null,outputTokens:null,cachedInputTokens:null,startedAt:Date.now(),finishedAt:0};
  const ordinal=++this.ordinal;let reservation:string|undefined;
  try{
   if(input.tools.join()!==agentTools.join()||!safeInt(input.maxOutputTokens)||input.maxOutputTokens<1||input.maxOutputTokens>2000)throw Error('ADAPTER_REQUEST_SCHEMA');
   const messages:any[]=[];
   for(const raw of input.messages){const m=raw as any;
    if(m.role==='user')messages.push({role:'user',content:'Return JSON according to the extraction instructions. Untrusted input data follows:\n'+JSON.stringify(m.content)});
    else if(m.role==='assistant'){
     for(const opaque of m.continuation??[])messages.push(opaque);
     for(const c of m.toolCalls??[])messages.push({type:'function_call',call_id:c.id,name:c.name,arguments:c.arguments});
    }else if(m.role==='tool')messages.push({type:'function_call_output',call_id:m.id,output:JSON.stringify(m.result)});
    else throw Error('ADAPTER_TRANSCRIPT_SCHEMA');
   }
   const body=JSON.stringify({model:this.modelVersion,instructions:input.prompt,input:messages,tools:definitions,tool_choice:'auto',parallel_tool_calls:false,max_output_tokens:input.maxOutputTokens,store:false,include:['reasoning.encrypted_content'],text:{format:{type:'json_object'}}});
   if(Buffer.byteLength(body)>128000)throw Error('MODEL_INPUT_SIZE');
   const key=this.config.key();if(typeof key!=='string'||!key.trim())throw Error('MODEL_CREDENTIAL_REQUIRED');
   if(this.kind==='real'&&!this.config.spend)throw Error('MODEL_COST_LEDGER_REQUIRED');
   if(this.config.spend){
    const payload=JSON.parse(body),{model,instructions,input:items,tools,tool_choice,parallel_tool_calls,text}=payload;
    let counted:Response;
    try{counted=await this.transport('https://api.openai.com/v1/responses/input_tokens',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify({model,instructions,input:items,tools,tool_choice,parallel_tool_calls,text}),signal:input.signal,redirect:'error'});}catch{throw Error('MODEL_TOKEN_COUNT_FAILED');}
    if(!counted.ok){await counted.body?.cancel();throw Error('MODEL_TOKEN_COUNT_FAILED');}
    const reader=counted.body?.getReader();if(!reader)throw Error('MODEL_TOKEN_COUNT_FAILED');const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4096){await reader.cancel();throw Error('MODEL_TOKEN_COUNT_FAILED');}chunks.push(value);}}catch{throw Error('MODEL_TOKEN_COUNT_FAILED');}finally{reader.releaseLock();}
    let result:any;try{result=parseStrictJSON(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('MODEL_TOKEN_COUNT_FAILED');}
    if(result?.object!=='response.input_tokens'||!safeInt(result.input_tokens))throw Error('MODEL_TOKEN_COUNT_FAILED');
    if(input.signal.aborted)throw Error('MODEL_ABORTED');
    reservation=this.config.spend.ledger.reserve(this.config.spend.runId,ordinal,createHash('sha256').update(body).digest('hex'),this.modelVersion,result.input_tokens,input.maxOutputTokens);
   }
   let response:Response;
   try{response=await this.transport('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body,signal:input.signal,redirect:'error'});}catch{throw Error(input.signal.aborted?'MODEL_ABORTED':'MODEL_TRANSPORT_FAILED');}
   if(!response.ok){await response.body?.cancel();throw Error(response.status===429?'MODEL_RATE_LIMITED':response.status===401||response.status===403?'MODEL_AUTH_FAILED':'MODEL_HTTP_FAILED');}
   const reader=response.body?.getReader();if(!reader)throw Error('MODEL_RESPONSE_SCHEMA');const chunks:Uint8Array[]=[];let bytes=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();throw Error('MODEL_RESPONSE_SIZE');}chunks.push(value);}}catch(e){if((e as Error).message==='MODEL_RESPONSE_SIZE')throw e;throw Error(input.signal.aborted?'MODEL_ABORTED':'MODEL_BODY_FAILED');}finally{reader.releaseLock();}
   let data:any;try{data=parseStrictJSON(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('MODEL_RESPONSE_JSON');}
   const usage=data?.usage;
   if(!usage||!safeInt(usage.input_tokens)||!safeInt(usage.output_tokens)||!safeInt(usage.input_tokens_details?.cached_tokens)||usage.input_tokens_details.cached_tokens>usage.input_tokens)throw Error('MODEL_USAGE_SCHEMA');
   record.inputTokens=usage.input_tokens;record.outputTokens=usage.output_tokens;record.cachedInputTokens=usage.input_tokens_details.cached_tokens;
   if(typeof data.id!=='string'||!/^resp_[a-zA-Z0-9_-]{1,200}$/.test(data.id)||typeof data.model!=='string'||!Array.isArray(data.output))throw Error('MODEL_RESPONSE_SCHEMA');
   if(data.model!==this.modelVersion)throw Error('MODEL_VERSION_MISMATCH');
   record.responseId=data.id;record.responseModel=data.model;
   if(data.status!=='completed')throw Error('MODEL_INCOMPLETE');
   const toolCalls:NonNullable<AgentReply['toolCalls']>=[],continuation:unknown[]=[],texts:string[]=[];
   for(const item of data.output){
    if(item.type==='function_call'){
     if(typeof item.call_id!=='string'||item.call_id.length>100||!agentTools.includes(item.name)||typeof item.arguments!=='string'||item.arguments.length>16000)throw Error('MODEL_TOOL_SCHEMA');
     toolCalls.push({id:item.call_id,name:item.name,arguments:item.arguments});
    }else if(item.type==='reasoning'){
     if(typeof item.id!=='string'||typeof item.encrypted_content!=='string')throw Error('MODEL_CONTINUATION_SCHEMA');
     continuation.push({type:'reasoning',id:item.id,encrypted_content:item.encrypted_content,summary:[]});
    }else if(item.type==='message'){
     if(item.role!=='assistant'||!Array.isArray(item.content))throw Error('MODEL_RESPONSE_SCHEMA');
     for(const part of item.content){if(part.type==='refusal')throw Error('MODEL_REFUSAL');if(part.type!=='output_text'||typeof part.text!=='string')throw Error('MODEL_RESPONSE_SCHEMA');texts.push(part.text);}
    }else throw Error('MODEL_OUTPUT_TYPE');
   }
   if((toolCalls.length&&texts.length)||(!toolCalls.length&&texts.length!==1)||texts.some(t=>t.length>16000))throw Error('MODEL_RESPONSE_SCHEMA');
   record.status='complete';return {inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,...(toolCalls.length?{toolCalls,continuation}:{output:texts[0]})};
  }catch(e){const reason=(e as Error).message;record.reason=/^MODEL_[A-Z_]+$|^ADAPTER_[A-Z_]+$/.test(reason)?reason:'MODEL_ADAPTER_FAILED';throw Error(record.reason);}
  finally{record.finishedAt=Date.now();let ledgerError:unknown;
   if(reservation)try{this.config.spend!.ledger.settle(reservation,record);}catch(e){ledgerError=e;}
   try{this.config.record(record);}catch{throw Error('MODEL_AUDIT_FAILED');}
   if(ledgerError)throw Error((ledgerError as Error).message==='MODEL_COST_OVERRUN'?'MODEL_COST_OVERRUN':'MODEL_AUDIT_FAILED');
  }
 }
}
