import { randomUUID } from 'node:crypto';
import { exactObject, identifier, timestamp, requireIncident as need, type Actor, type AgentRun, type Workflow } from '../domain/incident-schema.ts';
import { canonicalize } from '../domain/evidence.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentIngest, byteDigest } from './incident-ingest.ts';
import type { TimelineEvent } from './incident-timeline.ts';

export type Approval = { approvalId:string; projectId:string; tenantId:string; runId:string; workflowId:string; actorId:string; role:'enterprise_admin'; kind:'execution'; decision:'approved'|'rejected'|'taken_over'; targetRevision:string; displayedPayloadRef:{importId:string;objectId:string}; actionDigest:string; scope:string[]; approvalPolicyVersion:string; createdAt:string; expiresAt:string|null; recordingMode:'observed'|'synthetic'; sourceTrust:string };
export class IncidentApproval {
  constructor(readonly store:IncidentStore){}
  create(actor:Actor,runId:string,raw:unknown,key:string){
    exactObject(raw,['projectId','decision','targetRevision','displayedPayloadRef','scope','expiresAt']);
    exactObject(raw.displayedPayloadRef,['importId','objectId']);
    need(identifier(raw.projectId)&&identifier(key)&&identifier(raw.displayedPayloadRef.importId)&&identifier(raw.displayedPayloadRef.objectId));
    need((typeof raw.decision === 'string' && ['approved','rejected','taken_over'].includes(raw.decision))&&typeof raw.targetRevision==='string'&&/^sha256:[0-9a-f]{64}$/.test(raw.targetRevision));
    need(Array.isArray(raw.scope)&&raw.scope.length>0&&raw.scope.length<=100&&raw.scope.every(identifier)&&new Set(raw.scope).size===raw.scope.length&&timestamp(raw.expiresAt));
    const project=raw.projectId,digest=byteDigest(canonicalize(JSON.stringify({runId,...raw})));
    return this.store.tx(()=>{
      this.store.authorize(actor,project,['enterprise_admin']);
      const run=this.store.get(actor,project,'run',runId) as AgentRun,w=this.store.get(actor,project,'workflow',run.workflowId) as Workflow;
      const old=this.store.db.prepare('SELECT payload_hash,record_id FROM requests WHERE tenant_id=? AND project_id=? AND actor_id=? AND operation=? AND key=?').get(actor.tenantId,project,actor.actorId,'execution_approval',key);
      if(old){need(old.payload_hash===digest,'IDEMPOTENCY_CONFLICT',409);return {approval:this.get(actor,project,String(old.record_id)),replayed:true};}
      const scope=raw.scope as string[];need(scope.every(s=>w.allowedActions.includes(s)),'APPROVAL_SCOPE_DENIED',403);
      const ref=raw.displayedPayloadRef as Approval['displayedPayloadRef'],ingest=new IncidentIngest(this.store),receipt=ingest.get(actor,project,ref.importId);
      need(receipt.runId===runId&&receipt.status==='accepted','APPROVAL_EVIDENCE_SCOPE',422);
      const original=ingest.usableOriginal(actor,project,ref.importId,ref.objectId);
      need(raw.targetRevision===`sha256:${original.descriptor.sha256}`,'REVISION_DIGEST_MISMATCH',422);
      const createdAt=new Date().toISOString();need(raw.expiresAt===null||String(raw.expiresAt)>createdAt,'APPROVAL_EXPIRED',422);
      const approval:Approval={approvalId:randomUUID(),tenantId:actor.tenantId,projectId:project,runId,workflowId:w.workflowId,actorId:actor.actorId,role:'enterprise_admin',kind:'execution',decision:raw.decision as Approval['decision'],targetRevision:raw.targetRevision as string,displayedPayloadRef:ref,scope,approvalPolicyVersion:w.approvalPolicyVersion,createdAt,expiresAt:raw.expiresAt as string|null,recordingMode:run.environment==='approved_redacted'?'observed':'synthetic',sourceTrust:original.descriptor.trust,actionDigest:byteDigest(canonicalize(JSON.stringify({runId,workflowId:w.workflowId,approvalPolicyVersion:w.approvalPolicyVersion,scope:[...scope].sort(),targetRevision:raw.targetRevision,displayedPayloadDigest:original.descriptor.sha256})))};
      this.store.db.prepare('INSERT INTO records(id,kind,tenant_id,project_id,payload) VALUES(?,?,?,?,?)').run(approval.approvalId,'execution_approval',actor.tenantId,project,JSON.stringify(approval));
      this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run(actor.tenantId,project,actor.actorId,'execution_approval',key,digest,approval.approvalId);
      this.store.audit(actor.actorId,'execution_approval',approval.approvalId);return {approval,replayed:false};
    });
  }
  get(actor:Actor,project:string,id:string):Approval{
    this.store.authorize(actor,project);need(identifier(id));const row=this.store.db.prepare("SELECT payload FROM records WHERE id=? AND kind='execution_approval' AND tenant_id=? AND project_id=?").get(id,actor.tenantId,project);need(row,'NOT_FOUND',404);return JSON.parse(String(row.payload));
  }
  check(actor:Actor,run:AgentRun,event:TimelineEvent){
    if(!event.approvalRef)return {status:'missing',reasons:['APPROVAL_NOT_COLLECTED']};
    let approval:Approval;try{approval=this.get(actor,run.projectId,event.approvalRef);}catch{return {status:'invalid',reasons:['APPROVAL_NOT_FOUND']};}
    const reasons:string[]=[];
    try{this.store.authorize({actorId:approval.actorId,tenantId:approval.tenantId},run.projectId,['enterprise_admin']);}catch{reasons.push('APPROVER_NO_LONGER_AUTHORIZED');}
    if(approval.runId!==run.runId)reasons.push('APPROVAL_RUN_MISMATCH');
    if(approval.decision!=='approved')reasons.push('APPROVAL_NOT_APPROVED');
    if(event.versionRefs.length!==1||event.versionRefs[0]!==approval.targetRevision)reasons.push('APPROVAL_REVISION_MISMATCH');
    if(event.actionDigest!==approval.actionDigest)reasons.push('APPROVAL_ACTION_MISMATCH');
    if(!approval.scope.includes(event.eventType))reasons.push('APPROVAL_SCOPE_MISMATCH');
    if(!event.occurredAt)reasons.push('EXECUTION_TIME_UNKNOWN');
    else if(event.occurredAt<approval.createdAt||(approval.expiresAt!==null&&event.occurredAt>=approval.expiresAt))reasons.push('APPROVAL_TIME_MISMATCH');
    if(event.warnings.some(w=>['CLOCK_CONFLICT','EVENT_ID_CONFLICT','DUPLICATE_EVENT','HAS_CORRECTION','CORRECTION_CYCLE'].includes(w)))reasons.push('EVENT_UNCERTAIN');
    try{const ingest=new IncidentIngest(this.store),receipt=ingest.get(actor,run.projectId,approval.displayedPayloadRef.importId);need(receipt.status==='accepted');const original=ingest.usableOriginal(actor,run.projectId,receipt.importId,approval.displayedPayloadRef.objectId);need(`sha256:${original.descriptor.sha256}`===approval.targetRevision);}catch{reasons.push('APPROVAL_ORIGINAL_UNAVAILABLE');}
    return {status:reasons.length?'invalid':approval.recordingMode==='synthetic'?'synthetic_binding_matched':'binding_matched',reasons,approval};
  }
}
