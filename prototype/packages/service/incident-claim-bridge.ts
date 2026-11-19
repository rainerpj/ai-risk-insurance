import { readFileSync } from 'node:fs';
import { keccak256,stringToHex,type Hex } from 'viem';
import { exactObject,identifier,requireIncident as need,type Actor,type Incident,type AgentRun } from '../domain/incident-schema.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentReport } from './incident-report.ts';
import { Store,hash,Fault } from './store.ts';
import { Chain,grantAbi } from './chain.ts';
import { attachBridgeGuard } from './incident-bridge-gate.ts';
const H=(s:string)=>keccak256(stringToHex(s));
export type BridgeTarget={tenantId:string;projectId:string;workflowId:string;policyId:Hex};
export class IncidentClaimBridge {
 constructor(readonly store:IncidentStore,readonly legacy:Store,readonly chain:Chain,readonly targets:BridgeTarget[]){attachBridgeGuard(legacy,async(b,stage,payload)=>{try{await this.guard(b,stage,payload);}catch(e:any){throw new Fault(e.statusCode??409,e.message);}});}
 private target(actor:Actor,project:string,policyId:string){const target=this.targets.find(t=>t.tenantId===actor.tenantId&&t.projectId===project&&t.policyId===policyId);need(target,'BRIDGE_POLICY_NOT_ALLOWLISTED',403);return target;}
 private async policy(actor:Actor,project:string,policyId:string){const target=this.target(actor,project,policyId);await this.chain.check();need(this.legacy.getMeta('scope')===`31337:${this.chain.core}:${this.chain.deploymentId}`,'BRIDGE_DEPLOYMENT_MISMATCH',409);const registry=await this.chain.read('grantRegistry');for(const channel of [1,2])for(const functionName of ['approvalEnabled','paymentEnabled'])need(!await this.chain.client.readContract({address:registry,abi:grantAbi,functionName,args:[channel]}),'BRIDGE_MANUAL_CHANNELS_REQUIRED',409);const p=await this.chain.policy(policyId),code=await this.chain.client.getCode({address:p.quote.token});const artifact=JSON.parse(readFileSync(new URL('../../artifacts/contracts/MockTokens.sol/MockUSDC.json',import.meta.url),'utf8'));
  let expected=artifact.deployedBytecode as string;const immutable=Object.values(artifact.immutableReferences) as {start:number;length:number}[][];need(immutable.length===1,'BRIDGE_MOCK_ARTIFACT_INVALID',409);for(const ref of immutable[0]!){need(ref.length===32,'BRIDGE_MOCK_ARTIFACT_INVALID',409);const offset=2+ref.start*2;expected=expected.slice(0,offset)+'6'.padStart(64,'0')+expected.slice(offset+64);}need(code&&keccak256(code)===keccak256(expected as Hex),'BRIDGE_MOCK_TOKEN_REQUIRED',409);return {target,p};
 }
 private coverage(actor:Actor,project:string,incidentId:string){return this.store.db.prepare("SELECT payload FROM records WHERE tenant_id=? AND project_id=? AND kind='coverage_reference' ORDER BY seq").all(actor.tenantId,project).map(r=>JSON.parse(String(r.payload))).filter(r=>r.incidentId===incidentId).at(-1);}
 private source(actor:Actor,project:string,incidentId:string,state:any,target:BridgeTarget,p:any,coverageVersion:number,reviewId:string){
  this.store.authorize(actor,project,['enterprise_admin']);need(state.status==='reviewed'&&state.report.incidentId===incidentId&&state.review.reviewId===reviewId,'BRIDGE_REPORT_NOT_CURRENT',409);
  const incident=this.store.get(actor,project,'incident',incidentId) as Incident;need(incident.workflowId===target.workflowId,'BRIDGE_WORKFLOW_MISMATCH',422);for(const runId of incident.runIds){const run=this.store.get(actor,project,'run',runId) as AgentRun;need(run.environment==='synthetic','BRIDGE_SYNTHETIC_ONLY',422);}
  const coverage=this.coverage(actor,project,incidentId),c=coverage?.coverage;need(coverage?.version===coverageVersion&&c?.mode==='local_test','BRIDGE_LOCAL_TEST_REQUIRED',422);
  need(c.policyRef===target.policyId&&c.termsVersion===p.quote.termsHash&&c.currency==='USDC'&&c.scale===6&&c.deductible==='0'&&c.share?.numerator==='1'&&c.share?.denominator==='1'&&c.incidentLimit===String(p.quote.incidentLimit)&&c.annualLimit===String(p.quote.annualLimit)&&c.exclusionsRef===null,'BRIDGE_TERMS_MISMATCH',422);
  const snapshot=state.report.snapshot;need(snapshot.gaps.length===0&&snapshot.catalogue.some((d:any)=>d.id.startsWith('original:'))&&snapshot.catalogue.filter((d:any)=>d.id.startsWith('original:')).every((d:any)=>d.trust==='synthetic'),'BRIDGE_EVIDENCE_INCOMPLETE',422);
  const rows=snapshot.expenseSnapshot.rows;need(rows.length>0&&rows.every((r:any)=>r.synthetic&&r.countedNet!==null&&r.legacyCategory!==null&&r.line.currency==='USDC'&&r.line.scale===6&&r.issues.every((v:string)=>v==='DUPLICATE_VOUCHER_EXCLUDED')),'BRIDGE_EXPENSE_UNVERIFIED',422);
  const expenses=['restore','mitigate'].map(category=>({gross:rows.filter((r:any)=>r.legacyCategory===category).reduce((n:bigint,r:any)=>n+BigInt(r.countedNet),0n).toString(),duplicate:'0',compensation:'0',recovery:'0'}));const net=expenses.reduce((n,r)=>n+BigInt(r.gross),0n);need(net>0n&&net<2n**256n,'BRIDGE_AMOUNT_INVALID',422);
  return {coverage,expenses,net,approvedAmount:[net,p.quote.incidentLimit,p.quote.annualLimit].reduce((a,b)=>a<b?a:b).toString()};
 }
 async create(actor:Actor,incidentId:string,raw:unknown,key:string){exactObject(raw,['projectId','reportId','reviewId','coverageVersion','policyId','declaredIncidentAt','confirmSynthetic']);need(identifier(raw.projectId)&&identifier(raw.reportId)&&identifier(raw.reviewId)&&typeof raw.policyId==='string'&&/^0x[0-9a-f]{64}$/.test(raw.policyId)&&Number.isSafeInteger(raw.coverageVersion)&&typeof raw.declaredIncidentAt==='string'&&/^[1-9]\d{0,19}$/.test(raw.declaredIncidentAt)&&raw.confirmSynthetic===true&&identifier(key));const project=raw.projectId;this.store.authorize(actor,project,['enterprise_admin']);
  const {target,p}=await this.policy(actor,project,raw.policyId);const time=BigInt(raw.declaredIncidentAt);need(time>=p.quote.startAt&&time<p.quote.endAt&&time<2n**64n,'BRIDGE_TIME_OUTSIDE_POLICY',422);const reserved=this.legacy.getMeta('incident-bridge:'+raw.policyId);if(reserved){const existing=JSON.parse(reserved);need(existing.tenantId===actor.tenantId&&existing.projectId===project&&existing.incidentId===incidentId,'BRIDGE_POLICY_RESERVED',409);}const requestHash=hash({incidentId,...raw}),bridgeId=hash({tenant:actor.tenantId,project,incidentId});
  new IncidentReport(this.store).get(actor,project,raw.reportId as string);const record=new IncidentReport(this.store).withCurrent(actor,project,raw.reportId as string,state=>{
   const source=this.source(actor,project,incidentId,state,target,p,Number(raw.coverageVersion),raw.reviewId as string);const previousKey=this.store.db.prepare("SELECT payload_hash FROM requests WHERE tenant_id=? AND project_id=? AND actor_id=? AND operation='claim_bridge' AND key=?").get(actor.tenantId,project,actor.actorId,key);if(previousKey)need(previousKey.payload_hash===requestHash,'IDEMPOTENCY_CONFLICT',409);
   const prior=this.store.db.prepare("SELECT payload FROM records WHERE id=? AND kind='claim_bridge'").get(bridgeId);let result:any;if(prior){result=JSON.parse(String(prior.payload));need(result.requestHash===requestHash,'BRIDGE_MAPPING_CONFLICT',409);}else{
    need(p.paidTotal===0n&&p.dueTotal===0n,'BRIDGE_POLICY_ALREADY_USED',409);const binding={bridgeId,tenantId:actor.tenantId,projectId:project,incidentId,actorId:actor.actorId,workflowId:target.workflowId,deploymentId:this.chain.deploymentId,core:this.chain.core,policyId:target.policyId,chainIncidentId:H(`N11:incident:${this.chain.deploymentId}:${bridgeId}`),noticeId:H(`N11:notice:${this.chain.deploymentId}:${bridgeId}`),reportId:state.report.reportId,reportVersion:state.report.version,reviewId:state.review!.reviewId,manifestDigest:state.report.evidenceManifestDigest,coverageVersion:source.coverage.version,coverageHash:hash(source.coverage),expenses:source.expenses,net:source.net.toString(),approvedAmount:source.approvedAmount,declaredIncidentAt:raw.declaredIncidentAt,legacyTenant:p.quote.enterpriseId,insured:p.quote.insured,beneficiary:p.quote.beneficiary,token:p.quote.token};
    const bindingHash=hash(binding);result={...binding,bindingHash,reason:`N11 local synthetic report binding ${bindingHash}`,requestHash,createdAt:new Date().toISOString()};
    this.store.db.prepare('INSERT INTO records(id,kind,tenant_id,project_id,payload) VALUES(?,?,?,?,?)').run(bridgeId,'claim_bridge',actor.tenantId,project,JSON.stringify(result));this.store.audit(actor.actorId,'create_claim_bridge',bridgeId);
   }
   if(!previousKey)this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run(actor.tenantId,project,actor.actorId,'claim_bridge',key,requestHash,bridgeId);return result;
  });
  this.legacy.tx(()=>{const lockKey=`incident-bridge:${record.policyId}`,prior=this.legacy.getMeta(lockKey);need(!prior||JSON.parse(prior).bindingHash===record.bindingHash,'BRIDGE_POLICY_RESERVED',409);this.legacy.meta(lockKey,JSON.stringify(record));this.legacy.audit(actor.actorId,'install_incident_bridge',bridgeId);});return this.present(record);
 }
 private present(b:any){return {mapping:b,noticePayload:{noticeId:b.noticeId,policyId:b.policyId,incidentCommitment:b.chainIncidentId,evidenceHash:`0x${b.bindingHash}`,declaredIncidentAt:b.declaredIncidentAt,claimedAmount:b.net,summary:b.reason},draftInput:{policyId:b.policyId,incidentId:b.chainIncidentId,noticeIds:[b.noticeId],expenses:b.expenses,reason:b.reason},transactions:this.legacy.all('SELECT id,action,state,tx_hash,error FROM outbox WHERE tenant=?',b.legacyTenant).filter(r=>{const row=this.legacy.get('SELECT payload FROM outbox WHERE id=?',r.id);return JSON.parse(row.payload)[0]?.incidentId===b.chainIncidentId||r.id===b.noticeId;}),installed:JSON.parse(this.legacy.getMeta('incident-bridge:'+b.policyId)??'null')?.bindingHash===b.bindingHash,haltReason:this.legacy.getMeta('incident-bridge-halted:'+b.bridgeId)??null,limitations:['Local MockUSDC and manual dual-role path only; no automatic adjudication.','Once raw bytes have escaped, off-chain invalidation cannot recall a signed or mined transaction. Unknown broadcasts retain the same bytes and hash; never generate a replacement.']};}
 get(actor:Actor,project:string,incidentId:string){this.store.get(actor,project,'incident',incidentId);const row=this.store.db.prepare("SELECT payload FROM records WHERE tenant_id=? AND project_id=? AND kind='claim_bridge'").all(actor.tenantId,project).map(r=>JSON.parse(String(r.payload))).find(r=>r.incidentId===incidentId);need(row,'NOT_FOUND',404);this.store.audit(actor.actorId,'read_claim_bridge',row.bridgeId);const state=new IncidentReport(this.store).get(actor,project,row.reportId);return {...this.present(row),current:state.status==='reviewed'&&state.review?.reviewId===row.reviewId};}
 private async guard(b:any,stage:string,payload:any){
  const actor={actorId:b.actorId,tenantId:b.tenantId},row=this.store.db.prepare("SELECT payload FROM records WHERE id=? AND kind='claim_bridge'").get(b.bridgeId);need(row&&hash(JSON.parse(String(row.payload)))===hash(b),'BRIDGE_BINDING_MISMATCH',409);
  need(!this.legacy.getMeta('incident-bridge-halted:'+b.bridgeId),'BRIDGE_HALTED',409);
  const {target,p}=await this.policy(actor,b.projectId,b.policyId);
  try{
   // Persist detected report invalidation even when the subsequent guarded operation rejects.
   new IncidentReport(this.store).get(actor,b.projectId,b.reportId);
   new IncidentReport(this.store).withCurrent(actor,b.projectId,b.reportId,state=>{const source=this.source(actor,b.projectId,b.incidentId,state,target,p,b.coverageVersion,b.reviewId);need(hash(source.coverage)===b.coverageHash&&hash(source.expenses)===hash(b.expenses)&&state.report.evidenceManifestDigest===b.manifestDigest,'BRIDGE_BINDING_MISMATCH',409);});
  }catch(e:any){
   this.legacy.tx(()=>{this.legacy.meta('incident-bridge-halted:'+b.bridgeId,String(e.message));this.legacy.audit(b.actorId,'halt_incident_bridge',b.bridgeId);});throw e;
  }
  if(stage==='raw-sign')throw new Fault(409,'BRIDGE_USE_MANUAL_DRAFT');
  if(stage==='action'){if(payload.action==='submitNotice'){stage='notice';payload=payload.args[0];}else if(payload.action==='registerDecision'){stage='draft';payload={d:payload.args[0],expenses:payload.args[1],noticeIds:payload.args[2]};}else if(payload.action==='executePayment'){stage='payment';payload=payload.args[0];}else throw new Fault(409,'BRIDGE_MANUAL_RECONCILIATION_REQUIRED');}
  if(stage==='notice'||stage==='intake'){if(stage==='intake')need(payload.claimedAmount===b.net&&payload.summary===b.reason,'BRIDGE_NOTICE_MISMATCH',409);need(payload.policyId===b.policyId&&payload.noticeId===b.noticeId&&payload.incidentCommitment===b.chainIncidentId&&payload.evidenceHash===`0x${b.bindingHash}`&&String(payload.declaredIncidentAt)===b.declaredIncidentAt,'BRIDGE_NOTICE_MISMATCH',409);return;}
  if(stage==='draft'){const d=payload.d;need(d.policyId===b.policyId&&d.incidentId===b.chainIncidentId&&String(d.channel)==='0'&&String(d.version)==='1'&&String(d.previousVersion)==='0'&&String(d.netApproved)===b.approvedAmount&&d.reasonHash===H(b.reason)&&hash(payload.expenses)===hash(b.expenses)&&hash(payload.noticeIds)===hash([b.noticeId]),'BRIDGE_DRAFT_MISMATCH',409);return;}
  if(stage==='payment'){need(payload.policyId===b.policyId&&payload.incidentId===b.chainIncidentId&&String(payload.decisionVersion)==='1'&&payload.token.toLowerCase()===b.token.toLowerCase()&&payload.beneficiary.toLowerCase()===b.beneficiary.toLowerCase()&&BigInt(payload.amount)>0n&&BigInt(payload.amount)<=BigInt(b.approvedAmount),'BRIDGE_PAYMENT_MISMATCH',409);return;}
  throw new Fault(409,'BRIDGE_STAGE_DENIED');
 }
}









