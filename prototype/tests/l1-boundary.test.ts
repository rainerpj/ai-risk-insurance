import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {U,id} from './chain-helper.ts';

test('AC33 approved structured 1000 uses net payment, 1000.000001 cannot obtain L1 signatures',async()=>{
 for(const gross of [1000n*U,1000n*U+1n]){
  const f=await autoFixture({}, {gross,compensation:100n*U});
  try{
   await f.enable();
   if(gross>1000n*U){
    await assert.rejects(f.reviewer.assess(f.request),/MANUAL_REQUIRED/);
    assert.equal(f.budget.all('SELECT * FROM reservations').length,0);
    assert.equal(f.budget.all('SELECT * FROM signatures').length,0);
    assert.equal((await f.c.read(f.c.core,'getPolicy',[f.q.quoteId])).dueTotal,0n);
   }else{
    const assessed=await f.reviewer.assess(f.request);
    const job=await f.authorizer.authorize(f.request,assessed.a,assessed.signature);
    const d=job.args[0];assert.equal(BigInt(d.reviewAmount),gross);assert.equal(BigInt(d.netApproved),900n*U);
    await f.c.send(f.c.core,'registerDecision',job.args,'executor');
    const pay=await f.authorizer.payment(d.reservationId,(900n*U).toString(),id());
    await f.c.send(f.c.core,'executePayment',pay.args,'executor');
    const incident=await f.c.read(f.c.core,'getIncident',[d.incidentId]);
    assert.equal(incident.P,900n*U);assert.equal(incident.D,0n);assert.equal(incident.N,900n*U);
   }
   console.log('L1 boundary evidence:',f.c.save('l1-boundary',{status:'passed',gross,compensation:100n*U,expectedL1:gross===1000n*U}));
  }finally{f.close();await f.c.connection.close();}
 }
});
