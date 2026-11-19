import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,H} from './chain-helper.ts';
import {decisionContentHash,digest} from '../packages/domain/typed-data.ts';

test('AC05 insured and FDE cannot assess or approve their own policy even after role grant',async()=>{
 const c=await setup(),outcomes:string[]=[];
 try{
  const q=await c.issue(),n=await c.notice(q);let snapshot=await c.connection.provider.request({method:'evm_snapshot'});
  for(const who of ['insured','fde'] as const)for(const role of ['ASSESSOR','CLAIM_APPROVER'] as const){
   assert.equal(await c.connection.provider.request({method:'evm_revert',params:[snapshot]}),true);snapshot=await c.connection.provider.request({method:'evm_snapshot'});
   c.label(who+'-'+role);const d=await c.decision(q,[n.n.noticeId]);
   const assessor=role==='ASSESSOR'?who:'assessor',approver=role==='CLAIM_APPROVER'?who:'approver';
   d.d.approver=c.accounts[approver].address;d.d.signerEpoch=await c.read(c.core,'epochs',[d.d.approver]);
   d.a.assessor=c.accounts[assessor].address;d.a.signerEpoch=await c.read(c.core,'epochs',[d.a.assessor]);
   d.a.decisionContentHash=decisionContentHash(d.d);d.d.assessmentHash=digest('Assessment',d.a,c.scope);
   d.args[4]=await c.sign('Assessment',d.a,assessor);d.args[5]=await c.sign('ClaimDecision',d.d,approver);
   const before=await c.state(q,d.d.incidentId);
   await c.rejects(c.core,'registerDecision',d.args,'executor');
   await c.send(c.core,'grantRole',[H(role),c.accounts[who].address]);
   // Role grants rotate epochs; prove self-review rejection with current, correctly signed authorization.
   d.d.signerEpoch=await c.read(c.core,'epochs',[d.d.approver]);d.a.signerEpoch=await c.read(c.core,'epochs',[d.a.assessor]);
   d.a.decisionContentHash=decisionContentHash(d.d);d.d.assessmentHash=digest('Assessment',d.a,c.scope);
   d.args[4]=await c.sign('Assessment',d.a,assessor);d.args[5]=await c.sign('ClaimDecision',d.d,approver);
   await c.rejects(c.core,'registerDecision',d.args,'executor',/SelfReview/);
   assert.deepEqual(await c.state(q,d.d.incidentId),before);assert.equal(await c.read(c.core,'usedDecisionIds',[d.d.decisionId]),false);
   await c.rejects(c.core,'grantRole',[H(role==='ASSESSOR'?'CLAIM_APPROVER':'ASSESSOR'),c.accounts[who].address],'governor',/RoleConflict/);
   outcomes.push(who+'-'+role);
  }
  console.log('Independence evidence:',c.save('claim-independence',{status:'passed',cases:outcomes}));
 }finally{await c.connection.close();}
});
