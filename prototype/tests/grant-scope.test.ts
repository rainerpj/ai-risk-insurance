import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,U} from './chain-helper.ts';
import {H} from '../packages/service/reviewer.ts';

test('AC38 missing or out-of-scope Grant cannot authorize; assessment alone cannot register or pay',async()=>{
 const f=await autoFixture(),{c}=f;try{
  await f.enable();const initial=await f.reviewer.assess(f.request);
  await assert.rejects(f.reviewer.assess({...f.request,grantId:id()}),/REVIEWER_IDENTITY/);
  await assert.rejects(f.authorizer.authorize({...f.request,grantId:id()},initial.a,initial.signature),/MANUAL_REQUIRED/);
  for(const field of ['insurerId','token','enterpriseId','fdeId','productId','workflowHash','scopeHash','templateId','ruleVersion','modelVersion'] as const){
   const snapshot=await c.connection.provider.request({method:'evm_snapshot'}),before=await c.state(f.q);
   try{
    await c.send(f.registry,'configure',[f.request.grantId,{...f.g,[field]:field==='token'?c.usdt.address:H('outside '+field)}]);
    if(['scopeHash','templateId','ruleVersion','modelVersion'].includes(field))await assert.rejects(f.reviewer.assess(f.request),/PROFILE_.*MISMATCH/);
    else{
     const assessed=await f.reviewer.assess(f.request);
     await assert.rejects(f.authorizer.authorize(f.request,assessed.a,assessed.signature),/GrantInvalid/);
    }
    assert.equal(f.budget.all('SELECT * FROM reservations').length,0);assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
    assert.deepEqual(await c.state(f.q),before);
   }finally{await c.connection.provider.request({method:'evm_revert',params:[snapshot]});}
  }
  await c.rejects(f.registry,'configure',[f.request.grantId,{...f.g,reviewer:f.g.authorizer}],'governor',/GrantInvalid/);
  await assert.rejects(f.authorizer.authorize(f.request,{...initial.a,assessor:f.g.authorizer},initial.signature),/INDEPENDENT_ASSESSMENT_REQUIRED/);
  const job=await f.authorizer.authorize(f.request,initial.a,initial.signature),forged=[...job.args];forged[5]=initial.signature;
  const before=await c.state(f.q,job.args[0].incidentId);
  await c.rejects(c.core,'registerDecision',forged,'executor',/InvalidSignature/);assert.deepEqual(await c.state(f.q,job.args[0].incidentId),before);
  await c.send(c.core,'registerDecision',job.args,'executor');
  const payment=await f.authorizer.payment(job.args[0].reservationId,'800000000',id()),approved=await c.state(f.q,job.args[0].incidentId);
  await c.rejects(c.core,'executePayment',[payment.args[0],initial.signature],'executor',/InvalidSignature/);assert.deepEqual(await c.state(f.q,job.args[0].incidentId),approved);
  await c.send(c.core,'executePayment',payment.args,'executor');assert.equal((await c.read(c.core,'getIncident',[job.args[0].incidentId])).P,800n*U);
  console.log('Grant scope evidence:',c.save('grant-scope',{status:'passed',fields:10,final:await c.state(f.q,job.args[0].incidentId)}));
 }finally{f.close();await c.connection.close();}
});
