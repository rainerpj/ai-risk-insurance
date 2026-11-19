// Explicit local integration harness: starts three isolated signer processes, never a public chain.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFileSync,readFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {autoFixture} from '../tests/m2b-fixture.ts';
import {semanticFixture} from '../tests/m2c-fixture.ts';
import {runAgent} from '../packages/service/agent.ts';
import {id,U} from '../tests/chain-helper.ts';
import {json,Store} from '../packages/service/store.ts';
import {H,type Request} from '../packages/service/reviewer.ts';
import {seedIntake} from '../tests/seed-intake.ts';
import {assertLocal} from '../packages/domain/local.ts';
const privateKeys:Record<string,string>={},children:ChildProcess[]=[];
const args=process.argv.slice(2);
if(args.some(a=>!['--l2','--supplement','--stub'].includes(a)))throw Error('UNSUPPORTED_SCENARIO_MODE: real-model evaluation uses eval:l2 --real with private configuration');
if((args.includes('--l2')||args.includes('--supplement'))!==args.includes('--stub'))throw Error('EXPLICIT_STUB_MODE_REQUIRED_FOR_SEMANTIC_SCENARIO');
const supplement=process.argv.includes('--supplement'),l2=supplement||process.argv.includes('--l2'),options={network:'localhost' as const,captureKey:(name:string,key:string)=>{privateKeys[name]=key;}};
const f=l2?await semanticFixture(undefined,options):await autoFixture(options);
const expected=l2?5000n*U:800n*U;
async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return port as number;}
const ports={reviewer:await freePort(),authorizer:await freePort(),executor:await freePort()},token=()=>randomBytes(32).toString('hex'),caps={intake:token(),reviewer:token(),executor:token(),dispatch:token(),portal:token()};
const deployed=(f.c.records as {action:string;receipt:{blockNumber:bigint}}[]).find(r=>r.action==='deploy InsuranceCore');if(!deployed)throw Error('CORE_DEPLOYMENT_RECEIPT_MISSING');
// This fresh core cannot have events before its deployment; do not rescan unrelated older rehearsal chains.
const rpc=process.env.RPC_URL??'http://127.0.0.1:8545';assertLocal(rpc);
const common={rpc,core:f.c.core.address,deploymentId:f.c.salt,startBlock:Number(deployed.receipt.blockNumber)};
const configs={
 reviewer:{...common,role:'reviewer',port:ports.reviewer,privateKey:privateKeys.outsider,originals:'.',trust:f.trust,intakeToken:caps.intake,portalTokens:{[f.q.enterpriseId]:caps.portal}},
 authorizer:{...common,role:'authorizer',port:ports.authorizer,privateKey:privateKeys.approver2,originals:'.',trust:f.trust,database:'budget.sqlite',intakeDatabase:'executor.sqlite',reviewerToken:caps.reviewer,executorToken:caps.executor},
 executor:{...common,role:'executor',port:ports.executor,privateKey:privateKeys.executor,database:'executor-process.sqlite',authorizer:f.g.authorizer,dispatchToken:caps.dispatch,testExitAfterBroadcastId:''},
};
for(const [name,cfg] of Object.entries(configs))writeFileSync(resolve(f.dir,name+'.json'),json(cfg));
writeFileSync(resolve(f.dir,'client.json'),json({ports,caps,request:f.request}));
async function start(role:keyof typeof configs){const child=spawn(process.execPath,['--import','tsx','scripts/serve-auto.ts',resolve(f.dir,role+'.json'),...(l2&&role==='executor'?['--test-faults']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);
 await new Promise<void>((res,rej)=>{let output='';const timer=setTimeout(()=>rej(new Error(role+' process startup timeout: '+output)),20000);child.stdout!.on('data',v=>{output+=v;if(output.includes('Automatic ')){clearTimeout(timer);res();}});child.stderr!.on('data',v=>output+=v);child.once('exit',code=>{clearTimeout(timer);rej(new Error(role+' process exited '+code+': '+output));});});return child;
}
async function request(role:keyof typeof configs,path:string,cap:string,body?:any){
 for(let retry=0;retry<40;retry++){
  const res=await fetch(`http://127.0.0.1:${ports[role]}${path}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+cap,'content-type':'application/json'},body:body?json(body):undefined});const data:any=await res.json();
  if(res.status===503&&['AUTHORIZER_BUSY_RETRY','RECONCILIATION_REQUIRED','INTAKE_BUSY_RETRY'].includes(data.error)){await new Promise(r=>setTimeout(r,150));continue;}
  assert.equal(res.status,200,json(data));return data;
 }throw new Error('AUTHORIZER_NOT_READY');
}
async function eventually(fn:()=>Promise<boolean>){for(let n=0;n<80;n++){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw new Error('RECOVERY_TIMEOUT');}
async function stop(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(r=>child.once('exit',()=>r()));if(!child.kill())return;await exited;}
try{
 await f.enable();f.budget.close(); // Authorizer process is now the sole budget owner.
 let reviewer=await start('reviewer');let auth=await start('authorizer');let exec=await start('executor');
 let effectiveRequest:Request=f.request,supplementEvidence:any;
 if(supplement){
  const notice=await f.c.notice(f.q,{incidentCommitment:('scope' in f&&typeof f.scope==='object'?f.scope.commitment:(await f.makeChain('executor').read('getNotice',[f.request.noticeId])).data.incidentCommitment),evidenceHash:H([])});
  const initialRequest={...f.request,noticeId:notice.n.noticeId,refs:[]},portal='/portal/'+f.q.enterpriseId;
  const pending=await request('reviewer','/semantic-intake',caps.intake,{request:initialRequest,proposal:null,submit:false});assert.equal(pending.state,'awaiting_evidence');
  await stop(reviewer);reviewer=await start('reviewer');
  const restarted=await request('reviewer',portal+'/intakes',caps.portal);assert.equal(restarted.cases[0].deadline,pending.deadline);assert.equal(restarted.cases[0].supplementUsed,false);
  const originalPath=resolve(f.dir,f.request.refs[3]+'.json'),document=readFileSync(originalPath,'utf8');renameSync(originalPath,originalPath+'.offline');
  const restored=await request('reviewer',portal+'/originals',caps.portal,{noticeId:f.request.noticeId,document});assert.equal(restored.ref,f.request.refs[3]);
  const body={caseId:pending.id,noticeId:f.request.noticeId,refs:f.request.refs},submitted=await request('reviewer',portal+'/supplement',caps.portal,body);
  assert.equal(submitted.cases[0].state,'awaiting_proposal');assert.equal(submitted.cases[0].supplementUsed,true);assert.equal(submitted.cases[0].deadline,pending.deadline);
  await stop(reviewer);reviewer=await start('reviewer');
  const retried=await request('reviewer',portal+'/supplement',caps.portal,body);assert.deepEqual(retried,submitted);
  effectiveRequest={...f.request,previousEvidence:{noticeId:initialRequest.noticeId,refs:[]}};
  supplementEvidence={pending:restarted,restored,submitted,retried,reviewerRestarts:2};
 }
 let modelRun:any;
 await seedIntake(f.store,f.makeChain('executor'),f.c.accounts.insured,effectiveRequest,expected);
 if(effectiveRequest.previousEvidence)await seedIntake(f.store,f.makeChain('executor'),f.c.accounts.insured,{...effectiveRequest,noticeId:effectiveRequest.previousEvidence.noticeId},0n);
 if('proposal' in f)modelRun=await runAgent({kind:'stub',modelVersion:'stub-semantic-v1',respond:async()=>({inputTokens:20,outputTokens:50,output:json(f.proposal)})},f.tools,f.refs);
 const assessed=await request('reviewer',l2?'/review-semantic':'/review',caps.intake,l2?{request:effectiveRequest,proposal:modelRun.proposal}:effectiveRequest);
 const decision=await request('authorizer','/authorize',caps.reviewer,{...assessed,...(l2?{proposal:modelRun.proposal}:{})});
 // Kill authorizer after durable signing and before relayer sees the response; retrieve persisted job after restart.
 await stop(auth);auth=await start('authorizer');const recovered=await request('authorizer','/jobs',caps.executor);assert.equal(recovered[0].id,decision.id);
 await request('executor','/enqueue',caps.dispatch,recovered[0]);
 await eventually(async()=>{await f.c.connection.provider.request({method:'evm_mine'});return (await f.c.read(f.c.core,'getIncident',[decision.args[0].incidentId])).version===1n;});
 const payment=await request('authorizer','/payment',caps.executor,{reservationId:decision.args[0].reservationId,amount:expected.toString(),requestId:id()});
 let faultEvidence:any;
 if(l2){await stop(exec);configs.executor.testExitAfterBroadcastId=payment.id;writeFileSync(resolve(f.dir,'executor.json'),json(configs.executor));exec=await start('executor');}
 await request('executor','/enqueue',caps.dispatch,payment);
 if(l2){await eventually(async()=>exec.exitCode!==null);assert.equal(exec.exitCode,73);const saved=new Store(resolve(f.dir,'executor-process.sqlite'),`31337:${f.c.core.address}:${f.c.salt}`);try{faultEvidence=saved.get('SELECT id,state,tx_hash,raw FROM outbox WHERE id=?',payment.id);assert.equal(faultEvidence.state,'unknown');assert(faultEvidence.raw);assert.equal(saved.getMeta('testBroadcastExit'),payment.id);}finally{saved.close();}}else await stop(exec);
 exec=await start('executor');
 await request('executor','/enqueue',caps.dispatch,payment); // Same business ID after recovery, never a second payment.
 await eventually(async()=>{await f.c.connection.provider.request({method:'evm_mine'});return (await request('authorizer','/status',caps.executor)).payments[0]?.state==='confirmed';});
 const final=await f.c.state(f.q,decision.args[0].incidentId);assert.equal(final.incident.P,expected);assert.equal(final.incident.D,0n);
 if(supplement){for(const noticeId of decision.args[2])assert.equal((await f.makeChain('executor').read('getNotice',[noticeId])).incidentId,decision.args[0].incidentId);assert.equal(decision.args[2].length,2);}
 const status=await request('authorizer','/status',caps.executor);assert.equal(status.reservations[0].remaining,'0');
 console.log('Three-process evidence:',f.c.save(supplement?'m2c-supplement-process':l2?'m2c-process':'m2b-process',{modelRun,supplementEvidence,faultEvidence,processes:['reviewer','authorizer','executor'],signersSeparated:true,authorizerRestart:true,executorRestart:true,status,final}));
}finally{try{await f.enable(false,false);}finally{for(const child of children)await stop(child);f.store.close();await f.c.connection.close();}}
console.log('Private configs retained under .local for inspection; child services stopped.');
