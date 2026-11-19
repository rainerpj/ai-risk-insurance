import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaEnvironment,quotaReply,quotaReport} from '../scripts/evaluation-codex.ts';
test('quota report preserves bigint chain evidence without claiming API or human acceptance',()=>{
 const report=JSON.parse(quotaReport({rows:[{amount:5000000000n}],semanticAccepted:true},'synthetic-only'));
 assert.equal(report.rows[0].amount,'5000000000');assert.equal(report.semanticAccepted,false);
 assert.equal(report.apiProtocolAccepted,false);assert.equal(report.transport,'codex-exec-chatgpt');
});
test('quota subprocess strips API credentials and rejects native-tool or missing-usage evidence',()=>{
 const original={OPENAI_API_KEY:'synthetic',codex_api_key:'synthetic',PATH:'path'};
 assert.deepEqual(quotaEnvironment(original),{PATH:'path'});assert.equal(original.OPENAI_API_KEY,'synthetic');
 const completed=JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}),answer=JSON.stringify({output:'{}',toolCalls:null});
 assert.deepEqual(quotaReply(completed,answer),{output:'{}',inputTokens:20,outputTokens:10});
 assert.throws(()=>quotaReply(JSON.stringify({type:'item.completed',item:{type:'command_execution'}})+'\n'+completed,answer),/CODEX_NATIVE_TOOL_USED/);
 assert.throws(()=>quotaReply('{}',answer),/CODEX_TURN_FAILED/);
 assert.throws(()=>quotaReply(JSON.stringify({type:'turn.completed',usage:{}}),answer),/CODEX_USAGE_MISSING/);
 assert.throws(()=>quotaReply(completed,JSON.stringify({output:'{}',toolCalls:[]})),/CODEX_REPLY_SCHEMA/);
});
