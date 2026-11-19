import test from 'node:test';
import assert from 'node:assert/strict';
import {renameSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {semanticFixture} from './m2c-fixture.ts';
import {SemanticIntake,expireSemanticIntakes} from '../packages/service/supplement.ts';
import {Reviewer} from '../packages/service/automatic.ts';
import {Store} from '../packages/service/store.ts';
import {reviewerApp} from '../packages/service/automatic-api.ts';
import {H,type Request} from '../packages/service/reviewer.ts';
import type {AgentProposal} from '../packages/service/agent.ts';
import {Worker,Indexer} from '../packages/service/indexer.ts';
import {executorApp} from '../packages/service/automatic-api.ts';
import {json} from '../packages/service/store.ts';
import {id} from './chain-helper.ts';

test('one exact-original supplement survives database reopen; signed assessment follows independent validation',async()=>{
 const f=await semanticFixture(),path=resolve(f.dir,'supplement.sqlite'),scope=f.store.getMeta('scope')!;
 let store=new Store(path,scope);const reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer);
 const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
 try{
  let intake=new SemanticIntake(store,reviewer);const first=await intake.run(f.request,f.proposal);assert.equal(first.state,'awaiting_evidence');assert.deepEqual(first.missing,[f.refs[3]]);assert.equal(first.assessment,undefined);
  const repeated=await intake.run(f.request,f.proposal);assert.equal(repeated.supplementUsed,false);assert.equal(repeated.deadline,first.deadline);
  store.close();store=new Store(path,scope);intake=new SemanticIntake(store,reviewer);renameSync(file+'.offline',file);
  const completed=await intake.run(f.request,f.proposal,true);assert.equal(completed.state,'ready');assert.equal(completed.supplementUsed,true);assert.ok(completed.assessment.signature);
  assert.equal((await intake.run(f.request,f.proposal,true)).assessment.signature,completed.assessment.signature);
  await assert.rejects(()=>intake.run({...f.request,expiresAt:(BigInt(f.request.expiresAt)+1n).toString()},f.proposal),/IMMUTABLE_INTAKE/);
  console.log('Supplement recovery evidence:',f.c.save('supplement',{first,completed}));
 }finally{store.close();f.close();await f.c.connection.close();}
});

test('failed single supplement stays human after files return; HTTP cannot bypass and capability is required',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),app=reviewerApp(reviewer,'i'.repeat(40),f.store),headers={authorization:'Bearer '+'i'.repeat(40)};
 const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
 try{
  const payload={request:f.request,proposal:f.proposal,submit:false};
  assert.equal((await app.inject({method:'POST',url:'/semantic-intake',payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/semantic-intake',headers,payload})).json().state,'awaiting_evidence');
  const failed=(await app.inject({method:'POST',url:'/semantic-intake',headers,payload:{...payload,submit:true}})).json();assert.equal(failed.state,'manual');assert.deepEqual(failed.reasons,['SUPPLEMENT_INCOMPLETE']);
  renameSync(file+'.offline',file);
  const bypass=await app.inject({method:'POST',url:'/review-semantic',headers,payload});assert.equal(bypass.statusCode,409);assert.match(bypass.body,/INTAKE_MANUAL/);
 }finally{await app.close();f.close();await f.c.connection.close();}
});

test('technical timeout survives retries and an invalid original takes precedence over another missing file',async()=>{
 for(const conflict of [false,true]){
  const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer);let now=100;
  try{
   const intake=new SemanticIntake(f.store,reviewer,()=>now,10),file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
   if(conflict)writeFileSync(resolve(f.dir,f.refs[0]+'.json'),'{}');
   const first=await intake.run(f.request,f.proposal);
   if(conflict){assert.equal(first.state,'manual');assert.ok(first.reasons.includes('INVALID_OR_UNTRUSTED_ORIGINAL'));}
   else{assert.equal(first.state,'awaiting_evidence');now=110;assert.deepEqual((await intake.run(f.request,f.proposal,true)).reasons,['TECHNICAL_TIMEOUT']);}
  }finally{f.close();await f.c.connection.close();}
 }
});

test('signed payment conflict outranks missing ticket and cannot start a supplement loop',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer);
 try{
  const payment=f.originals.read(f.proposal.items[0]!.paymentRef),replacement=f.put('payment',{...payment,paid:'1'});
  const proposal=structuredClone(f.proposal);proposal.items[0]!.paymentRef=replacement;
  const refs=f.refs.map(r=>r===f.proposal.items[0]!.paymentRef?replacement:r);
  const notice=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),request={...f.request,noticeId:notice.n.noticeId,refs};
  const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
  const result=await new SemanticIntake(f.store,reviewer).run(request,proposal);
  assert.equal(result.state,'manual');assert.ok(result.reasons.includes('PAYMENT_CONFLICT'));assert.equal(result.supplementUsed,false);assert.equal(result.assessment,undefined);
 }finally{f.close();await f.c.connection.close();}
});

