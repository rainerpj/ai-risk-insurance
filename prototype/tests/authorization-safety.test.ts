import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {autoFixture,limits} from './m2b-fixture.ts';
import {id,U} from './chain-helper.ts';
import {H} from '../packages/service/reviewer.ts';
import {Budget} from '../packages/service/budget.ts';

test('damaged budget schema cannot silently recreate reservations or reset existing database',()=>{
  mkdirSync('.local',{recursive:true});const file=`.local/schema-loss-${randomUUID()}.sqlite`;
  const b=new Budget(file,'scope',true);b.configure(limits(1000n,5,'1',100),1000,0);b.close();
  assert.throws(()=>new Budget(file,'scope',true),/INITIALIZATION_REQUIRES_NEW/);
  const damaged=new DatabaseSync(file);damaged.exec('DROP TABLE reservations');damaged.close();
  assert.throws(()=>new Budget(file,'scope'),/SCHEMA_MISSING/);
  const check=new DatabaseSync(file,{readOnly:true});assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='reservations'").get(),undefined);check.close();
});

test('automatic payment checks every dependency epoch before allocating or replaying a signature',async()=>{
  const f=await autoFixture();try{
    await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),r=job.args[0] as any;
    await f.c.send(f.c.core,'registerDecision',job.args,'executor');
    for(const actor of [f.g.reviewer,f.g.authorizer]){
      const snap=await f.c.connection.provider.request({method:'evm_snapshot'});
      await f.c.send(f.c.core,'rotateEpoch',[actor]);
      await assert.rejects(f.authorizer.payment(r.reservationId,'200000000',id()),/DEPENDENCY_EXPIRED_OR_REVOKED/);
      assert.equal(f.budget.all('SELECT * FROM payments').length,0);
      await f.c.connection.provider.request({method:'evm_revert',params:[snap]});
    }
    const requestId=id();await f.authorizer.payment(r.reservationId,'200000000',requestId);
    await f.c.send(f.c.core,'rotateEpoch',[f.g.reviewer]);
    await assert.rejects(f.authorizer.payment(r.reservationId,'200000000',requestId),/DEPENDENCY_EXPIRED_OR_REVOKED/);
    assert.equal(f.budget.all('SELECT * FROM payments').length,1);assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'800000000');
  }finally{f.close();await f.c.connection.close();}
});

test('configuration change reconciles pending successes; an orphaned configuration proof stops startup and signing',async()=>{
  const f=await autoFixture();try{
    await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),r=job.args[0] as any;
    await f.c.send(f.c.core,'registerDecision',job.args,'executor');const payment=await f.authorizer.payment(r.reservationId,'600000000',id());
    await f.c.send(f.c.core,'executePayment',payment.args,'executor');await f.c.connection.provider.request({method:'evm_mine'});
    assert.equal(f.budget.get('SELECT state FROM payments').state,'reserved');
    const snapshot=await f.c.connection.provider.request({method:'evm_snapshot'});
    await f.enable(false,false);await f.c.send(f.registry,'configure',[f.request.grantId,{...f.g,budgetVersion:2n}]);await f.c.connection.provider.request({method:'evm_mine'});
    await f.authorizer.reconfigure(limits(1000n*U,5,'2'),[f.request.grantId],0);
    assert.equal(f.budget.get('SELECT state FROM payments').state,'confirmed');assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'200000000');
    const proof=f.budget.meta('configurationProof');assert(proof);assert.equal(JSON.parse(f.budget.get("SELECT config FROM limits WHERE dimension='GLOBAL'").config).version,'2');
    await f.c.connection.provider.request({method:'evm_revert',params:[snapshot]});await f.c.connection.provider.request({method:'evm_mine'});
    await assert.rejects(f.authorizer.reconcile(),/CONFIG_PROOF_ORPHANED/);assert.equal(f.budget.meta('ready'),'0');
    await assert.rejects(f.authorizer.payment(r.reservationId,'200000000',id()),/CONFIG_PROOF_ORPHANED/);
    // Governance recovery uses a newer version, retains paid history and never clears outstanding D.
    await f.enable(false,false);await f.c.send(f.registry,'configure',[f.request.grantId,{...f.g,budgetVersion:3n}]);await f.c.connection.provider.request({method:'evm_mine'});
    await f.authorizer.reconfigure(limits(1000n*U,5,'3'),[f.request.grantId],0);await f.authorizer.reconcile();
    assert.equal(f.budget.meta('ready'),'1');assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'200000000');
    console.log('Configuration recovery evidence:',f.c.save('configuration-recovery',{proof:f.budget.meta('configurationProof'),history:f.budget.all('SELECT * FROM history')}));
  }finally{f.close();await f.c.connection.close();}
});
