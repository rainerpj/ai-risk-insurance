import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,U,H,id} from './chain-helper.ts';

test('AC10 verified same-incident notices use cumulative loss and one incident limit',async()=>{
 const c=await setup();
 try{
  const q=await c.issue({incidentLimit:40000n*U}),n1=await c.notice(q),incident=id();
  const first=await c.decision(q,[n1.n.noticeId],incident,30000n*U);await c.send(c.core,'registerDecision',first.args);
  const pay=await c.payment(q,incident,8000n*U);await c.send(c.core,'executePayment',[pay.p,pay.sig],'executor');
  const n2=await c.notice(q,{incidentCommitment:n1.n.incidentCommitment});
  await c.send(c.core,'setIncidentFreeze',[incident,true,H('verified same incident additional evidence')]);
  const revised=await c.decision(q,[n1.n.noticeId,n2.n.noticeId],incident,33000n*U);await c.send(c.core,'registerDecision',revised.args);
  let state=await c.state(q,incident);assert.equal(state.incident.P,8000n*U);assert.equal(state.incident.N,33000n*U);assert.equal(state.incident.D,25000n*U);assert.equal(state.policy.dueTotal,25000n*U);
  for(const notice of [n1,n2]){
   assert.equal((await c.read(c.core,'getNotice',[notice.n.noticeId])).incidentId,incident);
   const split=await c.decision(q,[notice.n.noticeId],id(),1000n*U);
   await c.rejects(c.core,'registerDecision',split.args,'executor',/NoticeConflict/);assert.deepEqual(await c.state(q,incident),state);
  }
  // Additional cumulative loss exceeds the incident limit; the reviewer must cap the total, not add a new limit.
  const excessive=await c.decision(q,[n1.n.noticeId,n2.n.noticeId],incident,45000n*U);
  await c.rejects(c.core,'registerDecision',excessive.args,'executor',/AmountMismatch/);assert.deepEqual(await c.state(q,incident),state);
  const capped=await c.decision(q,[n1.n.noticeId,n2.n.noticeId],incident,45000n*U,{netApproved:40000n*U});await c.send(c.core,'registerDecision',capped.args);
  await c.send(c.core,'setIncidentFreeze',[incident,false,H('cumulative limit verified')]);
  const remaining=await c.payment(q,incident,32000n*U);await c.send(c.core,'executePayment',[remaining.p,remaining.sig],'executor');
  state=await c.state(q,incident);assert.equal(state.incident.P,40000n*U);assert.equal(state.incident.D,0n);assert.equal(state.policy.paidTotal,40000n*U);
  console.log('Cumulative evidence:',c.save('cumulative-claim',{status:'passed',incident,noticeIds:[n1.n.noticeId,n2.n.noticeId],final:state}));
 }finally{await c.connection.close();}
});
