import test from 'node:test';
import assert from 'node:assert/strict';
import {autoFixture} from './m2b-fixture.ts';
import {id,H} from './chain-helper.ts';
import {Store,json} from '../packages/service/store.ts';
import {Indexer} from '../packages/service/indexer.ts';
import {noticeGroups} from '../packages/service/notice-groups.ts';
import {createApp,intakeMessage} from '../packages/service/api.ts';

test('notice grouping keeps offline receipts after database reopen, deduplicates catch-up and isolates tenants',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),tenant=f.q.enterpriseId;
 let store=f.store;
 try{
  const ids=[f.request.noticeId,...Array.from({length:11},()=>id())],commitment=f.n.n.incidentCommitment;
  const intake=createApp(store,chain);
  store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts.insured.address.toLowerCase(),tenant,'insured');
  try{
   const ch=(await intake.inject({method:'POST',url:'/api/auth/challenge',payload:{address:f.q.insured}})).json();
   const token=(await intake.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await f.c.accounts.insured.signMessage({message:ch.message})}})).json().token;
   const submit=async(payload:any,signature?:string)=>intake.inject({method:'POST',url:'/api/notices',headers:{authorization:'Bearer '+token},payload:{payload,signature:signature??await f.c.accounts.insured.signMessage({message:intakeMessage(f.scope,payload)})}});
   const base={policyId:f.q.quoteId,incidentCommitment:commitment,evidenceHash:H('signed request'),declaredIncidentAt:f.q.startAt.toString(),summary:'new request for one distinct expense',claimedAmount:'900000000'};
   for(const noticeId of ids){const payload={...base,noticeId};assert.equal((await submit(payload)).statusCode,202);assert.equal((await submit(payload)).statusCode,202);}
   for(const claimedAmount of [-1,'-1','0.1','1e6',(2n**256n).toString(),null])assert.equal((await submit({...base,noticeId:id(),claimedAmount})).statusCode,400);
   const payload={...base,noticeId:id()},signature=await f.c.accounts.insured.signMessage({message:intakeMessage(f.scope,payload)});
   assert.equal((await submit({...payload,claimedAmount:'1'},signature)).statusCode,401);
   assert.equal((await submit({...base,noticeId:ids[0],claimedAmount:'1'})).statusCode,409);
  }finally{await intake.close();}
  store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',id(),H('foreign'),f.q.insured,json({payload:{policyId:f.q.quoteId,incidentCommitment:commitment}}),'test',new Date().toISOString(),'awaiting_binding');
  let result=await noticeGroups(store,chain,tenant);assert.equal(result.chainState,'unavailable');assert.equal(result.groups.length,1);assert.equal(result.groups[0].notices.length,12);assert.equal(result.groups[0].claimedTotal,'10800000000');
  assert.equal((await noticeGroups(store,chain,H('foreign'))).groups[0].claimedTotal,null);
  store.close();store=new Store(f.dir+'/executor.sqlite',f.scope);
  assert.deepEqual(await noticeGroups(store,chain,tenant),result);
  for(const noticeId of ids.slice(1))await f.c.notice(f.q,{noticeId,incidentCommitment:commitment});
  await f.c.connection.provider.request({method:'evm_mine'});await new Indexer(store,chain,0n).sync();
  result=await noticeGroups(store,chain,tenant);assert.equal(result.chainState,'confirmed');assert.equal(result.groups[0].notices.length,12);assert.equal(result.groups[0].localOnly,0);assert.equal(result.groups[0].requiresAggregation,true);
  assert.equal(result.groups[0].claimedTotal,'10800000000');assert.equal(result.groups[0].unknownAmounts,0);
  const app=createApp(store,chain);try{
   for(const [actor,role] of [['insured','insured'],['assessor','ASSESSOR']] as const){
    store.run('INSERT OR IGNORE INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts[actor].address.toLowerCase(),tenant,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:f.c.accounts[actor].address}})).json();
    const token=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await f.c.accounts[actor].signMessage({message:ch.message})}})).json().token;
    const r=await app.inject({url:'/api/notice-groups?tenant='+H('foreign'),headers:{authorization:'Bearer '+token}});
    assert.equal(r.statusCode,actor==='insured'?403:200);if(actor==='assessor')assert.equal(r.json().groups[0].notices.length,12);
   }
  }finally{await app.close();}
  const realCheck=chain.check;chain.check=async()=>{throw Error('offline');};
  result=await noticeGroups(store,chain,tenant);assert.equal(result.chainState,'unavailable');assert.equal(result.groups[0].localOnly,12);assert(result.groups[0].notices.every((n:any)=>n.anchoredAt===null));chain.check=realCheck;
  console.log('Notice group evidence:',f.c.save('notice-groups',{status:'passed',noticeIds:ids,offline:result}));
 }finally{store.close();f.budget.close();await f.c.connection.close();}
});
