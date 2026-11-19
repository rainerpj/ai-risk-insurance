import test from 'node:test';
import assert from 'node:assert/strict';
import {custom,createWalletClient,type Hex} from 'viem';
import {foundry} from 'viem/chains';
import {autoFixture} from './m2b-fixture.ts';
import {id,H,U} from './chain-helper.ts';
import {Chain} from '../packages/service/chain.ts';
import {Store} from '../packages/service/store.ts';
import {Worker,Indexer} from '../packages/service/indexer.ts';
import {recordQuality,qualityReviews,qualityStatus,qualityCases,historicalDecision} from '../packages/service/quality.ts';
import {createApp} from '../packages/service/api.ts';
test('independent anomaly review durably pauses template; restart retains paid money and debt',async()=>{
 const f=await autoFixture(),{c}=f;
 const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{[c.accounts.governor.address.toLowerCase()]:c.accounts.governor});
 const actor={address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
 let restarted:Store|undefined;
 try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),decision=job.args[0] as any;
  await c.send(c.core,'registerDecision',job.args,'executor');
  const first=await f.authorizer.payment(decision.reservationId,'600000000',id());await c.send(c.core,'executePayment',first.args,'executor');await c.connection.provider.request({method:'evm_mine'});await f.authorizer.reconcile();
  const second=await f.authorizer.payment(decision.reservationId,'200000000',id());
  const input={id:id(),incidentId:decision.incidentId,decisionVersion:'1',outcome:'wrong_payment',reason:'synthetic independent review found wrong approval'};
  await assert.rejects(recordQuality(f.store,chain,{...actor,role:'insured'},input,c.accounts.governor.address),/ROLE_DENIED/);
  await assert.rejects(recordQuality(f.store,chain,{...actor,tenant:H('other')},input,c.accounts.governor.address),/NOT_FOUND/);
  await assert.rejects(recordQuality(f.store,chain,actor,input),/SAFETY_GOVERNOR_REQUIRED/);
  await assert.rejects(recordQuality(f.store,chain,{...actor,address:c.accounts.outsider.address.toLowerCase()},input,c.accounts.governor.address),/INDEPENDENT_REVIEW_REQUIRED/);
  const review=await recordQuality(f.store,chain,actor,input,c.accounts.governor.address);
  assert.deepEqual(await recordQuality(f.store,chain,actor,input,c.accounts.governor.address),review);
  await assert.rejects(recordQuality(f.store,chain,actor,{...input,reason:'altered'},c.accounts.governor.address),/ID_CONFLICT/);
  assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,1);
  assert.deepEqual(qualityReviews(f.store,H('other')),[]);
  const app=createApp(f.store,chain,'http://127.0.0.1:3100',{safetyGovernor:c.accounts.governor.address});
  try{
   for(const [name,role] of [['assessor','ASSESSOR'],['insured','insured']] as const){
    f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[name].address.toLowerCase(),actor.tenant,role);
    const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts[name].address}})).json();
    const login=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await c.accounts[name].signMessage({message:ch.message})}})).json();
    const headers={authorization:'Bearer '+login.token};
    assert.equal((await app.inject({url:'/api/quality',headers})).statusCode,name==='insured'?403:200);
    assert.equal((await app.inject({method:'POST',url:'/api/quality',headers,payload:input})).statusCode,name==='insured'?403:200);
   }
  }finally{await app.close();}
  // New connection/worker proves persisted queued intent does not depend on a live HTTP request.
  restarted=new Store(f.dir+'/executor.sqlite',f.scope);const worker=new Worker(restarted,chain);
  await worker.tick();const raw=restarted.get('SELECT raw FROM outbox WHERE id=?',review.pauseJob).raw;assert(raw);
  await worker.tick();assert.equal(restarted.get('SELECT raw FROM outbox WHERE id=?',review.pauseJob).raw,raw);
  await c.connection.provider.request({method:'evm_mine'});await new Indexer(restarted,chain,0n).sync();
  assert.equal(qualityReviews(restarted,actor.tenant)[0].pause_state,'confirmed');
  assert.equal(await c.read(f.registry,'disabledVersion',[f.g.templateId]),true);
  await c.rejects(c.core,'executePayment',second.args,'executor',/GrantInactive/);
  await c.rejects(c.core,'executePayment',second.args,'insured',/GrantInactive/);
  const i=await chain.incident(decision.incidentId);assert.equal(i.P,600n*U);assert.equal(i.D,200n*U);assert.equal(i.R,0n);
  await assert.rejects(chain.prepare(c.accounts.governor.address,'safetyPauseTemplate',[f.g.templateId,false,H('resume')]),/SAFETY_PAUSE_ONLY/);
  console.log('Quality evidence:',c.save('quality-review',{reviews:qualityReviews(restarted,actor.tenant),P:i.P,D:i.D,R:i.R}));
 }finally{restarted?.close();f.close();await c.connection.close();}
});
test('transaction history distinguishes two decisions and Grant replacement in one mined block',async()=>{
 const f=await autoFixture(),{c}=f,chain=f.makeChain('executor');
 try{
  await f.enable();const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;
  const snap=await c.connection.provider.request({method:'evm_snapshot'});
  await c.send(c.core,'registerDecision',job.args,'executor');await c.send(c.core,'setIncidentFreeze',[d.incidentId,true,H('review freeze')]);
  const second=await c.decision(f.q,[f.n.n.noticeId],d.incidentId,800n*U);
  await c.connection.provider.request({method:'evm_revert',params:[snap]});
  const wallet=createWalletClient({account:c.accounts.governor,chain:foundry,transport:custom(c.connection.provider)});
  let nonce=await c.client.getTransactionCount({address:c.accounts.governor.address});
  await c.connection.provider.request({method:'evm_setAutomine',params:[false]});
  const hashes:Hex[]=[];
  for(const [contract,functionName,args] of [[c.core,'registerDecision',job.args],[c.core,'setIncidentFreeze',[d.incidentId,true,H('review freeze')]],[c.core,'registerDecision',second.args],[f.registry,'configure',[f.request.grantId,{...f.g,templateId:H('same-block replacement')}]]] as const)
   hashes.push(await wallet.writeContract({...contract,functionName,args,nonce:nonce++,gas:5_000_000n}));
  await c.connection.provider.request({method:'evm_mine'});await c.connection.provider.request({method:'evm_setAutomine',params:[true]});
  const receipts=await Promise.all(hashes.map(hash=>c.client.getTransactionReceipt({hash})));assert(receipts.every(r=>r.status==='success'&&r.blockHash===receipts[0]!.blockHash));
  assert.equal((await chain.incident(d.incidentId)).version,2n);assert.equal((await c.read(f.registry,'getGrant',[f.request.grantId])).epoch,2n);
  const head=await c.client.getBlock(),firstHistory=await historicalDecision(chain,d.incidentId,'1',head),secondHistory=await historicalDecision(chain,d.incidentId,'2',head);
  assert.equal(firstHistory.g.templateId,f.g.templateId);assert.equal(firstHistory.g.epoch,1n);assert.equal(firstHistory.i.decision.channel,1);assert.equal(secondHistory.g,null);assert.equal(secondHistory.i.decision.channel,0);
  const actor={address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
  await recordQuality(f.store,chain,actor,{id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'correct',reason:'same block historical review'});
  console.log('Same-block evidence:',c.save('quality-same-block',{receipts,firstHistory,secondHistory,reviews:await qualityStatus(f.store,chain,actor.tenant)}));
 }finally{await c.connection.provider.request({method:'evm_setAutomine',params:[true]});f.close();await c.connection.close();}
});
test('historical Grant attribution survives replacement; orphaned source requires recheck and keeps audit queue',async()=>{
 const f=await autoFixture(),{c}=f,chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),{[c.accounts.governor.address.toLowerCase()]:c.accounts.governor});
 const actor={address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
 try{
  await f.enable();const snap=await c.connection.provider.request({method:'evm_snapshot'});
  const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature),d=job.args[0] as any;
  await c.send(c.core,'registerDecision',job.args,'executor');
  await c.send(c.core,'grantRole',[H('AUTO_REVIEWER'),c.accounts.assessor2.address]);
  const relatedGrant=id();await c.send(f.registry,'configure',[relatedGrant,{...f.g,reviewer:c.accounts.assessor2.address}]);
  const relatedNotice=await c.notice(f.q),related=await c.decision(f.q,[relatedNotice.n.noticeId],id(),100n*U,{channel:1n,grantId:relatedGrant,grantEpoch:1n,budgetVersion:1n,reservationId:id()},'assessor2','approver2');
  await c.send(f.registry,'configure',[f.request.grantId,{...f.g,templateId:H('replacement template'),ruleVersion:H('replacement rule')}]);
  const input={id:id(),incidentId:d.incidentId,decisionVersion:'1',outcome:'missed_escalation',reason:'historical version audit'};
  const result=await recordQuality(f.store,chain,actor,input,c.accounts.governor.address);
  assert.equal(f.store.get('SELECT count(*) n FROM quality_cases').n,1);
  await c.send(c.core,'registerDecision',related.args,'executor'); // Lands after feedback, before queued pause.
  let rows=await qualityStatus(f.store,chain,actor.tenant);assert.equal(rows[0].proof_state,'canonical');assert.equal(rows[0].payload.templateId,f.g.templateId);assert.equal(rows[0].payload.grantEpoch,'1');
  const pending=await qualityCases(f.store,chain,actor.tenant);assert.equal(pending.length,2);assert(pending.every(r=>r.state==='pending'&&r.payload.sameVersion));assert.deepEqual(await qualityCases(f.store,chain,H('other enterprise')),[]);
  await recordQuality(f.store,chain,actor,{...input,id:id(),outcome:'correct',reason:'separate followup reviewed evidence'});
  assert.equal((await qualityCases(f.store,chain,actor.tenant))[0].state,'reviewed');
  assert.equal((await qualityCases(f.store,chain,actor.tenant))[1].state,'pending');
  await new Worker(f.store,chain).tick();await c.connection.provider.request({method:'evm_mine'});await new Indexer(f.store,chain,0n).sync();
  assert.equal(await c.read(f.registry,'disabledVersion',[f.g.templateId]),true);assert.equal(await c.read(f.registry,'disabledVersion',[H('replacement template')]),false);
  await c.connection.provider.request({method:'evm_revert',params:[snap]});await c.connection.provider.request({method:'evm_mine'});
  rows=await qualityStatus(f.store,chain,actor.tenant);assert(rows.every(r=>r.proof_state==='recheck_required'));assert.equal((await qualityCases(f.store,chain,actor.tenant))[0].state,'recheck_required');
  assert.equal(f.store.get('SELECT count(*) n FROM quality_reviews').n,2);assert(f.store.get('SELECT * FROM outbox WHERE id=?',result.pauseJob));
  const offline=new Chain(c.core.address,c.salt,custom(c.connection.provider),{});offline.check=async()=>{throw Error('RPC_OFFLINE');};assert((await qualityStatus(f.store,offline,actor.tenant)).every(r=>r.proof_state==='unavailable'));
  console.log('Historical quality evidence:',c.save('quality-history',{reviews:rows,cases:await qualityCases(f.store,chain,actor.tenant)}));
 }finally{f.close();await c.connection.close();}
});

