import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,renameSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sign} from 'node:crypto';
import {semanticFixture} from './m2c-fixture.ts';
import {reviewerApp} from '../packages/service/automatic-api.ts';
import {createApp} from '../packages/service/api.ts';
import {remoteIntakePortal} from '../packages/service/intake-portal.ts';
import {hash,json} from '../packages/service/store.ts';
import {H} from '../packages/service/reviewer.ts';

test('tenant capabilities import signed originals atomically and cannot read other cases or obtain review signatures',async()=>{
 const f=await semanticFixture(),tenant=f.q.enterpriseId,other=H('portal other'),tokens={[tenant]:'p'.repeat(40),[other]:'o'.repeat(40)},app=reviewerApp(f.reviewer,'r'.repeat(40),f.store,tokens);
 const file=resolve(f.dir,f.refs[3]+'.json'),document=readFileSync(file,'utf8');renameSync(file,file+'.offline');
 try{
  const intake=await app.inject({method:'POST',url:'/semantic-intake',headers:{authorization:'Bearer '+'r'.repeat(40)},payload:{request:f.request,proposal:null,submit:false}});assert.equal(intake.json().state,'awaiting_evidence');
  const get=async(t:string,token:string)=>app.inject({url:'/portal/'+t+'/intakes',headers:{authorization:'Bearer '+token}});
  const mine=await get(tenant,tokens[tenant]!);assert.equal(mine.statusCode,200);assert.equal(mine.json().cases.length,1);
  for(const field of ['proposal','signature','assessment','privateKey'])assert(!mine.body.includes('"'+field+'"'));
  assert.equal((await get(other,tokens[tenant]!)).statusCode,403);assert.deepEqual((await get(other,tokens[other]!)).json().cases,[]);
  for(const url of ['/review','/review-semantic','/semantic-intake'])assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer '+tokens[tenant]},payload:{}})).statusCode,403);
  const upload=(t:string,doc:string)=>app.inject({method:'POST',url:'/portal/'+t+'/originals',headers:{authorization:'Bearer '+tokens[t]},payload:{noticeId:f.request.noticeId,document:doc}});
  assert.equal((await upload(other,document)).statusCode,409);assert.equal(existsSync(file),false);
  const forged=JSON.parse(document);forged.body.narrative='forged';assert.equal((await upload(tenant,json(forged))).statusCode,409);assert(!existsSync(resolve(f.dir,hash(forged)+'.json')));
  for(const field of ['enterpriseId','policyId','deploymentId','runtimeDeployment','commitment','workflowHash']){
   const foreign=JSON.parse(document);foreign.body[field]+='-other';foreign.signature=sign(null,Buffer.from(hash(foreign.body)),f.sourceKeys.ticket.privateKey).toString('base64');
   assert.equal((await upload(tenant,json(foreign))).statusCode,409,field);assert(!existsSync(resolve(f.dir,hash(foreign)+'.json')));
  }
  assert.equal((await upload(tenant,document.slice(0,-1)+',"source":"ticket"}')).statusCode,409);
  const duplicates=await Promise.all([upload(tenant,document),upload(tenant,document)]);for(const r of duplicates){assert.equal(r.statusCode,200,r.body);assert.equal(r.json().ref,f.refs[3]);}
  assert.equal(f.originals.read(f.refs[3]!).kind,'ticket');assert(!readdirSync(f.dir).some(name=>name.startsWith('.import-')));
  writeFileSync(file,'{}');assert.equal((await upload(tenant,document)).statusCode,409);assert.equal(readFileSync(file,'utf8'),'{}');
  console.log('Intake portal evidence:',f.c.save('intake-portal',{status:mine.json(),duplicates:duplicates.map(r=>r.json()),isolation:true,immutableCorruption:true}));
 }finally{await app.close();f.close();await f.c.connection.close();}
});