test('replacement supplement preserves both notice commitments through independent authorization and payment',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer);
 const executor=executorApp(f.store,f.makeChain('executor'),f.c.accounts.executor.address,f.g.authorizer,'e'.repeat(40));
 const file=resolve(f.dir,f.refs[3]+'.json'),original=f.originals.read(f.refs[3]!);renameSync(file,file+'.offline');
 try{
  const initial=await intake.run(f.request,f.proposal);assert.equal(initial.state,'awaiting_evidence');
  // Different signed bytes, same fully validated work statement; extra prose is now unknown context.
  const ref=f.put('ticket',{...original,narrative:original.narrative+' '}),refs=f.refs.map(r=>r===f.refs[3]?ref:r),notice=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)});
  const request={...f.request,noticeId:notice.n.noticeId,refs,previousEvidence:{noticeId:f.request.noticeId,refs:f.refs}},proposal=structuredClone(f.proposal);proposal.items[0]!.ticketRef=ref;
  const ready=await intake.run(request,proposal,true);assert.equal(ready.state,'ready');assert.equal(ready.deadline,initial.deadline);assert.deepEqual(ready.history[0].request,f.request);assert.equal(ready.supplementUsed,true);
  await assert.rejects(()=>intake.run(f.request,f.proposal),/IMMUTABLE_INTAKE_CONFLICT/);
  await f.enable();renameSync(file+'.offline',file);
  await assert.rejects(()=>f.authorizer.authorize(request,ready.assessment.a,ready.assessment.signature,proposal),/SUPPLEMENT_REPLACED_AVAILABLE_ORIGINAL/);
  assert.equal(f.budget.get('SELECT count(*) n FROM reservations').n,0);renameSync(file,file+'.offline');
  const job=await f.authorizer.authorize(request,ready.assessment.a,ready.assessment.signature,proposal);
  assert.deepEqual(job.args[2],[f.request.noticeId,request.noticeId].sort());
  const worker=new Worker(f.store,f.makeChain('executor')),index=new Indexer(f.store,f.makeChain('executor'),0n);
  const execute=async(job:any)=>{const response=await executor.inject({method:'POST',url:'/enqueue',headers:{authorization:'Bearer '+'e'.repeat(40)},payload:JSON.parse(json(job))});assert.equal(response.statusCode,200,response.body);await worker.tick();await f.c.connection.provider.request({method:'evm_mine'});await index.sync();};
  await execute(job);const decision:any=job.args[0];
  for(const noticeId of [f.request.noticeId,request.noticeId])assert.equal((await f.makeChain('executor').read('getNotice',[noticeId])).incidentId,decision.incidentId);
  await execute(await f.authorizer.payment(decision.reservationId,'5000000000',id()));await f.authorizer.reconcile();
  const incident=await f.makeChain('executor').read('getIncident',[decision.incidentId]);assert.equal(incident.P,5000000000n);assert.equal(incident.D,0n);assert.equal(f.budget.get('SELECT remaining FROM reservations').remaining,'0');
  console.log('Supplement replacement evidence:',f.c.save('supplement-replacement',{initial,ready,job,incident}));
 }finally{await executor.close();f.close();await f.c.connection.close();}
});

