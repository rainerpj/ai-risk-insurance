import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {H,id} from './chain-helper.ts';
import {createApp} from '../packages/service/api.ts';
import {authorizerApp} from '../packages/service/automatic-api.ts';
import {budgetSnapshot,operations,remoteBudget} from '../packages/service/operations.ts';
import {json} from '../packages/service/store.ts';

test('operations gateway reads real switches and budgets with tenant and capability separation',async()=>{
 const f=await autoFixture(),observer='o'.repeat(40),auth=authorizerApp(f.authorizer,{reviewer:'r'.repeat(40),executor:'e'.repeat(40),observer});
 const otherTenant=H('other enterprise'),otherGrant=id();
 await f.c.send(f.registry,'configure',[otherGrant,{...f.g,enterpriseId:otherTenant}]);
 const snapshot=async(tenant:string)=>budgetSnapshot(f.budget,tenant,Number(await f.c.now()));
 const app=createApp(f.store,f.makeChain('executor'),'http://127.0.0.1:3100',{grantIds:[f.request.grantId,otherGrant],budgetSnapshot:snapshot});
 try{
  for(const [actor,role,tenant] of [['insured','insured',f.q.enterpriseId],['assessor','ASSESSOR',f.q.enterpriseId],['supervisor','SUPERVISOR',otherTenant]] as const)
   f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts[actor].address.toLowerCase(),tenant,role);
  async function login(actor:'insured'|'assessor'|'supervisor'){
   const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:f.c.accounts[actor].address}})).json();
   return (await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await f.c.accounts[actor].signMessage({message:ch.message})}})).json().token;
  }
  const insured=await login('insured'),assessor=await login('assessor'),other=await login('supervisor');
  assert.equal((await app.inject({url:'/api/automation',headers:{authorization:'Bearer '+insured}})).statusCode,403);
  const query=async(token:string)=>(await app.inject({url:'/api/automation?tenant='+otherTenant,headers:{authorization:'Bearer '+token,'x-role':'GOVERNOR'}})).json();
  const off=await query(assessor);assert(off.chain.channels.every((c:any)=>!c.approve&&!c.pay));assert.equal(off.chain.grants.length,1);assert.equal(off.chain.grants[0].id,f.request.grantId);
  await f.enable(true,false);const assessed=await f.reviewer.assess(f.request);await f.authorizer.authorize(f.request,assessed.a,assessed.signature);
  const active=await query(assessor);assert.equal(active.chain.channels[0].approve,true);assert.equal(active.chain.channels[0].pay,false);assert.equal(active.budget.reservations[0].remaining,'800000000');
  const foreign=await query(other);assert.equal(foreign.chain.grants[0].id,otherGrant);assert.deepEqual(foreign.budget.reservations,[]);assert.deepEqual(foreign.budget.payments,[]);
  const publicJson=json(active);for(const forbidden of ['signature','privateKey','raw','refs','envelope'])assert(!publicJson.includes('"'+forbidden+'"'));
  const projected=await auth.inject({url:'/operations/'+f.q.enterpriseId,headers:{authorization:'Bearer '+observer}});assert.equal(projected.statusCode,200);assert.equal(projected.json().tenant,f.q.enterpriseId);
  for(const url of ['/authorize','/payment','/jobs'])assert.equal((await auth.inject({method:url==='/jobs'?'GET':'POST',url,headers:{authorization:'Bearer '+observer},...(url==='/jobs'?{}:{payload:{}})})).statusCode,403);
  assert.throws(()=>remoteBudget('https://example.com',observer,f.scope),/LOCAL|RPC|LOOPBACK/);
  const chain=f.makeChain('executor');chain.check=async()=>{throw new Error('RPC_OFFLINE');};
  const offline=await operations(chain,f.q.enterpriseId,{budgetSnapshot:async()=>{throw new Error('OFFLINE');}});assert.equal(offline.chain.state,'unavailable');assert.equal(offline.chain.channels,undefined);assert.equal(offline.budget.state,'unavailable');
  console.log('Operations evidence:',f.c.save('operations',{off,active,foreign,offline}));
 }finally{await app.close();await auth.close();f.close();await f.c.connection.close();}
});
