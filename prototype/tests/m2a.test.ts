import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import { custom } from 'viem';
import { setup, id, H, U, json } from './chain-helper.ts';
import { Store } from '../packages/service/store.ts';
import { Chain } from '../packages/service/chain.ts';
import { Indexer, Worker } from '../packages/service/indexer.ts';
import { createApp, intakeMessage } from '../packages/service/api.ts';
import { zeroHash } from '../packages/domain/typed-data.ts';
test('M2a durable intake, authentication, manual operations and canonical recovery',async t=>{
  const c=await setup(),q=await c.issue();
  const registry=await c.deploy('EvidenceRegistry',[c.core.address]);await c.send(c.core,'grantRole',[H('ANCHOR_OPERATOR'),c.accounts.executor.address]);await c.send(registry,'anchorBatch',[id(),H('synthetic root'),1n,H('FDE-EVIDENCE-v1')],'executor');
  await c.send(c.core,'grantRole',[H('CLAIM_APPROVER'),c.accounts.approver2.address]);
  const path=`.local/m2a-${c.runId}.sqlite`;mkdirSync('.local',{recursive:true});
  const scope=`31337:${c.core.address}:${c.salt}`;
  let s=new Store(path,scope);
  for(const [name,role,tenant] of [['insured','insured',H('enterprise')],['outsider','insured',H('other enterprise')],['assessor','ASSESSOR',H('enterprise')],['assessor2','ASSESSOR',H('enterprise')],['approver','CLAIM_APPROVER',H('enterprise')],['approver2','CLAIM_APPROVER',H('enterprise')],['supervisor','SUPERVISOR',H('enterprise')]] as const)s.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[name].address.toLowerCase(),tenant,role);
  const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),Object.fromEntries(Object.values(c.accounts).map(a=>[a.address.toLowerCase(),a])),registry.address);
  let app=createApp(s,chain),index=new Indexer(s,chain,0n),worker=new Worker(s,chain);
  const tokens:Record<string,string>={},outcomes:any[]=[];
  async function req(method:any,url:string,name:string,body?:unknown){return app.inject({method,url,headers:{authorization:`Bearer ${tokens[name]}`},...(body===undefined?{}:{payload:JSON.parse(json(body))})});}
  async function login(name:keyof typeof c.accounts){const a=c.accounts[name];const challenge=await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:a.address}});assert.equal(challenge.statusCode,200);const ch=challenge.json();const signature=await a.signMessage({message:ch.message});const result=await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature}});assert.equal(result.statusCode,200);tokens[name]=result.json().token;return {ch,signature};}
  async function run(name:string,fn:()=>Promise<void>){await t.test(name,async()=>{try{await fn();outcomes.push({name,status:'passed'});}catch(e){outcomes.push({name,status:'failed',error:String(e)});throw e;}});}
  async function mine(){await c.connection.provider.request({method:'evm_mine'});await index.sync();}
  const nId=id(),payload={noticeId:nId,policyId:null,incidentCommitment:id(),evidenceHash:zeroHash,declaredIncidentAt:q.startAt.toString(),summary:'合成离线报案，不代表责任认定'};
  let evidenceId='',incidentId=id(),largeIncident='',authorization:any,signature:any,receivedAt='';
  try{
    await run('wallet challenge domain, replay, forged role, expiry and tenant session isolation',async()=>{
      const {ch,signature}=await login('insured');
      assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature}})).statusCode,401);
      for(const name of ['outsider','assessor','assessor2','approver','approver2','supervisor'] as const)await login(name);
      assert.equal((await app.inject({url:'/api/me',headers:{'x-role':'GOVERNOR','x-enterprise-id':H('enterprise')}})).statusCode,401);
      const fresh=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts.insured.address}})).json();
      assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{id:fresh.id,signature:await c.accounts.outsider.signMessage({message:fresh.message})}})).statusCode,401);
      s.run('UPDATE challenges SET expires=0 WHERE id=?',fresh.id);
      assert.equal((await app.inject({method:'POST',url:'/api/auth/login',payload:{id:fresh.id,signature:await c.accounts.insured.signMessage({message:fresh.message})}})).statusCode,401);
      assert.equal((await app.inject({method:'POST',url:'/api/auth/challenge',headers:{origin:'https://attacker.invalid'},payload:{address:c.accounts.insured.address}})).statusCode,403);
    });
    await run('offline receipt persists before response; concurrent idempotency/conflict; unmatched notice survives restart',async()=>{
      const check=chain.check.bind(chain);chain.check=async()=>{throw new Error('RPC_OFFLINE');};
      signature=await c.accounts.insured.signMessage({message:intakeMessage(scope,payload)});
      const results=await Promise.all(Array.from({length:5},()=>req('POST','/api/notices','insured',{payload,signature})));
      for(const r of results)assert.equal(r.statusCode,202);
      const reordered=Object.fromEntries(Object.entries(payload).reverse());assert.equal((await req('POST','/api/notices','insured',{payload:reordered,signature})).statusCode,202);
      assert.equal(new Set(results.map(r=>r.json().receivedAt)).size,1);
      receivedAt=results[0]!.json().receivedAt;assert.equal(results[0]!.json().anchoredAt,null);
      const changed={...payload,summary:'changed'};
      assert.equal((await req('POST','/api/notices','insured',{payload:changed,signature:await c.accounts.insured.signMessage({message:intakeMessage(scope,changed)})})).statusCode,409);
      assert.equal(s.get('SELECT count(*) AS n FROM notices').n,1);
      const missing=(await req('GET','/api/notices','insured')).json()[0];assert.deepEqual(missing.evidenceStatus,{originalCount:0,originals:'missing',verification:'not_evaluated'});assert.equal(missing.chain,null);assert.equal(missing.state,'awaiting_binding');
      const e=await req('POST',`/api/notices/${nId}/evidence`,'insured',{contentBase64:Buffer.from('synthetic private material').toString('base64'),mediaType:'text/plain'});assert.equal(e.statusCode,200);evidenceId=e.json().id;
      const received=s.get('SELECT received_at FROM notices WHERE id=?',nId).received_at;
      await app.close();s.close();s=new Store(path,scope);app=createApp(s,chain);index=new Indexer(s,chain,0n);worker=new Worker(s,chain);
      assert.equal(s.get('SELECT received_at FROM notices WHERE id=?',nId).received_at,received);
      assert.equal((await req('GET','/api/notices','insured')).json()[0].state,'awaiting_binding');
      assert.equal((await req('GET',`/api/evidence/${evidenceId}`,'insured')).body,'synthetic private material');chain.check=check;
      assert.deepEqual((await req('GET','/api/notices','insured')).json()[0].evidenceStatus,{originalCount:1,originals:'stored_unverified',verification:'not_evaluated'});
    });
    await run('materials, exports, review and signing enforce server-side tenant and role scopes',async()=>{
      assert.equal((await req('GET',`/api/evidence/${evidenceId}`,'outsider')).statusCode,404);
      assert.equal((await req('POST',`/api/notices/${nId}/evidence`,'outsider',{contentBase64:'YQ==',mediaType:'text/plain'})).statusCode,404);
      assert.deepEqual((await req('GET','/api/notices','outsider')).json(),[]);
      const exported=(await req('POST','/api/exports','outsider',{})).json();assert.equal(exported.notices.length,0);assert.equal(exported.evidence.length,0);
      assert.equal((await req('POST',`/api/incidents/${incidentId}/review`,'insured',{policyId:q.quoteId,reason:'forged reviewer',payload:{}})).statusCode,403);
      assert.equal((await req('POST','/api/sign','insured',{type:'ClaimDecision',policyId:q.quoteId,message:{}})).statusCode,403);
      assert.equal((await req('GET','/api/views/pool','insured')).statusCode,403);
      assert.equal((await req('GET','/api/views/pool','assessor')).statusCode,200);
      assert.equal((await req('GET','/api/evidence/..%2F..%2Fpackage.json','insured')).statusCode,404);
    });
    await run('enterprise-confirmed policy binding, lost broadcast receipt, durable raw transaction and duplicate replay',async()=>{
      authorization={noticeId:nId,policyId:q.quoteId,incidentCommitment:payload.incidentCommitment,evidenceHash:zeroHash,declaredIncidentAt:q.startAt,submitter:c.accounts.insured.address,signerEpoch:await c.read(c.core,'epochs',[c.accounts.insured.address]),expiresAt:(await c.now())+20000n};
      signature=await c.sign('NoticeAuthorization',authorization,'insured');
      assert.equal((await req('POST',`/api/notices/${nId}/bind`,'outsider',{authorization,signature})).statusCode,404);
      for(let k=0;k<2;k++)assert.equal((await req('POST',`/api/notices/${nId}/bind`,'insured',{authorization,signature})).statusCode,200);
      const send=chain.client.sendRawTransaction;chain.client.sendRawTransaction=async(args:any)=>{await send(args);throw new Error('LOST_RECEIPT');};
      await worker.tick();assert.equal(s.get('SELECT state FROM outbox WHERE id=?',nId).state,'unknown');assert.ok(s.get('SELECT raw FROM outbox WHERE id=?',nId).raw);
      chain.client.sendRawTransaction=send;
      await app.close();s.close();s=new Store(path,scope);app=createApp(s,chain);index=new Indexer(s,chain,0n);worker=new Worker(s,chain);
      await mine();assert.equal(s.get('SELECT state FROM outbox WHERE id=?',nId).state,'confirmed');
      await worker.tick();await index.sync();
      assert.equal(s.get("SELECT count(*) AS n FROM events WHERE canonical=1 AND name='NoticeRegistered'").n,1);
      assert.equal((await c.read(c.core,'getNotice',[nId])).data.policyId,q.quoteId);
      const visible=(await req('GET','/api/notices','insured')).json().find((n:any)=>n.id===nId),anchored=await c.read(c.core,'getNotice',[nId]);
      assert.equal(visible.received_at,receivedAt);assert.equal(visible.payload.declaredIncidentAt,payload.declaredIncidentAt);
      assert.equal(JSON.parse(visible.chain).anchoredAt,anchored.anchoredAt.toString());
      assert.equal(anchored.data.declaredIncidentAt,q.startAt);assert(anchored.anchoredAt>q.startAt);
      assert.equal(s.get('SELECT count(*) n FROM outbox WHERE id=?',nId).n,1);
    });
    await run('manual independent review/signing/decision and installment execution use real transactions',async()=>{
      const d=await c.decision(q,[nId],incidentId);
      assert.equal((await req('POST',`/api/incidents/${incidentId}/review`,'assessor',{policyId:q.quoteId,reason:'合成费用核实，批准无争议部分',payload:{amount:'33000000000'}})).statusCode,200);
      const signed=await req('POST','/api/sign','assessor',{type:'Assessment',message:d.a,decision:d.d,policyId:q.quoteId});assert.equal(signed.statusCode,200,signed.body);assert.equal(signed.json().signature,d.args[4]);
      const draft=await req('POST','/api/drafts','assessor',{policyId:q.quoteId,incidentId,noticeIds:[nId],expenses:d.expenses,reason:'独立人工核损通过',approver:c.accounts.approver.address});assert.equal(draft.statusCode,200,draft.body);const draftId=draft.json().id;
      assert.equal((await req('POST',`/api/drafts/${draftId}/submit`,'approver',{})).statusCode,400);
      assert.equal((await req('POST',`/api/drafts/${draftId}/sign`,'outsider',{})).statusCode,404);
      assert.equal((await req('POST',`/api/drafts/${draftId}/sign`,'approver',{})).statusCode,200);
      const decision=await req('POST',`/api/drafts/${draftId}/submit`,'approver',{});assert.equal(decision.statusCode,200,decision.body);
      await worker.tick();await mine();assert.equal(s.get('SELECT state FROM outbox WHERE id=?',draftId).state,'confirmed');
      const payment=await c.payment(q,incidentId,8000n*U);
      const result=await req('POST','/api/actions','approver',{id:payment.p.paymentId,action:'executePayment',args:[payment.p,payment.sig],reason:'第一期付款'});assert.equal(result.statusCode,200,result.body);
      assert.equal((await req('POST','/api/manual/payment','approver',{incidentId,amount:'1',reason:'不可换编号绕过未决请求'})).statusCode,409);
      await worker.tick();await mine();assert.equal((await c.read(c.core,'getIncident',[incidentId])).P,8000n*U);
      const beforeRefusals=s.get('SELECT count(*) n FROM outbox').n;
      await c.send(c.core,'setIncidentFreeze',[incidentId,true,H('UI refusal test')]);
      const frozen=await req('POST','/api/manual/payment','approver',{incidentId,amount:'25000000000',reason:'冻结拒付提示'});
      assert.equal(frozen.statusCode,409);assert.equal(frozen.json().error,'PAYMENT_FROZEN');
      await c.send(c.core,'setIncidentFreeze',[incidentId,false,H('UI refusal complete')]);
      const excessive=await req('POST','/api/manual/payment','approver',{incidentId,amount:'25000000001',reason:'超额拒付提示'});
      assert.equal(excessive.statusCode,409);assert.equal(excessive.json().error,'PAYMENT_EXCEEDS_DUE');
      assert.equal(s.get('SELECT count(*) n FROM outbox').n,beforeRefusals);
      assert.equal((await c.read(c.core,'getIncident',[incidentId])).D,25000n*U);
      const view=JSON.parse(s.get("SELECT payload FROM views WHERE kind='incident' AND id=?",incidentId).payload);assert.equal(view.P,'8000000000');assert.equal(view.D,'25000000000');
      assert.equal((await req('GET','/api/views/incident','outsider')).json().length,0);
    });
    await run('large manual decision requires distinct supervisor; amount strings and draft privacy enforced',async()=>{
      const n=await c.notice(q),i=id(),d=await c.decision(q,[n.n.noticeId],i,60000n*U);largeIncident=i;
      const draftCount=s.get('SELECT count(*) n FROM drafts').n;
      for(const invalid of ['-1','0.1','1e6',(2n**256n).toString(),1]){
        const badExpenses=[{gross:invalid,duplicate:'0',compensation:'0',recovery:'0'},{gross:'0',duplicate:'0',compensation:'0',recovery:'0'}];
        assert.equal((await req('POST','/api/drafts','assessor',{policyId:q.quoteId,incidentId:i,noticeIds:[n.n.noticeId],expenses:badExpenses,reason:'非法金额拒绝',approver:c.accounts.approver.address})).statusCode,400);
        assert.equal(s.get('SELECT count(*) n FROM drafts').n,draftCount);
      }
      const draft=await req('POST','/api/drafts','assessor',{policyId:q.quoteId,incidentId:i,noticeIds:[n.n.noticeId],expenses:d.expenses,reason:'主管共同批准测试',approver:c.accounts.approver.address});assert.equal(draft.statusCode,200,draft.body);const draftId=draft.json().id;
      await req('POST',`/api/drafts/${draftId}/sign`,'approver',{});
      assert.equal((await req('POST',`/api/drafts/${draftId}/submit`,'approver',{})).statusCode,400);
      assert.equal((await req('POST',`/api/drafts/${draftId}/sign`,'supervisor',{})).statusCode,200);
      assert.equal((await req('POST',`/api/drafts/${draftId}/submit`,'approver',{})).statusCode,200);await worker.tick();await mine();
      assert.equal((await c.read(c.core,'getIncident',[i])).D,60000n*U);
      assert.deepEqual((await req('GET','/api/drafts','outsider')).json(),[]);
      const bad=await req('POST','/api/manual/payment','approver',{incidentId:i,reason:'非法金额类型',amount:1});assert.equal(bad.statusCode,400);
    });
    await run('canonical business ID reconciles another relayer; vault logs indexed; no stale success error',async()=>{
      const p=await c.payment(q,largeIncident as any,1000n*U);
      assert.equal((await req('POST','/api/actions','approver',{id:p.p.paymentId,action:'executePayment',args:[p.p,p.sig],reason:'替代广播者对账'})).statusCode,200);
      await c.send(c.core,'executePayment',[p.p,p.sig],'outsider');await mine();await worker.tick();
      const job=s.get('SELECT * FROM outbox WHERE id=?',p.p.paymentId);assert.equal(job.state,'confirmed');assert.equal(job.error,null);assert.equal(job.tx_hash,null);assert.ok(JSON.parse(job.receipt).transactionHash);
      assert.ok(s.get("SELECT count(*) AS n FROM events WHERE canonical=1 AND name='PoolChanged'").n>0);
      assert.equal(s.get("SELECT count(*) AS n FROM events WHERE canonical=1 AND name='EvidenceAnchored'").n,1);
      assert.equal((await c.read(c.core,'getIncident',[largeIncident])).P,1000n*U);
    });
    await run('orphan payment retracts projection and confirmation; restart/replay cannot double account',async()=>{
      const snapshot=await c.connection.provider.request({method:'evm_snapshot'});
      const payment=await c.payment(q,incidentId,25000n*U);
      assert.equal((await req('POST','/api/actions','approver',{id:payment.p.paymentId,action:'executePayment',args:[payment.p,payment.sig],reason:'第二期付款'})).statusCode,200);
      await worker.tick();await mine();assert.equal((await c.read(c.core,'getIncident',[incidentId])).P,33000n*U);
      const beforeDuplicate=s.get('SELECT count(*) n FROM outbox').n;
      const duplicate=await req('POST','/api/manual/payment','approver',{incidentId,amount:'25000000000',reason:'清偿后重复付款提示'});
      assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().error,'PAYMENT_NOT_DUE');
      assert.equal(s.get('SELECT count(*) n FROM outbox').n,beforeDuplicate);
      await c.connection.provider.request({method:'evm_revert',params:[snapshot]});
      await c.send(c.core,'setIncidentFreeze',[incidentId,true,H('reorg safety')]);await mine();
      assert.equal(s.get('SELECT state FROM outbox WHERE id=?',payment.p.paymentId).state,'reorg_pending');
      assert.equal(JSON.parse(s.get("SELECT payload FROM views WHERE kind='incident' AND id=?",incidentId).payload).P,'8000000000');
      assert.ok(s.get('SELECT count(*) AS n FROM events WHERE canonical=0').n>0);
      await app.close();s.close();s=new Store(path,scope);app=createApp(s,chain);index=new Indexer(s,chain,0n);worker=new Worker(s,chain);
      await index.sync();assert.equal(s.get('SELECT state FROM outbox WHERE id=?',payment.p.paymentId).state,'reorg_pending');
      assert.equal(JSON.parse(s.get("SELECT payload FROM views WHERE kind='incident' AND id=?",incidentId).payload).P,'8000000000');
      await c.send(c.core,'setIncidentFreeze',[incidentId,false,H('resume')]);await worker.tick();await mine();
      assert.equal((await c.read(c.core,'getIncident',[incidentId])).P,33000n*U);
      const count=s.get('SELECT count(*) AS n FROM events').n;await index.sync();assert.equal(s.get('SELECT count(*) AS n FROM events').n,count);
    });
    await run('no common ancestor halts execution, explicit rebuild reconciles; deployment mismatch refused',async()=>{
      const snap=await c.connection.provider.request({method:'evm_snapshot'});
      await c.send(c.core,'setIncidentFreeze',[incidentId,true,H('branch one')]);await mine();
      await c.connection.provider.request({method:'evm_revert',params:[snap]});await c.send(c.core,'setIncidentFreeze',[incidentId,true,H('branch two')]);await c.connection.provider.request({method:'evm_mine'});
      index.lookback=1;await index.sync();assert.equal(s.getMeta('halted'),'NO_COMMON_ANCESTOR');
      assert.equal((await req('POST','/api/actions','approver',{id:id(),action:'setIncidentFreeze',args:[incidentId,false,H('blocked')],reason:'blocked'})).statusCode,503);
      await index.rebuild();assert.equal(s.getMeta('halted'),'');assert.equal(JSON.parse(s.get("SELECT payload FROM views WHERE kind='incident' AND id=?",incidentId).payload).P,'33000000000');
      assert.throws(()=>new Store(path,'another-deployment'),/DEPLOYMENT_MISMATCH/);
      s.run('UPDATE identities SET enabled=0 WHERE address=?',c.accounts.outsider.address.toLowerCase());assert.equal((await req('GET','/api/me','outsider')).statusCode,401);
    });
    await run('workbench appeal and independent reopening preserve history and require a fresh frozen decision',async()=>{
      assert.equal((await req('POST','/api/manual/dispute','insured',{incidentId,reason:'企业申诉'})).statusCode,200);await worker.tick();await mine();
      assert.equal((await req('POST','/api/manual/reopen','approver',{incidentId,reason:'原核赔员不可复核'})).statusCode,400);
      assert.equal((await req('POST','/api/manual/reopen','approver2',{incidentId,reason:'独立复核重开'})).statusCode,200);await worker.tick();await mine();
      const expenses=[{gross:'23000000000',duplicate:'0',compensation:'0',recovery:'0'},{gross:'0',duplicate:'0',compensation:'0',recovery:'0'}];
      const draft=await req('POST','/api/drafts','assessor2',{policyId:q.quoteId,incidentId,noticeIds:[nId],expenses,reason:'独立重审后修订',approver:c.accounts.approver2.address});assert.equal(draft.statusCode,200,draft.body);
      const draftId=draft.json().id;await req('POST',`/api/drafts/${draftId}/sign`,'approver2',{});assert.equal((await req('POST',`/api/drafts/${draftId}/submit`,'approver2',{})).statusCode,200);await worker.tick();await mine();
      const i=await c.read(c.core,'getIncident',[incidentId]);assert.equal(i.P,33000n*U);assert.equal(i.Q,10000n*U);assert.equal(i.manualHold,true);assert.equal(i.version,2n);
      const exported=(await req('POST','/api/exports','insured',{})).json();assert.ok(exported.drafts.length>=3);assert.ok(exported.transactions.every((j:any)=>!('raw' in j)));assert.ok(!json(exported).includes('privateKey'));
    });
    await run('AC26 approved token allowance is not a policy; unsolicited transfer stays restricted in indexed pool',async()=>{
      const allowance=123456789n;await c.send(c.usdc,'approve',[c.vault.address,allowance],'insured');assert.equal(await c.read(c.usdc,'allowance',[c.accounts.insured.address,c.vault.address]),allowance);
      const failed=await c.quote({annualLimit:150000n*U,incidentLimit:150000n*U});const before=await c.state();
      await c.rejects(c.core,'purchasePolicy',[failed.q,failed.sig],'insured');await mine();
      assert.equal((await c.read(c.core,'getPolicy',[failed.q.quoteId])).issuedAt,0n);assert.equal(await c.read(c.core,'quoteUsed',[failed.q.quoteId]),false);
      assert.equal((await req('GET','/api/views/policy','insured')).json().some((p:any)=>p.id===failed.q.quoteId),false);assert.deepEqual(await c.state(),before);
      const W=before.pool.A_U_W[2],H0=before.pool.H,K0=before.pool.K;
      await c.send(c.usdc,'transfer',[c.vault.address,7n*U],'insured');await mine();
      const pool=(await req('GET','/api/views/pool','assessor')).json().find((p:any)=>p.id.toLowerCase()===c.vault.address.toLowerCase()).payload;
      assert.equal(pool.balances[1],'7000000');assert.equal(pool.balances[2],W.toString());assert.equal(pool.H,H0.toString());assert.equal(pool.K,K0.toString());
      await c.rejects(c.core,'withdrawCapital',[c.vault.address,W+1n],'treasurer');
      assert.equal((await req('GET','/api/views/policy','insured')).json().some((p:any)=>p.id===failed.q.quoteId),false);
    });
    await run('AC21 customer reads denial reason, appeals and retains old decisions and payment history after reopening',async()=>{
      const deniedNotice=await c.notice(q),deniedIncident=id(),reason='合成拒赔：经核验本次可赔净损失为零';
      const zeroExpenses=[{gross:'0',duplicate:'0',compensation:'0',recovery:'0'},{gross:'0',duplicate:'0',compensation:'0',recovery:'0'}];
      const created=await req('POST','/api/drafts','assessor',{policyId:q.quoteId,incidentId:deniedIncident,noticeIds:[deniedNotice.n.noticeId],expenses:zeroExpenses,reason,approver:c.accounts.approver.address});assert.equal(created.statusCode,200,created.body);const deniedId=created.json().id;
      assert.equal((await req('POST',`/api/drafts/${deniedId}/sign`,'approver',{})).statusCode,200);assert.equal((await req('POST',`/api/drafts/${deniedId}/submit`,'approver',{})).statusCode,200);await worker.tick();await mine();
      const denied=(await req('GET','/api/drafts','insured')).json().find((d:any)=>d.id===deniedId);assert.equal(denied.payload.reason,reason);assert.equal(denied.payload.d.netApproved,'0');
      const oldDigest=await c.read(c.core,'decisionHistory',[deniedIncident,1n]);const oldPayments=(await req('GET','/api/transactions','insured')).json().filter((r:any)=>r.action==='executePayment');
      assert.equal((await req('POST','/api/manual/dispute','insured',{incidentId:deniedIncident,reason:'补充损失依据申请复核'})).statusCode,200);await worker.tick();await mine();
      assert.equal((await req('POST','/api/manual/reopen','approver2',{incidentId:deniedIncident,reason:'独立审核同意重开'})).statusCode,200);await worker.tick();await mine();
      const revised=await req('POST','/api/drafts','assessor2',{policyId:q.quoteId,incidentId:deniedIncident,noticeIds:[deniedNotice.n.noticeId],expenses:[{...zeroExpenses[0],gross:'1000000000'},zeroExpenses[1]],reason:'新增材料核实后批准1000',approver:c.accounts.approver2.address});assert.equal(revised.statusCode,200,revised.body);const revisedId=revised.json().id;
      await req('POST',`/api/drafts/${revisedId}/sign`,'approver2',{});assert.equal((await req('POST',`/api/drafts/${revisedId}/submit`,'approver2',{})).statusCode,200);await worker.tick();await mine();
      const drafts=(await req('GET','/api/drafts','insured')).json();assert.deepEqual(drafts.find((d:any)=>d.id===deniedId),denied);assert.equal(drafts.find((d:any)=>d.id===revisedId).payload.d.version,'2');
      assert.equal(await c.read(c.core,'decisionHistory',[deniedIncident,1n]),oldDigest);assert.notEqual(await c.read(c.core,'decisionHistory',[deniedIncident,2n]),oldDigest);
      assert.deepEqual((await req('GET','/api/transactions','insured')).json().filter((r:any)=>r.action==='executePayment'),oldPayments);
    });
  }finally{
    const report={runId:c.runId,outcomes,database:path,blocks:s.all('SELECT * FROM blocks'),events:s.all('SELECT * FROM events'),transactions:s.all('SELECT id,action,state,tx_hash,receipt,error FROM outbox'),views:s.all('SELECT * FROM views')};
    mkdirSync('reports',{recursive:true});writeFileSync(`reports/m2a-${c.runId}.json`,json(report));console.log(`M2a evidence: reports/m2a-${c.runId}.json`);
    await app.close();s.close();await c.connection.close();
  }
});
test('M2a process crash: committed WAL survives and incomplete transaction rolls back',()=>{
  mkdirSync('.local',{recursive:true});const runId=randomUUID(),path=`.local/crash-${runId}.sqlite`;
  for(const mode of ['committed','uncommitted']){const child=spawnSync(process.execPath,['--import','tsx','tests/service-crash-child.ts',path,'synthetic-crash-scope',mode],{encoding:'utf8'});assert.equal(child.status,17,child.stderr);}
  const recovered=new Store(path,'synthetic-crash-scope');assert.equal(recovered.get("SELECT count(*) AS n FROM audit WHERE id='committed'").n,1);assert.equal(recovered.get("SELECT count(*) AS n FROM audit WHERE id='uncommitted'").n,0);recovered.close();
  writeFileSync(`reports/m2a-crash-${runId}.json`,json({runId,status:'passed',committedRows:1,uncommittedRows:0,processExitCode:17,database:path}));console.log(`Crash evidence: reports/m2a-crash-${runId}.json`);
});
