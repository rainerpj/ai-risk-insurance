import Fastify from 'fastify';
import {timingSafeEqual} from 'node:crypto';
import {Authorizer,Reviewer} from './automatic.ts';
import {hash,json,Store} from './store.ts';
import {Chain} from './chain.ts';
import {budgetSnapshot} from './operations.ts';
import {SemanticIntake} from './supplement.ts';
import {observeRouting,routingObservations} from './routing-proof.ts';
import {intakeStatus,importOriginal,submitSupplement} from './intake-portal.ts';
import type {ModelSpend} from './model-spend.ts';
import type {ModelJobs} from './model-jobs.ts';
const eq=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
function base(){const app=Fastify({bodyLimit:128*1024});app.setErrorHandler((e:any,_req,reply)=>{
  if(['AUTHORIZER_BUSY_RETRY','RECONCILIATION_REQUIRED','INTAKE_BUSY_RETRY'].includes(e.message))return reply.header('retry-after','1').code(503).send({error:e.message});
  return reply.code(e.statusCode??409).send({error:e.message});
});return app;}
function guard(app:ReturnType<typeof base>,tokens:Record<string,string>){
  for(const token of Object.values(tokens))if(token.length<32)throw new Error('CAPABILITY_TOO_SHORT');
  if(new Set(Object.values(tokens)).size!==Object.keys(tokens).length)throw new Error('CAPABILITIES_MUST_DIFFER');
  app.addHook('onRequest',async(req,reply)=>{const role=req.routeOptions.config as {capability?:string};const capability=role.capability==='portal'?'portal:'+(req.params as any).tenant:role.capability;const expected=capability?tokens[capability]:undefined;
    if(!expected||!eq(req.headers.authorization??'','Bearer '+expected))return reply.code(403).send({error:'CAPABILITY_DENIED'});});
}
export function reviewerApp(worker:Reviewer,token:string,store?:Store,portalTokens:Record<string,string>={},modelJobs?:ModelJobs,modelSpend?:ModelSpend){const app=base();
  if(Object.keys(portalTokens).some(tenant=>!/^0x[a-f0-9]{64}$/.test(tenant)))throw Error('TENANT_SCHEMA');
  guard(app,{intake:token,...Object.fromEntries(Object.entries(portalTokens).map(([tenant,value])=>['portal:'+tenant,value]))});
  const intake=store?new SemanticIntake(store,worker):undefined;
  if(modelJobs){
    if(modelSpend)app.get('/portal/:tenant/model-costs',{config:{capability:'portal'}},async(req)=>modelJobs.costSnapshot((req.params as any).tenant,modelSpend));
    app.post('/model-intake',{config:{capability:'intake'}},async(req)=>{const b=req.body as any;if(!b||Object.keys(b).join()!=='request')throw Error('MODEL_INTAKE_SCHEMA');return modelJobs.enqueue(b.request);});
    app.get('/model-jobs/:id',{config:{capability:'intake'}},async(req)=>modelJobs.get((req.params as any).id));
  }
  if(store){
    worker.routingObserver=request=>observeRouting(store,worker,request);
    app.get('/portal/:tenant/routing',{config:{capability:'portal'}},async(req)=>routingObservations(store,(req.params as any).tenant));
    app.post('/portal/:tenant/supplement',{config:{capability:'portal'}},async(req)=>submitSupplement(store,worker,intake!,(req.params as any).tenant,req.body));
    app.get('/portal/:tenant/intakes',{config:{capability:'portal'}},async(req)=>intakeStatus(store,(req.params as any).tenant));
    app.post('/portal/:tenant/originals',{config:{capability:'portal'}},async(req)=>{const tenant=(req.params as any).tenant,result=await importOriginal(worker,tenant,req.body);store.audit(tenant,'signed_original_imported',result.ref);return {...result,scope:store.getMeta('scope'),tenant};});
  }
  if(intake){app.post('/semantic-intake',{config:{capability:'intake'}},async(req)=>{const b=req.body as any;if(!b||Object.keys(b).sort().join()!=='proposal,request,submit'||typeof b.submit!=='boolean')throw Error('INTAKE_SCHEMA');return JSON.parse(json(await intake.run(b.request,b.proposal,b.submit)));});}
  app.post('/review-semantic',{config:{capability:'intake'}},async(req)=>{const b=req.body as any;if(intake){const result=await intake.run(b.request,b.proposal);if(result.state!=='ready')throw Error('INTAKE_'+result.state.toUpperCase());return JSON.parse(json(result.assessment));}return JSON.parse(json(await worker.assess(b.request,b.proposal)));});
  app.post('/review',{config:{capability:'intake'}},async(req)=>JSON.parse(json(await worker.assess(req.body as any))));return app;
}
export function authorizerApp(worker:Authorizer,tokens:{reviewer:string;executor:string;observer?:string}){const app=base();guard(app,Object.fromEntries(Object.entries(tokens).filter(([,v])=>v!==undefined)) as Record<string,string>);
  app.get('/operations/:tenant',{config:{capability:'observer'}},async(req)=>{const tenant=(req.params as any).tenant;if(!/^0x[a-f0-9]{64}$/.test(tenant))throw new Error('TENANT_SCHEMA');return budgetSnapshot(worker.budget,tenant,Number((await worker.chain.client.getBlock()).timestamp));});
  app.post('/authorize',{config:{capability:'reviewer'}},async(req)=>{const b=req.body as any;return JSON.parse(json(await worker.authorize(b.request,b.a,b.signature,b.proposal)));});
  app.post('/payment',{config:{capability:'executor'}},async(req)=>{const b=req.body as any;return JSON.parse(json(await worker.payment(b.reservationId,b.amount,b.requestId)));});
  app.get('/jobs',{config:{capability:'executor'}},async()=>worker.budget.all('SELECT envelope FROM jobs').map(j=>JSON.parse(j.envelope)));
  app.get('/status',{config:{capability:'executor'}},async()=>({ready:worker.budget.meta('ready')==='1',reservations:worker.budget.all('SELECT id,remaining,state FROM reservations'),payments:worker.budget.all('SELECT id,amount,state FROM payments')}));
  // No arbitrary typed-data signing, config edits, release, chain writes or key retrieval routes.
  return app;
}
export function executorApp(store:Store,chain:Chain,actor:string,authorizer:string,token:string){const app=base();guard(app,{dispatch:token});
  app.post('/enqueue',{config:{capability:'dispatch'}},async(req)=>{const job=req.body as any;
    if(!['registerDecision','executePayment'].includes(job.action)||!Array.isArray(job.args)||!/^0x[a-f0-9]{64}$/.test(job.id))throw new Error('AUTOMATIC_JOB_ONLY');
    const m=job.args[0],id=job.action==='registerDecision'?m.decisionId:m.paymentId;
    if(id!==job.id)throw new Error('BUSINESS_ID_MISMATCH');
    const decision=job.action==='registerDecision'?m:(await chain.incident(m.incidentId)).decision;
    if(![1n,2n].includes(BigInt(decision.channel))||decision.approver.toLowerCase()!==authorizer.toLowerCase())throw new Error('AUTOMATIC_AUTHORIZER_REQUIRED');
    const q=(await chain.policy(m.policyId)).quote;
    store.tx(()=>{const previous=store.get('SELECT payload_hash FROM outbox WHERE id=?',job.id);if(previous&&previous.payload_hash!==hash(job.args))throw new Error('IMMUTABLE_JOB_CONFLICT');
      store.run("INSERT OR IGNORE INTO outbox(id,tenant,actor,action,payload,payload_hash,state) VALUES(?,?,?,?,?,?,'queued')",job.id,q.enterpriseId,actor,job.action,json(job.args),hash(job.args));});return {id:job.id,state:store.get('SELECT state FROM outbox WHERE id=?',job.id).state};
  });return app;
}
