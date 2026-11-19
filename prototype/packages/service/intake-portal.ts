import {Store,hash,json} from './store.ts';
import {Reviewer} from './automatic.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {assertLocal} from '../domain/local.ts';
import {H} from './reviewer.ts';
import {SemanticIntake,expireSemanticIntakes} from './supplement.ts';
export type IntakePortal={routing?:(tenant:string)=>Promise<any>;costs?:(tenant:string)=>Promise<any>;status:(tenant:string)=>Promise<any>;import:(tenant:string,body:unknown)=>Promise<any>;submit:(tenant:string,body:unknown)=>Promise<any>};
export function remoteIntakePortal(baseUrl:string,tokens:Record<string,string>,scope:string):IntakePortal{
 assertLocal(baseUrl);
 if(Object.entries(tokens).some(([tenant,token])=>!/^0x[a-f0-9]{64}$/.test(tenant)||token.length<32)||new Set(Object.values(tokens)).size!==Object.keys(tokens).length)throw Error('PORTAL_CAPABILITY_CONFIG');
 const call=async(tenant:string,path:string,body?:unknown)=>{
  const token=tokens[tenant];if(!token)throw Error('PORTAL_NOT_CONFIGURED');
  const response=await fetch(new URL('/portal/'+tenant+'/'+path,baseUrl),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!response.ok)throw Error('PORTAL_REQUEST_FAILED');const data:any=await response.json();
  if(data.scope!==scope||data.tenant!==tenant)throw Error('PORTAL_SCOPE_MISMATCH');return data;
 };
 return {routing:tenant=>call(tenant,'routing'),costs:tenant=>call(tenant,'model-costs'),status:tenant=>call(tenant,'intakes'),import:(tenant,body)=>call(tenant,'originals',body),submit:(tenant,body)=>call(tenant,'supplement',body)};
}
/** Enterprise supplies evidence only. Proposal, Grant and deadline remain service-owned. */
export async function submitSupplement(store:Store,worker:Reviewer,intake:SemanticIntake,tenant:string,body:any){
 if(!body||Object.keys(body).sort().join()!=='caseId,noticeId,refs'||![body.caseId,body.noticeId].every(v=>/^0x[a-f0-9]{64}$/.test(v))||!Array.isArray(body.refs)||body.refs.length>11||new Set(body.refs).size!==body.refs.length||body.refs.some((r:any)=>typeof r!=='string'||!/^[a-f0-9]{64}$/.test(r)))throw Error('SUPPLEMENT_SUBMISSION_SCHEMA');
 store.db.exec('CREATE TABLE IF NOT EXISTS portal_submissions(case_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,input_hash TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL)');
 const inputHash=hash(body),row=store.get('SELECT * FROM semantic_intake WHERE id=? AND tenant=?',body.caseId,tenant);if(!row)throw Error('CASE_NOT_FOUND');
 const saved=store.get('SELECT * FROM portal_submissions WHERE case_id=?',body.caseId);let request:any;
 if(saved){if(saved.tenant!==tenant||saved.input_hash!==inputHash)throw Error('SUPPLEMENT_SUBMISSION_CONFLICT');request=JSON.parse(saved.request);if(saved.state==='complete')return intakeStatus(store,tenant);}
 else{
  const s=JSON.parse(row.payload);if(s.state!=='awaiting_evidence'||s.supplementUsed)throw Error('NO_SUPPLEMENT_REQUEST');
  const n=await worker.chain.read('getNotice',[body.noticeId]),old=await worker.chain.read('getNotice',[s.request.noticeId]);
  if(n.digest===zeroHash||n.data.policyId!==s.request.policyId||n.data.incidentCommitment!==old.data.incidentCommitment||n.data.declaredIncidentAt!==old.data.declaredIncidentAt||H(body.refs)!==n.data.evidenceHash)throw Error('NOTICE_EVIDENCE_BINDING');
  if(s.request.refs.some((r:string)=>!s.missing.includes(r)&&!body.refs.includes(r)))throw Error('SUPPLEMENT_MUST_RETAIN_AVAILABLE_ORIGINALS');
  const same=body.noticeId===s.request.noticeId;
  if(same&&hash(body.refs)!==hash(s.request.refs))throw Error('NOTICE_EVIDENCE_BINDING');
  request={...s.request,noticeId:body.noticeId,refs:body.refs,...(same?{}:{previousEvidence:{noticeId:s.request.noticeId,refs:s.request.refs}})};
  store.tx(()=>{
   const existing=store.get('SELECT * FROM portal_submissions WHERE case_id=?',body.caseId);
   if(existing){if(existing.input_hash!==inputHash)throw Error('SUPPLEMENT_SUBMISSION_CONFLICT');return;}
   const current=store.get('SELECT payload FROM semantic_intake WHERE id=? AND tenant=?',body.caseId,tenant);
   if(current.payload!==row.payload)throw Error('INTAKE_VERSION_CHANGED');
   store.run("INSERT INTO portal_submissions VALUES(?,?,?,?,'pending')",body.caseId,tenant,inputHash,json(request));
  });
 }
 const current=JSON.parse(store.get('SELECT payload FROM semantic_intake WHERE id=? AND tenant=?',body.caseId,tenant).payload);
 if(!(current.supplementUsed&&hash(current.request)===hash(request)&&['manual','ready','awaiting_proposal'].includes(current.state)))await intake.run(request,null,true);
 store.tx(()=>{store.run("UPDATE portal_submissions SET state='complete' WHERE case_id=?",body.caseId);store.audit(tenant,'supplement_submitted',body.caseId);});
 return intakeStatus(store,tenant);
}

/** Tenant portal projection. No original contents, model proposals, signatures or executor jobs. */
export function intakeStatus(store:Store,tenant:string){
 expireSemanticIntakes(store);
 return {scope:store.getMeta('scope'),tenant,cases:store.all('SELECT payload FROM semantic_intake WHERE tenant=? ORDER BY rowid DESC',tenant).map(row=>{
  const s=JSON.parse(row.payload);
  return {id:s.id,policyId:s.request.policyId,noticeId:s.request.noticeId,state:s.state,startedAt:s.startedAt,deadline:s.deadline,supplementUsed:s.supplementUsed,missing:s.missing,missingKinds:s.missingKinds??[],reasons:s.reasons,acceptedSource:s.acceptedSource??null,previousNoticeId:s.request.previousEvidence?.noticeId??null};
 })};
}
export async function importOriginal(worker:Reviewer,tenant:string,body:any){
 if(!body||Object.keys(body).sort().join()!=='document,noticeId'||!/^0x[a-f0-9]{64}$/.test(body.noticeId)||typeof body.document!=='string')throw Error('ORIGINAL_IMPORT_SCHEMA');
 const chain=worker.chain;await chain.check();const notice=await chain.read('getNotice',[body.noticeId]);
 if(notice.digest===zeroHash)throw Error('NOTICE_NOT_FOUND');
 const policy=await chain.policy(notice.data.policyId),q=policy.quote;
 if(!policy.issuedAt||q.enterpriseId!==tenant)throw Error('TENANT_SCOPE_DENIED');
 return worker.originals.import(body.document,{enterpriseId:tenant,policyId:notice.data.policyId,deploymentId:chain.deploymentId,runtimeDeployment:worker.originals.trust.runtimeDeployment,commitment:notice.data.incidentCommitment,workflowHash:q.workflowHash});
}
