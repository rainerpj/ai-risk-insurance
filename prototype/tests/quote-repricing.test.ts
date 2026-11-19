import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,U,H,json} from './chain-helper.ts';
import {calculateQuote} from '../packages/domain/pricing.ts';

test('AC32 signed snapshot and formula reject tampering; repricing only changes a new policy capacity',async()=>{
 const c=await setup();try{
  const first=calculateQuote({p:'0.001',q:'0.01',k:'1.2',tasks:10000n,mode:'budget',amount:6000n*U});
  const x=await c.quote({premium:first.input.amount,annualLimit:first.output,incidentLimit:first.output,riskSnapshotHash:H(json(first))});
  const before=await c.state(x.q);
  for(const change of [{formulaVersion:H('unapproved-formula')},{riskSnapshotHash:H('changed-input')},{annualLimit:x.q.annualLimit+1n},{premium:x.q.premium+1n}]){
   c.label('unsigned quote mutation '+Object.keys(change)[0]);
   await c.rejects(c.core,'purchasePolicy',[{...x.q,...change},x.sig],'insured',/AccessControlUnauthorizedAccount/);
   assert.deepEqual(await c.state(x.q),before);
   assert.equal(await c.read(c.core,'quoteUsed',[x.q.quoteId]),false);
  }
  const unlisted={...x.q,formulaVersion:H('unapproved-formula')};
  await c.rejects(c.core,'purchasePolicy',[unlisted,await c.sign('Quote',unlisted,'underwriter')],'insured',/InvalidInput/);
  assert.deepEqual(await c.state(x.q),before);
  await c.send(c.core,'purchasePolicy',[x.q,x.sig],'insured');
  await c.connection.provider.request({method:'evm_setNextBlockTimestamp',params:[Number(x.q.startAt)]});
  await c.connection.provider.request({method:'evm_mine'});
  const original=await c.read(c.core,'getPolicy',[x.q.quoteId]),K=await c.read(c.vault,'K');
  assert.equal(K,first.output);
  const second=calculateQuote({...first.input,p:'0.002'});
  const next=await c.quote({premium:second.input.amount,annualLimit:second.output,incidentLimit:second.output,riskSnapshotHash:H(json(second))});
  assert(second.output<first.output);assert.notEqual(next.q.riskSnapshotHash,x.q.riskSnapshotHash);
  assert.deepEqual(await c.read(c.core,'getPolicy',[x.q.quoteId]),original);
  assert.equal(await c.read(c.vault,'K'),K);
  c.label('new risk quote locks new capacity without rewriting old policy');
  await c.send(c.core,'purchasePolicy',[next.q,next.sig],'insured');
  const newPolicy=await c.read(c.core,'getPolicy',[next.q.quoteId]);
  assert.equal(newPolicy.quote.annualLimit,second.output);
  assert.equal(newPolicy.quote.riskSnapshotHash,H(json(second)));
  assert.deepEqual(await c.read(c.core,'getPolicy',[x.q.quoteId]),original);
  assert.equal(await c.read(c.vault,'K'),first.output+second.output);
  console.log('Quote repricing evidence:',c.save('quote-repricing',{status:'passed',first,second,original,newPolicy,finalK:await c.read(c.vault,'K')}));
 }finally{await c.connection.close();}
});