test('L3 quality review excludes original decision participants, persists manual anomaly and supports measurements',async()=>{
 const f=await autoFixture(),chain=f.makeChain('executor'),{c}=f;
 try{
  const decision=await c.decision(f.q,[f.request.noticeId as Hex],id(),800n*U);await c.send(c.core,'registerDecision',decision.args,'executor');
  const input={id:id(),incidentId:decision.d.incidentId,decisionVersion:'1',outcome:'underpayment',reason:'independent synthetic manual decision review'};
  const actor={address:c.accounts.assessor2.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'};
  for(const [who,role] of [['assessor','ASSESSOR'],['approver','CLAIM_APPROVER']] as const)await assert.rejects(recordQuality(f.store,chain,{...actor,address:c.accounts[who].address.toLowerCase(),role},input),/INDEPENDENT_REVIEW_REQUIRED/);
  await assert.rejects(recordQuality(f.store,chain,{...actor,tenant:H('other')},input),/NOT_FOUND/);
  const largerNotice=await c.notice(f.q),larger=await c.decision(f.q,[largerNotice.n.noticeId],id(),60000n*U);await c.send(c.core,'registerDecision',larger.args,'executor');
  await assert.rejects(recordQuality(f.store,chain,{...actor,address:c.accounts.supervisor.address.toLowerCase(),role:'SUPERVISOR'},{...input,id:id(),incidentId:larger.d.incidentId}),/INDEPENDENT_REVIEW_REQUIRED/);
  const result=await recordQuality(f.store,chain,actor,input);assert.equal(result.pauseJob,null);assert.equal(f.store.get('SELECT count(*) n FROM outbox').n,0);
  const pending=await qualityCases(f.store,chain,actor.tenant);assert.equal(pending.length,1);assert.equal(pending[0].state,'pending');assert.equal(pending[0].payload.channel,0);
  const {recordMeasurement,qualityMetrics}=await import('../packages/service/metrics.ts');
  await recordMeasurement(f.store,chain,actor,{id:id(),reviewId:input.id,processingMs:'100',humanMs:'80',costCurrency:null,costMicros:null,wrongPaid:'0',underpaid:'1000000',duplicatePayments:'0',manualOverturned:null,appealOverturned:null,reason:'synthetic independent measurement'});
  const metric=await qualityMetrics(f.store,chain,actor.tenant);assert.equal(metric.groups[0]!.channel,0);assert.equal(metric.groups[0]!.templateId,null);assert.equal(metric.groups[0]!.humanMs.sum,'80');
  const followup={...input,id:id(),outcome:'correct',reason:'followup recorded only; does not resolve or alter the financial decision'};await recordQuality(f.store,chain,actor,followup);assert.equal((await qualityCases(f.store,chain,actor.tenant))[0].state,'reviewed');
  assert.equal((await chain.incident(decision.d.incidentId)).D,800n*U);assert.equal((await qualityMetrics(f.store,chain,actor.tenant)).groups[0]!.measuredDecisions,0,'new review cannot inherit previous measurement');
  console.log('Manual quality evidence:',c.save('quality-manual',{pending,metric,result}));
 }finally{f.close();await c.connection.close();}
});
