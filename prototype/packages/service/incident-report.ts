import { randomUUID } from 'node:crypto';
import { canonicalize } from '../domain/evidence.ts';
import { exactObject,identifier,text,requireIncident as need,type Actor } from '../domain/incident-schema.ts';
import { byteDigest } from './incident-ingest.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentInvestigation } from './incident-investigation.ts';
import { buildRedactedBundle,verifyRedactedBundle } from './incident-report-export.ts';
const hash=(v:unknown)=>byteDigest(canonicalize(JSON.stringify(v)));
export type ReportVersion={reportId:string;incidentId:string;projectId:string;tenantId:string;version:number;authorId:string;contributors:string[];investigationId:string;evidenceManifestDigest:string;createdAt:string;snapshot:any};
type Review={reviewId:string;reportId:string;reportVersion:number;actorId:string;decision:'accepted'|'changes_requested';reason:string;manifestDigest:string;createdAt:string;previousReviewId:string|null};
export class IncidentReport {
 constructor(readonly store:IncidentStore){}
 private rows(actor:Actor,project:string,kind:string){this.store.authorize(actor,project);return this.store.db.prepare('SELECT payload FROM records WHERE tenant_id=? AND project_id=? AND kind=? ORDER BY seq').all(actor.tenantId,project,kind).map(r=>JSON.parse(String(r.payload)));}
 private record(actor:Actor,project:string,kind:string,id:string){this.store.authorize(actor,project);need(identifier(id));const row=this.store.db.prepare('SELECT payload FROM records WHERE tenant_id=? AND project_id=? AND kind=? AND id=?').get(actor.tenantId,project,kind,id);need(row,'NOT_FOUND',404);return JSON.parse(String(row.payload));}
 private save(actor:Actor,project:string,kind:string,id:string,value:unknown){this.store.db.prepare('INSERT INTO records(id,kind,tenant_id,project_id,payload) VALUES(?,?,?,?,?)').run(id,kind,actor.tenantId,project,JSON.stringify(value));this.store.audit(actor.actorId,kind,id);}
 private replay(actor:Actor,project:string,op:string,key:string,input:unknown){need(identifier(key),'IDEMPOTENCY_KEY_REQUIRED');const digest=hash(input),row=this.store.db.prepare('SELECT payload_hash,record_id FROM requests WHERE tenant_id=? AND project_id=? AND actor_id=? AND operation=? AND key=?').get(actor.tenantId,project,actor.actorId,op,key);if(row)need(row.payload_hash===digest,'IDEMPOTENCY_CONFLICT',409);return {digest,id:row?String(row.record_id):null};}
 private saveKey(actor:Actor,project:string,op:string,key:string,digest:string,id:string){this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run(actor.tenantId,project,actor.actorId,op,key,digest,id);}
 private latest(actor:Actor,project:string,incidentId:string):ReportVersion|undefined{return this.rows(actor,project,'report_version').filter(r=>r.incidentId===incidentId).at(-1);}
 private state(actor:Actor,project:string,id:string){
  const report=this.record(actor,project,'report_version',id) as ReportVersion,reviewHistory=this.rows(actor,project,'report_review').filter(r=>r.reportId===id) as Review[],review=reviewHistory.at(-1);
  let invalidation=this.rows(actor,project,'report_invalidation').find(r=>r.reportId===id);
  let reason:string|null=null;
  if(this.latest(actor,project,report.incidentId)?.reportId!==id)reason='SUPERSEDED_REPORT';
  else if(!new IncidentInvestigation(this.store).get(actor,project,report.investigationId).current)reason='EVIDENCE_CHANGED';
  else if(review){try{this.store.authorize({actorId:review.actorId,tenantId:actor.tenantId},project,['reviewer']);}catch{reason='REVIEWER_REVOKED';}}
  if(reason&&!invalidation){invalidation={invalidationId:randomUUID(),reportId:id,reason,detectedAt:new Date().toISOString()};this.save(actor,project,'report_invalidation',invalidation.invalidationId,invalidation);}
  return {report,review:review??null,reviewHistory,invalidation:invalidation??null,status:invalidation?'invalidated':review?.decision==='accepted'?'reviewed':review?'changes_requested':'pending_review'};
 }
 get(actor:Actor,project:string,id:string){return this.withCurrent(actor,project,id,state=>state);}
 withCurrent<T>(actor:Actor,project:string,id:string,consume:(state:ReturnType<IncidentReport['state']>)=>T){return this.store.tx(()=>{const state=this.state(actor,project,id);this.store.audit(actor.actorId,'read_report',id);return consume(state);});}
 list(actor:Actor,project:string,incidentId:string){return this.store.tx(()=>{this.store.get(actor,project,'incident',incidentId);return this.rows(actor,project,'report_version').filter(r=>r.incidentId===incidentId).map(r=>{const state=this.state(actor,project,r.reportId);return {reportId:r.reportId,version:r.version,status:state.status,authorId:r.authorId,investigationId:r.investigationId};});});}
 publish(actor:Actor,incidentId:string,raw:unknown,key:string){
  exactObject(raw,['projectId','investigationId','expectedVersion']);need(identifier(raw.projectId)&&identifier(raw.investigationId)&&Number.isSafeInteger(raw.expectedVersion)&&Number(raw.expectedVersion)>=0);
  const project=raw.projectId;return this.store.tx(()=>{
   this.store.authorize(actor,project,['enterprise_admin','investigator']);this.store.get(actor,project,'incident',incidentId);const request=this.replay(actor,project,'report_version',key,{incidentId,...raw});
   if(request.id)return {...this.state(actor,project,request.id),replayed:true};
   const previous=this.latest(actor,project,incidentId);need((previous?.version??0)===raw.expectedVersion,'REPORT_VERSION_CONFLICT',409);
   const snapshot=new IncidentInvestigation(this.store).get(actor,project,raw.investigationId as string);need(snapshot.incidentId===incidentId,'INVESTIGATION_SCOPE_MISMATCH',422);need(snapshot.status==='draft'&&snapshot.current,'DRAFT_NOT_CURRENT',409);
   const contributors=[...new Set<string>([actor.actorId,snapshot.actorId,...(snapshot.expenseSnapshot?.history??[]).map((r:any)=>r.actorId)])];
   const report:ReportVersion={reportId:randomUUID(),tenantId:actor.tenantId,projectId:project,incidentId,version:(previous?.version??0)+1,authorId:actor.actorId,contributors,investigationId:raw.investigationId as string,evidenceManifestDigest:snapshot.evidenceManifestDigest,createdAt:new Date().toISOString(),snapshot};
   this.save(actor,project,'report_version',report.reportId,report);this.saveKey(actor,project,'report_version',key,request.digest,report.reportId);if(previous)this.state(actor,project,previous.reportId);
   return {...this.state(actor,project,report.reportId),replayed:false};
  });
 }
 review(actor:Actor,id:string,raw:unknown,key:string){
  exactObject(raw,['projectId','expectedVersion','manifestDigest','expectedReviewId','decision','reason']);need(identifier(raw.projectId)&&Number.isSafeInteger(raw.expectedVersion)&&typeof raw.manifestDigest==='string'&&/^[0-9a-f]{64}$/.test(raw.manifestDigest)&&(raw.expectedReviewId===null||identifier(raw.expectedReviewId))&&(typeof raw.decision === 'string' && ['accepted','changes_requested'].includes(raw.decision))&&text(raw.reason));
  const project=raw.projectId;this.store.authorize(actor,project,['reviewer']);this.get(actor,project,id);return this.store.tx(()=>{
   this.store.authorize(actor,project,['reviewer']);const request=this.replay(actor,project,'report_review',key,{id,...raw}),state=this.state(actor,project,id);
   need(!state.report.contributors.includes(actor.actorId),'SELF_REVIEW_DENIED',403);
   need(state.status!=='invalidated'&&state.report.version===raw.expectedVersion&&state.report.evidenceManifestDigest===raw.manifestDigest,'REPORT_NOT_CURRENT',409);
   if(request.id)return {review:this.record(actor,project,'report_review',request.id),state,replayed:true};
   need((state.review?.reviewId??null)===raw.expectedReviewId,'REVIEW_VERSION_CONFLICT',409);
   const review:Review={reviewId:randomUUID(),reportId:id,reportVersion:state.report.version,actorId:actor.actorId,decision:raw.decision as Review['decision'],reason:raw.reason as string,manifestDigest:state.report.evidenceManifestDigest,createdAt:new Date().toISOString(),previousReviewId:state.review?.reviewId??null};
   this.save(actor,project,'report_review',review.reviewId,review);this.saveKey(actor,project,'report_review',key,request.digest,review.reviewId);return {review,state:this.state(actor,project,id),replayed:false};
  });
 }
 export(actor:Actor,id:string,raw:unknown,key:string){
  exactObject(raw,['projectId','expectedVersion','reviewId','audienceActorId','profile']);need(identifier(raw.projectId)&&identifier(raw.reviewId)&&identifier(raw.audienceActorId)&&raw.profile==='redacted_metadata_v1'&&Number.isSafeInteger(raw.expectedVersion));
  const project=raw.projectId;this.store.authorize(actor,project,['enterprise_admin']);this.get(actor,project,id);return this.store.tx(()=>{
   this.store.authorize(actor,project,['enterprise_admin']);this.store.authorize({actorId:raw.audienceActorId as string,tenantId:actor.tenantId},project);
   const state=this.state(actor,project,id);need(state.status==='reviewed'&&state.report.version===raw.expectedVersion&&state.review?.reviewId===raw.reviewId,'REVIEW_NOT_CURRENT',409);
   const request=this.replay(actor,project,'report_export',key,{id,...raw});if(request.id){const receipt=this.record(actor,project,'report_export',request.id);return {exportId:receipt.exportId,expiresAt:receipt.expiresAt,replayed:true};}
   const exportId=randomUUID(),createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+10*60*1000).toISOString();
   const bundle=buildRedactedBundle(state.report,state.review!,exportId,createdAt);
   const receipt={exportId,reportId:id,reviewId:state.review!.reviewId,creatorId:actor.actorId,audienceActorId:raw.audienceActorId,profile:raw.profile,createdAt,expiresAt,bundle};
   this.save(actor,project,'report_export',exportId,receipt);this.saveKey(actor,project,'report_export',key,request.digest,exportId);return {exportId,expiresAt,replayed:false};
  });
 }
 download<T=any>(actor:Actor,project:string,id:string,consume:(bundle:any)=>T=(bundle=>bundle)){const access=this.record(actor,project,'report_export',id);need(actor.actorId===access.creatorId||actor.actorId===access.audienceActorId,'EXPORT_AUDIENCE_DENIED',403);this.get(actor,project,access.reportId);return this.store.tx(()=>{
  const receipt=this.record(actor,project,'report_export',id);need(actor.actorId===receipt.creatorId||actor.actorId===receipt.audienceActorId,'EXPORT_AUDIENCE_DENIED',403);
  this.store.authorize({actorId:receipt.creatorId,tenantId:actor.tenantId},project,['enterprise_admin']);this.store.authorize({actorId:receipt.audienceActorId,tenantId:actor.tenantId},project);
  need(receipt.expiresAt>new Date().toISOString(),'EXPORT_EXPIRED',410);need(!this.rows(actor,project,'report_export_revocation').some(r=>r.exportId===id),'EXPORT_REVOKED',410);
  const state=this.state(actor,project,receipt.reportId);need(state.status==='reviewed'&&state.review?.reviewId===receipt.reviewId,'REVIEW_NOT_CURRENT',409);
  verifyRedactedBundle(receipt.bundle);this.store.audit(actor.actorId,'download_report_export',id);return consume(receipt.bundle);
 });}
 revoke(actor:Actor,id:string,raw:unknown){exactObject(raw,['projectId','reason']);need(identifier(raw.projectId)&&text(raw.reason));return this.store.tx(()=>{this.store.authorize(actor,raw.projectId as string,['enterprise_admin']);this.record(actor,raw.projectId as string,'report_export',id);const old=this.rows(actor,raw.projectId as string,'report_export_revocation').find(r=>r.exportId===id);if(old){need(old.reason===raw.reason,'REVOCATION_CONFLICT',409);return old;}const record={revocationId:randomUUID(),exportId:id,actorId:actor.actorId,reason:raw.reason,createdAt:new Date().toISOString()};this.save(actor,raw.projectId as string,'report_export_revocation',record.revocationId,record);return record;});}
}