test('authenticated workbench gateway uses server-side tenant binding over real HTTP and fails closed when disconnected',async()=>{
 const f=await semanticFixture(),tenant=f.q.enterpriseId,other=H('gateway other'),tokens={[tenant]:'p'.repeat(40),[other]:'o'.repeat(40)},reviewer=reviewerApp(f.reviewer,'r'.repeat(40),f.store,tokens);
 await reviewer.listen({host:'127.0.0.1',port:0});const port=(reviewer.server.address() as any).port,scope=f.store.getMeta('scope')!,remote=remoteIntakePortal('http://127.0.0.1:'+port,tokens,scope),app=createApp(f.store,f.makeChain('executor'),'http://127.0.0.1:3100',{intakePortal:remote});
 try{
  const headers:Record<string,any>={};
  for(const [actor,role,t] of [['insured','insured',tenant],['assessor','ASSESSOR',tenant],['supervisor','insured',other]] as const){
   const address=f.c.accounts[actor].address.toLowerCase();f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',address,t,role);
   const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address}})).json(),login=(await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await f.c.accounts[actor].signMessage({message:ch.message})}})).json();headers[actor]={authorization:'Bearer '+login.token};
  }
  assert.equal((await app.inject({url:'/api/semantic-intake'})).statusCode,401);
  const mine=await app.inject({url:'/api/semantic-intake?tenant='+other,headers:headers.insured});assert.equal(mine.json().tenant,tenant);
  const document=readFileSync(resolve(f.dir,f.refs[3]+'.json'),'utf8'),payload={noticeId:f.request.noticeId,document};
  assert.equal((await app.inject({method:'POST',url:'/api/semantic-originals',headers:headers.assessor,payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/semantic-originals',headers:headers.supervisor,payload})).statusCode,404);
  const upload=await app.inject({method:'POST',url:'/api/semantic-originals',headers:headers.insured,payload});assert.equal(upload.statusCode,200,upload.body);assert.equal(upload.json().ref,f.refs[3]);
  assert.throws(()=>remoteIntakePortal('https://example.com',tokens,scope),/LOCAL|RPC|LOOPBACK/);
  await assert.rejects(()=>remoteIntakePortal('http://127.0.0.1:'+port,tokens,'wrong scope').status(tenant),/SCOPE_MISMATCH/);
  await reviewer.close();assert.equal((await app.inject({url:'/api/semantic-intake',headers:headers.insured})).statusCode,503);
 }finally{await app.close();await reviewer.close();f.close();await f.c.connection.close();}
});

test('enterprise supplement supplies only evidence, retries one durable request and cannot choose a model decision',async()=>{
 const f=await semanticFixture(),tenant=f.q.enterpriseId,other=H('other supplement'),token='p'.repeat(40),app=reviewerApp(f.reviewer,'r'.repeat(40),f.store,{[tenant]:token,[other]:'o'.repeat(40)});
 const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
 const privateHeaders={authorization:'Bearer '+'r'.repeat(40)},headers={authorization:'Bearer '+token};
 try{
  const pending=(await app.inject({method:'POST',url:'/semantic-intake',headers:privateHeaders,payload:{request:f.request,proposal:f.proposal,submit:false}})).json();assert.equal(pending.state,'awaiting_evidence');
  renameSync(file+'.offline',file);const payload={caseId:pending.id,noticeId:f.request.noticeId,refs:f.refs},url='/portal/'+tenant+'/supplement';
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,proposal:f.proposal}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/portal/'+other+'/supplement',headers:{authorization:'Bearer '+'o'.repeat(40)},payload})).statusCode,409);
  const submit=()=>app.inject({method:'POST',url,headers,payload});
  const first=await submit();assert.equal(first.statusCode,200,first.body);assert.equal(first.json().cases[0].state,'awaiting_proposal');assert.equal(first.json().cases[0].deadline,pending.deadline);assert(!first.body.includes('"signature"'));
  assert.deepEqual((await submit()).json(),first.json());assert.equal(f.store.get('SELECT count(*) n FROM portal_submissions').n,1);
  assert.equal((await app.inject({method:'POST',url,headers,payload:{...payload,refs:[]}})).statusCode,409);
  const result=await app.inject({method:'POST',url:'/semantic-intake',headers:privateHeaders,payload:{request:f.request,proposal:f.proposal,submit:false}});assert.equal(result.json().state,'ready');assert.ok(result.json().assessment.signature);
  assert.equal((await submit()).json().cases[0].state,'ready');assert.equal(f.budget.get('SELECT count(*) n FROM reservations').n,0);
  console.log('Enterprise supplement evidence:',f.c.save('portal-supplement',{first:first.json(),final:(await submit()).json()}));
 }finally{await app.close();f.close();await f.c.connection.close();}
});

test('portal submission interrupted after durable checkpoint resumes with the same input',async()=>{
 const f=await semanticFixture(),tenant=f.q.enterpriseId,token='p'.repeat(40),app=reviewerApp(f.reviewer,'r'.repeat(40),f.store,{[tenant]:token}),read=f.reviewer.chain.read.bind(f.reviewer.chain);
 const file=resolve(f.dir,f.refs[3]+'.json');renameSync(file,file+'.offline');
 try{
  const pending=(await app.inject({method:'POST',url:'/semantic-intake',headers:{authorization:'Bearer '+'r'.repeat(40)},payload:{request:f.request,proposal:null,submit:false}})).json();renameSync(file+'.offline',file);
  f.reviewer.chain.read=async(name,...args)=>{if(name==='getIncident')throw Error('SIMULATED_RPC_INTERRUPTION');return read(name,...args);};
  const submit=()=>app.inject({method:'POST',url:'/portal/'+tenant+'/supplement',headers:{authorization:'Bearer '+token},payload:{caseId:pending.id,noticeId:f.request.noticeId,refs:f.refs}});
  assert.equal((await submit()).statusCode,409);assert.equal(f.store.get('SELECT state FROM portal_submissions').state,'pending');
  f.reviewer.chain.read=read;const recovered=await submit();assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().cases[0].state,'awaiting_proposal');assert.equal(recovered.json().cases[0].supplementUsed,true);assert.equal(f.store.get('SELECT state FROM portal_submissions').state,'complete');
 }finally{f.reviewer.chain.read=read;await app.close();f.close();await f.c.connection.close();}
});