test('two competing replacement submissions consume one opportunity; existing originals cannot be removed',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer);
 const original=f.originals.read(f.refs[3]!),file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
 try{
  await intake.run(f.request,f.proposal);
  const variants:{request:Request;proposal:AgentProposal}[]=[];
  for(const suffix of [' ','\n']){
   const ref=f.put('ticket',{...original,narrative:original.narrative+suffix}),refs=f.refs.map(r=>r===f.refs[3]?ref:r),notice=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),proposal=structuredClone(f.proposal);proposal.items[0]!.ticketRef=ref;
   variants.push({request:{...f.request,noticeId:notice.n.noticeId,refs,previousEvidence:{noticeId:f.request.noticeId,refs:f.refs}},proposal});
  }
  const changedWork=f.put('work',{...f.originals.read(f.refs[4]!),units:'3'}),badRefs=variants[0]!.request.refs.map(r=>r===f.refs[4]?changedWork:r),badNotice=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(badRefs)});
  await assert.rejects(()=>intake.run({...variants[0]!.request,noticeId:badNotice.n.noticeId,refs:badRefs},variants[0]!.proposal,true),/MUST_RETAIN_AVAILABLE/);
  const results=await Promise.allSettled(variants.map(v=>intake.run(v.request,v.proposal,true)));
  assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.state==='ready').length,1);
  assert.equal(results.filter(r=>r.status==='rejected'&&/IMMUTABLE_INTAKE_CONFLICT/.test(r.reason.message)).length,1);
  const saved=JSON.parse(f.store.get('SELECT payload FROM semantic_intake').payload);assert.equal(saved.history.length,1);assert.equal(saved.supplementUsed,true);
 }finally{f.close();await f.c.connection.close();}
});

test('unknown ticket or conflicting extraction is human even when the same expense lacks payment',async()=>{
 for(const change of ['unknown_ticket','extraction'] as const){
  const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),proposal=structuredClone(f.proposal);let refs=[...f.refs];
  try{
   if(change==='unknown_ticket'){
    const ref=f.put('ticket',{...f.originals.read(f.refs[3]!),narrative:'工作范围及必要性仍待确认。'});refs=refs.map(r=>r===f.refs[3]?ref:r);proposal.items[0]!.ticketRef=ref;proposal.items[0]!.quote='工作范围及必要性仍待确认。';
   }else proposal.items[0]!.units='3';
   const n=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),file=resolve(f.dir,proposal.items[0]!.paymentRef+'.json');renameSync(file,file+'.offline');
   const state=await new SemanticIntake(f.store,reviewer).run({...f.request,noticeId:n.n.noticeId,refs},proposal);
   assert.equal(state.state,'manual');assert.ok(state.reasons.includes('EXPENSE_CONFLICT_OR_UNKNOWN'));assert.equal(state.supplementUsed,false);
  }finally{f.close();await f.c.connection.close();}
 }
});

