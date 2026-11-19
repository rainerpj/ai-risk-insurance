import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {Chain} from '../packages/service/chain.ts';
import {Budget} from '../packages/service/budget.ts';
import {Originals} from '../packages/service/reviewer.ts';
import {Reviewer,Authorizer} from '../packages/service/automatic.ts';
import {reviewerApp,authorizerApp,executorApp} from '../packages/service/automatic-api.ts';
import {Store} from '../packages/service/store.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {expireSemanticIntakes} from '../packages/service/supplement.ts';
import {ModelJobs} from '../packages/service/model-jobs.ts';
import {ModelSpend} from '../packages/service/model-spend.ts';
import {OpenAIAdapter} from '../packages/service/openai-adapter.ts';
import {localIntakeGate} from '../packages/service/intake-gate.ts';
const file=process.argv[2];if(!file)throw new Error('Usage: pnpm serve:auto <private per-process config.json>');
const cfg=JSON.parse(readFileSync(file,'utf8')),root=dirname(resolve(file)),account=privateKeyToAccount(cfg.privateKey);
if(cfg.role==='authorizer'&&(typeof cfg.intakeDatabase!=='string'||!cfg.intakeDatabase.trim()||resolve(root,cfg.intakeDatabase)===resolve(root,cfg.database)))throw Error('SEPARATE_INTAKE_DATABASE_REQUIRED');
// Exactly one signer per process. Reviewer never receives authorization key or budget path.
const chain=Chain.rpc(cfg.rpc,cfg.core,cfg.deploymentId,{[account.address.toLowerCase()]:account});await chain.check();
const scope=`31337:${cfg.core}:${cfg.deploymentId}`;
let app:any,close=()=>{},cycle=async()=>{},maintenance=()=>{};
if(cfg.role==='reviewer'){
  const store=new Store(resolve(root,cfg.database??'reviewer.sqlite'),scope);
  const reviewer=new Reviewer(chain,new Originals(resolve(root,cfg.originals),cfg.trust),account.address,report=>store.audit(account.address,'program_review',JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v)));
  let spend:ModelSpend|undefined,jobs:ModelJobs|undefined;
  if(cfg.model){
    if(!process.env.OPENAI_API_KEY?.trim())throw Error('MODEL_CREDENTIAL_REQUIRED');
    if(cfg.model.budget?.scope!==scope||cfg.model.budget?.price?.model!==cfg.model.version)throw Error('MODEL_COST_SCOPE_OR_VERSION');
    spend=new ModelSpend(resolve(root,cfg.model.database),cfg.model.budget);
    jobs=new ModelJobs(store,reviewer,cfg.model.version,runId=>new OpenAIAdapter({model:cfg.model.version,key:()=>process.env.OPENAI_API_KEY??'',spend:{ledger:spend!,runId},record:r=>store.audit('model-worker','model_call',JSON.stringify({runId,...r}))}),cfg.model.limits);
    jobs.recover();
  }
  app=reviewerApp(reviewer,cfg.intakeToken,store,cfg.portalTokens??{},jobs,spend);close=()=>{spend?.close();store.close();};maintenance=()=>{expireSemanticIntakes(store);};cycle=async()=>{await jobs?.tick();};
}else if(cfg.role==='authorizer'){
  const budget=new Budget(resolve(root,cfg.database),scope),worker=new Authorizer(chain,new Originals(resolve(root,cfg.originals),cfg.trust),budget,account.address,BigInt(cfg.startBlock));
  worker.intakeGate=localIntakeGate(resolve(root,cfg.intakeDatabase),scope);
  app=authorizerApp(worker,{reviewer:cfg.reviewerToken,executor:cfg.executorToken,observer:cfg.observerToken});close=()=>budget.close();cycle=async()=>{try{await worker.reconcile();}catch(e){if((e as Error).message==='AUTHORIZER_BUSY_RETRY')return;budget.pause();console.error((e as Error).message);}};
}else if(cfg.role==='executor'){
  const store=new Store(resolve(root,cfg.database),scope),index=new Indexer(store,chain,BigInt(cfg.startBlock)),worker=new Worker(store,chain);
  // Local integration harness only: exit after RPC accepted a specified transaction, before response handling.
  if(process.argv.includes('--test-faults')&&/^0x[a-f0-9]{64}$/.test(cfg.testExitAfterBroadcastId??'')){
    const broadcast=chain.client.sendRawTransaction.bind(chain.client);
    chain.client.sendRawTransaction=async(args:any)=>{const result=await broadcast(args);
      const job=store.get('SELECT id FROM outbox WHERE tx_hash=?',result);
      if(job?.id===cfg.testExitAfterBroadcastId&&store.getMeta('testBroadcastExit')!==job.id){store.meta('testBroadcastExit',job.id);process.exit(73);}return result;};
  }
  app=executorApp(store,chain,account.address,cfg.authorizer,cfg.dispatchToken);close=()=>store.close();cycle=async()=>{await index.sync();await worker.tick();};
}else throw new Error('UNKNOWN_PROCESS_ROLE');
let busy=false,stopping=false;async function tick(){if(stopping)return;try{maintenance();}catch(e){console.error((e as Error).message);}if(busy)return;busy=true;try{await cycle();}catch(e){console.error((e as Error).message);}finally{busy=false;}}
if(cfg.role==='reviewer')maintenance();else await tick();await app.listen({host:'127.0.0.1',port:cfg.port});console.log(`Automatic ${cfg.role}: 127.0.0.1:${cfg.port}`);
const timer=setInterval(tick,1000);async function stop(){stopping=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,25));await app.close();close();process.exit(0);}process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
if(cfg.role==='reviewer')void tick();
