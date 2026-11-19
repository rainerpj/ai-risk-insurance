import {Store,hash,json} from './store.ts';
import {Reviewer} from './automatic.ts';
import {SemanticIntake,expireSemanticIntakes} from './supplement.ts';
import {AgentEvidenceTools,runAgent,agentPromptVersion,ticketValidatorVersion,type AgentAdapter,type AgentLimits} from './agent.ts';
import {H,type Request} from './reviewer.ts';
import type {ModelSpend} from './model-spend.ts';

/** Reviewer-only jobs. No authorizer credential, wallet, or execution capability enters the adapter. */
export class ModelJobs {
 private intake:SemanticIntake;private profile:string;
 private limits:Required<AgentLimits>;
 constructor(private store:Store,private reviewer:Reviewer,private model:string,private adapter:(runId:string)=>AgentAdapter,limits:AgentLimits={}){
  this.limits={maxCalls:16,maxToolCalls:16,maxTokens:100000,timeoutMs:120000,...limits};
  if(Object.keys(limits).some(k=>!['maxCalls','maxToolCalls','maxTokens','timeoutMs'].includes(k))||Object.values(this.limits).some(v=>!Number.isSafeInteger(v)||v<1)||this.limits.maxCalls>20||this.limits.maxToolCalls>32||this.limits.maxTokens>100000||this.limits.timeoutMs>120000)throw Error('AGENT_LIMITS');
  this.intake=new SemanticIntake(store,reviewer);
  if(H(model)!==reviewer.originals.trust.modelVersion)throw Error('MODEL_GRANT_VERSION_MISMATCH');
  this.profile=hash({scope:store.getMeta('scope'),trust:reviewer.originals.trust,model,prompt:agentPromptVersion,ticketValidatorVersion,tools:'scoped-readonly-v1',limits:this.limits});
  store.db.exec(`CREATE TABLE IF NOT EXISTS model_jobs(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,profile TEXT NOT NULL,state TEXT NOT NULL,request_hash TEXT,report TEXT,assessment TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
 }
 get(id:string){const row=this.store.get('SELECT * FROM model_jobs WHERE id=?',id);if(!row)throw Error('MODEL_JOB_NOT_FOUND');return {...row,report:row.report?JSON.parse(row.report):null,assessment:row.assessment?JSON.parse(row.assessment):null};}
 costSnapshot(tenant:string,ledger:ModelSpend){
  if(ledger.config.scope!==this.store.getMeta('scope')||ledger.config.price.model!==this.model)throw Error('MODEL_COST_SCOPE_OR_VERSION');
  const jobs=this.store.all('SELECT id,state FROM model_jobs WHERE tenant=?',tenant);
  return {scope:this.store.getMeta('scope'),tenant,jobs:jobs.length,coverage:'model calls linked to this tenant durable jobs; excludes unassigned runs',...ledger.snapshot(jobs.map(r=>r.id))};
 }
 async enqueue(request:Request){
  for(const row of this.store.all('SELECT id,payload FROM semantic_intake')){
   const s=JSON.parse(row.payload);
   if((hash(s.request)===hash(request)||(s.history??[]).some((h:any)=>hash(h.request)===hash(request)))&&this.store.get('SELECT id FROM model_jobs WHERE id=?',row.id))return this.get(row.id);
  }
  const state=await this.intake.run(request,null);
  this.store.tx(()=>{
   this.store.run('INSERT OR IGNORE INTO model_jobs VALUES(?,?,?,?,NULL,NULL,NULL,NULL,?,?)',state.id,this.store.get('SELECT tenant FROM semantic_intake WHERE id=?',state.id).tenant,this.profile,state.state==='manual'?'manual':'waiting',Date.now(),Date.now());
  });return this.get(state.id);
 }
 /** Called on service startup. Ambiguous in-flight model work is never reissued. */
 recover(){this.store.tx(()=>{
  for(const row of this.store.all("SELECT id FROM model_jobs WHERE state='running'"))this.manual(row.id,'MODEL_RUN_INTERRUPTED');
 });}
 private manual(id:string,reason:string){
  this.store.run("UPDATE model_jobs SET state='manual',error=?,updated_at=? WHERE id=?",reason,Date.now(),id);
  const row=this.store.get('SELECT payload FROM semantic_intake WHERE id=?',id);
  if(row){const s=JSON.parse(row.payload);s.state='manual';s.reasons=[...new Set([...(s.reasons??[]),reason])];this.store.run('UPDATE semantic_intake SET payload=? WHERE id=?',json(s),id);}
  this.store.audit('model-worker','model_job_manual',id+':'+reason);
 }
 async tick(){
  expireSemanticIntakes(this.store);
  for(const row of this.store.all("SELECT id FROM model_jobs WHERE state IN ('waiting','proposed') ORDER BY created_at,id"))await this.process(row.id);
 }
 private async process(id:string){
  let job=this.get(id),s=JSON.parse(this.store.get('SELECT payload FROM semantic_intake WHERE id=?',id).payload);
  if(!['waiting','proposed'].includes(job.state))return;
  if(job.profile!==this.profile){this.store.tx(()=>this.manual(id,'MODEL_PROFILE_CHANGED'));return;}
  if(s.state==='manual'){this.store.tx(()=>this.manual(id,'INTAKE_MANUAL'));return;}
  if(job.state==='waiting'){
   if(s.state!=='awaiting_proposal')return;
   const fingerprint=hash(s.request);
   const claimed=this.store.tx(()=>this.store.run("UPDATE model_jobs SET state='running',request_hash=?,updated_at=? WHERE id=? AND state='waiting'",fingerprint,Date.now(),id).changes);
   if(!claimed)return;
   try{
    const checked=await this.intake.run(s.request,null);if(checked.state!=='awaiting_proposal'){this.store.tx(()=>this.manual(id,'MODEL_PREFLIGHT_'+checked.state.toUpperCase()));return;}
    const request=s.request as Request,p=await this.reviewer.chain.policy(request.policyId),n=await this.reviewer.chain.read('getNotice',[request.noticeId]);
    const tools=new AgentEvidenceTools(this.reviewer.originals,{enterpriseId:p.quote.enterpriseId,policyId:request.policyId,deploymentId:this.reviewer.chain.deploymentId,runtimeDeployment:this.reviewer.originals.trust.runtimeDeployment,commitment:n.data.incidentCommitment,workflowHash:p.quote.workflowHash},request.refs);
    const adapter=this.adapter(id);if(adapter.modelVersion!==this.model)throw Error('MODEL_ADAPTER_VERSION_MISMATCH');
    const remaining=s.deadline-Date.now();if(remaining<1)throw Error('TECHNICAL_TIMEOUT');
    const report=await runAgent(adapter,tools,request.refs,{...this.limits,timeoutMs:Math.min(this.limits.timeoutMs,remaining)});
    this.store.tx(()=>{const latest=this.get(id);if(latest.state!=='running'||latest.request_hash!==fingerprint)return;
     this.store.run("UPDATE model_jobs SET state='proposed',report=?,updated_at=? WHERE id=?",json(report),Date.now(),id);
    });
   }catch(e){this.store.tx(()=>{if(this.get(id).state==='running')this.manual(id,/^[A-Z][A-Z0-9_]{0,79}$/.test((e as Error).message)?(e as Error).message:'MODEL_RUN_FAILED');});return;}
   job=this.get(id);if(job.state!=='proposed')return;
  }
  s=JSON.parse(this.store.get('SELECT payload FROM semantic_intake WHERE id=?',id).payload);
  if(hash(s.request)!==job.request_hash){this.store.tx(()=>this.manual(id,'MODEL_REQUEST_CHANGED'));return;}
  try{
   const result=await this.intake.run(s.request,job.report.proposal);
   this.store.tx(()=>{if(this.get(id).state!=='proposed')return;
    if(result.state!=='ready'){this.manual(id,'MODEL_REVIEW_'+result.state.toUpperCase());return;}
    this.store.run("UPDATE model_jobs SET state='ready',assessment=?,error=NULL,updated_at=? WHERE id=?",json(result.assessment),Date.now(),id);
    this.store.audit('model-worker','model_independent_review_ready',id);
   });
  }catch{
   // Retain the already persisted model result during RPC/signing outages; next tick revalidates it.
   this.store.run("UPDATE model_jobs SET error='INDEPENDENT_REVIEW_RETRY',updated_at=? WHERE id=? AND state='proposed'",Date.now(),id);
  }
 }
}