test('replacement checkpoint survives interruption without a second opportunity or a new deadline',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),path=resolve(f.dir,'lineage-restart.sqlite'),scope=f.store.getMeta('scope')!;
 let store=new Store(path,scope),intake=new SemanticIntake(store,reviewer);const read=reviewer.chain.read.bind(reviewer.chain);
 try{
  const original=f.originals.read(f.refs[3]!),file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
  const first=await intake.run(f.request,f.proposal),ref=f.put('ticket',{...original,narrative:' '+original.narrative}),refs=f.refs.map(r=>r===f.refs[3]?ref:r),n=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),proposal=structuredClone(f.proposal);proposal.items[0]!.ticketRef=ref;
  const request={...f.request,noticeId:n.n.noticeId,refs,previousEvidence:{noticeId:f.request.noticeId,refs:f.refs}};
  reviewer.chain.read=async(name,...args)=>{if(name==='getIncident')throw Error('SIMULATED_RPC_INTERRUPTION');return read(name,...args);};
  await assert.rejects(()=>intake.run(request,proposal,true),/SIMULATED_RPC_INTERRUPTION/);
  const pending=JSON.parse(store.get('SELECT payload FROM semantic_intake').payload);assert.equal(pending.state,'checking');assert.equal(pending.supplementUsed,true);assert.equal(pending.history.length,1);
  store.close();store=new Store(path,scope);intake=new SemanticIntake(store,reviewer);reviewer.chain.read=read;
  const recovered=await intake.run(request,proposal,true);assert.equal(recovered.state,'ready');assert.equal(recovered.deadline,first.deadline);assert.equal(recovered.history.length,1);assert.ok(recovered.assessment.signature);
 }finally{reviewer.chain.read=read;store.close();f.close();await f.c.connection.close();}
});

test('initially unregistered evidence is requested once and new notice completes independent authorization',async()=>{
 for(const allMissing of [false,true]){
  const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer);
  try{
   const refs=allMissing?[]:f.refs.filter(r=>r!==f.proposal.items[0]!.paymentRef),n=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),firstRequest={...f.request,noticeId:n.n.noticeId,refs};
   const first=await intake.run(firstRequest,null);assert.equal(first.state,'awaiting_evidence');assert.equal(first.assessment,undefined);assert.deepEqual(first.missing,[]);
   assert.deepEqual(first.missingKinds,allMissing?[{kind:'release',count:1},{kind:'monitor',count:1},{kind:'replay',count:1},{kind:'ticket',count:2},{kind:'work',count:2},{kind:'completion',count:2},{kind:'payment',count:2}]:[{kind:'payment',count:1}]);
   const request={...f.request,previousEvidence:{noticeId:firstRequest.noticeId,refs}};
   const ready=await intake.run(request,f.proposal,true);assert.equal(ready.state,'ready');assert.deepEqual(ready.missingKinds,[]);assert.equal(ready.deadline,first.deadline);
   await f.enable();const job=await f.authorizer.authorize(request,ready.assessment.a,ready.assessment.signature,f.proposal);
   assert.deepEqual(job.args[2],[request.noticeId,firstRequest.noticeId].sort());assert.equal((job.args[0] as any).netApproved,5000000000n);
   console.log('Initial missing evidence:',f.c.save('supplement-initial-missing',{first,ready,job}));
  }finally{f.close();await f.c.connection.close();}
 }
});

test('an incomplete addition consumes the only supplement; complete evidence can wait for a proposal',async()=>{
 for(const stillMissing of [false,true]){
  const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer);
  try{
   if(!stillMissing){const first=await intake.run(f.request,null);assert.equal(first.state,'awaiting_proposal');const ready=await intake.run(f.request,f.proposal);assert.equal(ready.state,'ready');assert.equal(ready.supplementUsed,false);continue;}
   const n=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H([])}),firstRequest={...f.request,noticeId:n.n.noticeId,refs:[]};await intake.run(firstRequest,null);
   const refs=f.refs.slice(0,-1),next=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),request={...f.request,noticeId:next.n.noticeId,refs,previousEvidence:{noticeId:n.n.noticeId,refs:[]}};
   const state=await intake.run(request,null,true);assert.equal(state.state,'manual');assert.deepEqual(state.reasons,['SUPPLEMENT_INCOMPLETE']);assert.equal(state.supplementUsed,true);
   await assert.rejects(()=>intake.run({...request,noticeId:f.request.noticeId,refs:f.refs},f.proposal,true),/IMMUTABLE_INTAKE_CONFLICT/);
  }finally{f.close();await f.c.connection.close();}
 }
});

