import test from 'node:test';
import assert from 'node:assert/strict';
import {toFunctionSelector} from 'viem';
import {setup,manualScenario,H,U,id} from './chain-helper.ts';

test('AC16 recovery receipts remain restricted; only owner surplus is withdrawable and pools stay isolated',async()=>{
 const c=await setup();try{
  const {q,decision,final:paid}=await manualScenario(c),incident=decision.d.incidentId;
  await c.send(c.core,'setIncidentFreeze',[incident,true,H('verified downward adjustment')]);
  const reduced=await c.decision(q,decision.args[2] as any,incident,23000n*U,{reviewAmount:33000n*U});await c.send(c.core,'registerDecision',reduced.args);
  await c.send(c.usdc,'approve',[c.vault.address,10000n*U],'insured');await c.send(c.core,'returnRecovery',[incident,10000n*U,id()],'insured');
  const recovered=await c.state(q,incident),other=await c.state(undefined,undefined,c.vault2,c.usdt),ownerCapital=await c.read(c.vault,'capitalOf',[c.accounts.treasurer.address]);
  const W=recovered.pool.A_U_W[2];assert.equal(W,paid.pool.A_U_W[2]);assert.equal(recovered.pool.H,20000n*U);
  for(const extra of [1n,10000n*U,recovered.pool.H,recovered.pool.B,recovered.pool.K]){
   await c.rejects(c.core,'withdrawCapital',[c.vault.address,W+extra],'treasurer',/InsufficientCapital/);
   assert.deepEqual(await c.state(q,incident),recovered);assert.equal(await c.read(c.vault,'capitalOf',[c.accounts.treasurer.address]),ownerCapital);
  }
  await c.send(c.core,'grantRole',[H('TREASURER'),c.accounts.outsider.address]);
  for(const vault of [c.vault,c.vault2])await c.rejects(c.core,'withdrawCapital',[vault.address,1n],'outsider',/InsufficientCapital/);
  await c.rejects(c.vault,'pay',[c.accounts.outsider.address,1n],'governor',new RegExp('OnlyCore|'+toFunctionSelector('OnlyCore()')));
  const ownerBalance=await c.read(c.usdc,'balanceOf',[c.accounts.treasurer.address]);
  await c.send(c.core,'withdrawCapital',[c.vault.address,W],'treasurer');
  const after=await c.state(q,incident);assert.equal(after.pool.A_U_W[2],0n);assert.equal(after.pool.A_U_W[0],after.pool.H+after.pool.K+after.pool.B+after.pool.A_U_W[1]);
  assert.equal(await c.read(c.usdc,'balanceOf',[c.accounts.treasurer.address]),ownerBalance+W);assert.equal(await c.read(c.vault,'capitalOf',[c.accounts.treasurer.address]),ownerCapital-W);
  assert.deepEqual(after.incident,recovered.incident);assert.deepEqual(after.policy,recovered.policy);assert.deepEqual(await c.state(undefined,undefined,c.vault2,c.usdt),other);
  await c.rejects(c.core,'withdrawCapital',[c.vault.address,1n],'treasurer',/InsufficientCapital/);assert.deepEqual(await c.state(q,incident),after);
  console.log('Withdrawal evidence:',c.save('withdrawal-recovery',{status:'passed',recovered,after,other}));
 }finally{await c.connection.close();}
});
