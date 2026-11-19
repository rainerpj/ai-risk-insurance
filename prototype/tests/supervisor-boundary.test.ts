import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,U,id,H,zeroAddress} from './chain-helper.ts';
import {zeroHash} from '../packages/domain/typed-data.ts';

test('AC45 cumulative 50000.000001 needs coapproval even after partial payment; tiny installment cannot bypass supervisor',async()=>{
 const c=await setup();try{
  const q=await c.issue(),n=await c.notice(q),d=await c.decision(q,[n.n.noticeId],id(),50000n*U);
  assert.equal(d.s.supervisor,zeroAddress);await c.send(c.core,'registerDecision',d.args,'executor');
  const first=await c.payment(q,d.d.incidentId,25000n*U);await c.send(c.core,'executePayment',[first.p,first.sig],'executor');
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,true,H('cumulative revision')]);
  const changed=await c.decision(q,[n.n.noticeId],d.d.incidentId,50000n*U+1n),before=await c.state(q,d.d.incidentId);
  const missing=[...changed.args];missing[6]={decisionDigest:zeroHash,supervisor:zeroAddress,signerEpoch:0n,expiresAt:0n};missing[7]='0x';
  await c.rejects(c.core,'registerDecision',missing,'executor',/MissingSupervisor/);assert.deepEqual(await c.state(q,d.d.incidentId),before);
  await c.send(c.core,'registerDecision',changed.args,'executor');
  await c.send(c.core,'setIncidentFreeze',[d.d.incidentId,false,H('coapproval complete')]);
  const tiny=await c.payment(q,d.d.incidentId,1n);await c.send(c.core,'executePayment',[tiny.p,tiny.sig],'executor');
  const next=await c.payment(q,d.d.incidentId,1n);
  await c.send(c.core,'rotateEpoch',[c.accounts.supervisor.address]);
  const revoked=await c.state(q,d.d.incidentId);
  await c.rejects(c.core,'executePayment',[next.p,next.sig],'executor',/InvalidEpoch/);
  assert.deepEqual(await c.state(q,d.d.incidentId),revoked);
  assert.equal(revoked.incident.P,25000n*U+1n);assert.equal(revoked.incident.D,25000n*U);
  console.log('Supervisor boundary evidence:',c.save('supervisor-boundary',{status:'passed',final:revoked}));
 }finally{await c.connection.close();}
});