test('initial missing references do not hide unknown signed text or allow proposal references outside manifest',async()=>{
 for(const unknown of [false,true]){
  const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer);
  try{
   let refs=f.refs.filter(r=>r!==f.proposal.items[0]!.paymentRef);
   if(unknown){const ref=f.put('ticket',{...f.originals.read(f.refs[3]!),narrative:'必要性待调查。'});refs=refs.map(r=>r===f.refs[3]?ref:r);}
   const n=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),state=await intake.run({...f.request,noticeId:n.n.noticeId,refs},unknown?null:f.proposal);
   assert.equal(state.state,'manual');assert.ok(state.reasons.includes(unknown?'TICKET_CONFLICT_OR_UNKNOWN':'UNBOUND_PROPOSAL_REFERENCE'));
  }finally{f.close();await f.c.connection.close();}
 }
});

test('same-notice restoration can supply the first proposal without resetting the supplement deadline',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer);
 try{
  const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
  const pending=await intake.run(f.request,null);assert.equal(pending.state,'awaiting_evidence');renameSync(file+'.offline',file);
  const ready=await intake.run(f.request,f.proposal,true);assert.equal(ready.state,'ready');assert.equal(ready.supplementUsed,true);assert.equal(ready.deadline,pending.deadline);assert.equal(ready.history[0].proposal,null);assert.deepEqual(ready.history[0].request,f.request);
 }finally{f.close();await f.c.connection.close();}
});

test('deadline sweep escalates idle cases without a new submission and records only one timeout',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer,()=>100,10);
 try{
  const pending=await intake.run(f.request,null);assert.equal(pending.state,'awaiting_proposal');
  assert.equal(expireSemanticIntakes(f.store,109),0);assert.equal(expireSemanticIntakes(f.store,110),1);assert.equal(expireSemanticIntakes(f.store,111),0);
  const saved=JSON.parse(f.store.get('SELECT payload FROM semantic_intake').payload);assert.equal(saved.state,'manual');assert.deepEqual(saved.reasons,['TECHNICAL_TIMEOUT']);assert.equal(saved.escalatedAt,110);assert.equal(saved.deadline,pending.deadline);
  assert.equal(f.store.get("SELECT count(*) n FROM audit WHERE action='technical_timeout_to_manual'").n,1);
  await assert.rejects(()=>new SemanticIntake(f.store,reviewer,()=>0).run(f.request,f.proposal),/IMMUTABLE_INTAKE_CONFLICT/);
  assert.equal(f.budget.get('SELECT count(*) n FROM reservations').n,0);
 }finally{f.close();await f.c.connection.close();}
});

test('deadline sweep wins an in-flight assessment and does not reopen a completed review',async()=>{
 const f=await semanticFixture(),reviewer=new Reviewer(f.makeChain('outsider'),f.originals,f.g.reviewer),intake=new SemanticIntake(f.store,reviewer,()=>100,10);
 let release=()=>{},entered=()=>{};const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),assess=reviewer.assess.bind(reviewer);
 reviewer.assess=async(...args)=>{entered();await gate;return assess(...args);};
 try{
  const pending=intake.run(f.request,f.proposal);await started;assert.equal(expireSemanticIntakes(f.store,110),1);release();const final=await pending;assert.equal(final.state,'manual');assert.equal(final.assessment,undefined);
 }finally{release();f.close();await f.c.connection.close();}
 const completed=await semanticFixture();try{
  const intake=new SemanticIntake(completed.store,new Reviewer(completed.makeChain('outsider'),completed.originals,completed.g.reviewer),()=>100,10);
  assert.equal((await intake.run(completed.request,completed.proposal)).state,'ready');assert.equal(expireSemanticIntakes(completed.store,110),0);
 }finally{completed.close();await completed.c.connection.close();}
});
