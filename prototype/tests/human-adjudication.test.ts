import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeHumanAdjudication,compareHumanDecision} from '../packages/service/human-adjudication.ts';
import {hash} from '../packages/service/store.ts';

test('human declaration is bound before evaluation, complete and immutable, without certifying independence',()=>{
 const corpus={version:'synthetic',cases:['a','b']},at='2026-10-23T09:00:00Z';
 const input={schema:'l2-human-adjudication-v1',corpusHash:hash(corpus),reviewer:'synthetic reviewer',independenceStatement:'test declaration only',decidedAt:'2026-10-23T08:59:00Z',cases:[{id:'a',expected:{state:'ready',net:'500'},reason:'synthetic fact review'},{id:'b',expected:{state:'manual'},reason:'conflicting evidence'}]};
 const freeze=(x:unknown)=>freezeHumanAdjudication(x,corpus,corpus.cases,at);
 const frozen=freeze(input);assert.equal(frozen.status,'provided_unverified');
 input.cases[0]!.reason='later edit';assert.notEqual(frozen.declaration.cases[0]!.reason,input.cases[0]!.reason);
 assert.throws(()=>freeze({...input,corpusHash:hash({other:true})}),/CORPUS/);
 for(const decidedAt of [at,'invalid','2026-10-24T00:00:00Z'])assert.throws(()=>freeze({...input,decidedAt}),/PREDECLARATION/);
 assert.throws(()=>freeze({...input,cases:[input.cases[0],input.cases[0]]}),/COVERAGE/);
 assert.throws(()=>freeze({...input,cases:input.cases.slice(1)}),/COVERAGE/);
 assert.throws(()=>freeze({...input,reviewer:''}),/REVIEWER/);
 for(const net of ['-1','1.2','1e6',500,null])assert.throws(()=>freeze({...input,cases:[{...input.cases[0],expected:{state:'ready',net}},input.cases[1]]}),/AMOUNT/);
 assert.equal(compareHumanDecision({state:'ready',net:'500'},{state:'ready',net:'499'}),false);
 assert.equal(compareHumanDecision({state:'manual'},{state:'ready',net:'500'}),false);
 assert.equal(compareHumanDecision({state:'manual'},{state:'manual',net:null}),true);
});
