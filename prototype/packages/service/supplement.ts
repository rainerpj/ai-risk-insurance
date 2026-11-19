import {Reviewer} from './automatic.ts';
import {Store,hash,json} from './store.ts';
import {H,type Request} from './reviewer.ts';
import {AgentEvidenceTools,parseAgentProposal,verifyAgentItems,ticketFacts,type AgentProposal} from './agent.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {semanticScope} from './semantic-review.ts';

/** Deadline enforcement must not depend on another enterprise submission. No signing or fund action. */
export function expireSemanticIntakes(store:Store,now=Date.now()){
 if(!Number.isSafeInteger(now)||now<0)throw Error('INVALID_CLOCK');
 return store.tx(()=>{
  let expired=0;
  for(const row of store.all('SELECT id,payload FROM semantic_intake')){
   const s=JSON.parse(row.payload);
   if(!['checking','awaiting_evidence','awaiting_proposal'].includes(s.state)||now<s.deadline)continue;
   s.state='manual';s.reasons=[...new Set([...(s.reasons??[]),'TECHNICAL_TIMEOUT'])];s.escalatedAt=now;
   store.run('UPDATE semantic_intake SET payload=? WHERE id=?',json(s),row.id);store.audit('semantic-deadline','technical_timeout_to_manual',row.id);expired++;
  }
  return expired;
 });
}

/** One supplement per incident. Preserve earlier commitments; never overwrite originals or reset the deadline. */
export class SemanticIntake {
 constructor(private store:Store,private reviewer:Reviewer,private now=()=>Date.now(),private timeoutMs=30*60*1000){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('SUPPLEMENT_TIMEOUT');
  store.db.exec('CREATE TABLE IF NOT EXISTS semantic_intake(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL)');
 }
 async run(request:Request,proposal:AgentProposal|null,submit=false){
  if(proposal!==null)parseAgentProposal(json(proposal));
  if(!request||Object.keys(request).sort().join()!==(request.previousEvidence?'expiresAt,grantId,noticeId,policyId,previousEvidence,refs':'expiresAt,grantId,noticeId,policyId,refs')||![request.policyId,request.noticeId,request.grantId].every(v=>/^0x[a-f0-9]{64}$/.test(v))||!Array.isArray(request.refs)||request.refs.length>11||new Set(request.refs).size!==request.refs.length||request.refs.some(r=>!/^[a-f0-9]{64}$/.test(r)))throw Error('SEMANTIC_REQUEST_SCHEMA');
  const chain=this.reviewer.chain;await chain.check();
  const p=await chain.policy(request.policyId),n=await chain.read('getNotice',[request.noticeId]);
  if(!p.issuedAt||n.digest===zeroHash||n.data.policyId!==request.policyId||H(request.refs)!==n.data.evidenceHash)throw Error('NOTICE_EVIDENCE_BINDING');
  if(request.previousEvidence){
   const old=await chain.read('getNotice',[request.previousEvidence.noticeId]);
   if(old.digest===zeroHash||old.data.policyId!==request.policyId||old.data.incidentCommitment!==n.data.incidentCommitment||old.data.declaredIncidentAt!==n.data.declaredIncidentAt||old.data.evidenceHash!==H(request.previousEvidence.refs)||old.incidentId!==zeroHash)throw Error('SUPPLEMENT_HISTORY_BINDING');
  }
  if(this.reviewer.routingObserver)await this.reviewer.routingObserver(request);
  const id=H({deployment:chain.deploymentId,policy:request.policyId,commitment:n.data.incidentCommitment}),fingerprint=hash({request,proposal});
  const initial={id,state:'checking',request,proposal,startedAt:this.now(),deadline:this.now()+this.timeoutMs,supplementUsed:false,missing:[] as string[],reasons:[] as string[]};
  let state=this.store.tx(()=>{
   const row=this.store.get('SELECT * FROM semantic_intake WHERE id=?',id);
   const s=row?JSON.parse(row.payload):initial;
   if(!row&&request.previousEvidence)throw Error('NO_SUPPLEMENT_REQUEST');
   if(row&&row.fingerprint!==fingerprint){
    const sameRequest=hash(s.request)===hash(request);
    if(s.state==='awaiting_proposal'&&s.proposal===null&&proposal!==null&&sameRequest&&!submit){s.proposal=proposal;s.state='checking';}
    else{
     if(!submit||s.state!=='awaiting_evidence'||s.supplementUsed||s.request.previousEvidence||(!sameRequest&&(!request.previousEvidence||request.previousEvidence.noticeId!==s.request.noticeId||hash(request.previousEvidence.refs)!==hash(s.request.refs)||request.noticeId===s.request.noticeId||request.grantId!==s.request.grantId||request.expiresAt!==s.request.expiresAt)))throw Error('IMMUTABLE_INTAKE_CONFLICT');
     if(s.request.refs.some((ref:string)=>!s.missing.includes(ref)&&!request.refs.includes(ref)))throw Error('SUPPLEMENT_MUST_RETAIN_AVAILABLE_ORIGINALS');
     s.history=[{request:s.request,proposal:s.proposal,missing:s.missing,missingKinds:s.missingKinds,reasons:s.reasons}];s.request=request;s.proposal=proposal;
    }
   }
   if(s.state==='manual')return s;
   if(this.now()>=s.deadline){s.state='manual';s.reasons=['TECHNICAL_TIMEOUT'];}
   else if(submit&&s.state==='awaiting_evidence'){s.supplementUsed=true;s.state='checking';}
   else if(submit&&!s.supplementUsed)throw Error('NO_SUPPLEMENT_REQUEST');
   this.store.run('INSERT INTO semantic_intake VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload',id,p.quote.enterpriseId,fingerprint,json(s));return s;
  });
  if(state.state==='manual')return state;
  const tools=new AgentEvidenceTools(this.reviewer.originals,{enterpriseId:p.quote.enterpriseId,policyId:request.policyId,deploymentId:chain.deploymentId,runtimeDeployment:this.reviewer.originals.trust.runtimeDeployment,commitment:n.data.incidentCommitment,workflowHash:p.quote.workflowHash},request.refs);
  const missing:string[]=[],docs:any[]=[],reasons:string[]=[];
  const grant=await this.reviewer.grant(request.grantId),trust=this.reviewer.originals.trust;
  if(Number(grant.channel)!==2||grant.scopeHash!==semanticScope(this.reviewer.originals)||grant.reviewer.toLowerCase()!==this.reviewer.actor.toLowerCase()||['templateId','ruleVersion','modelVersion'].some(k=>grant[k]!==trust[k as keyof typeof trust]))reasons.push('PROFILE_OR_REVIEWER_MISMATCH');
  if([grant.reviewer,grant.authorizer].some(a=>[p.quote.insured,p.fde].some(b=>a.toLowerCase()===b.toLowerCase())))reasons.push('SELF_REVIEW');
  if(n.data.declaredIncidentAt<p.quote.startAt||n.data.declaredIncidentAt>=p.quote.endAt)reasons.push('COVERAGE_CONFLICT');
  for(const ref of request.refs){try{docs.push(tools.read(ref));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')missing.push(ref);else reasons.push('INVALID_OR_UNTRUSTED_ORIGINAL');}}
  // Inspect every available original before deciding whether absence is remediable.
  const counts:Record<string,number>={release:1,monitor:1,replay:1,ticket:2,work:2,completion:2,payment:2};
  const missingKinds=Object.entries(counts).flatMap(([kind,count])=>{const absent=count-docs.filter(d=>d.kind===kind).length;return absent>0?[{kind,count:absent}]:[];});
  const incomplete=missing.length>0||missingKinds.length>0;
  if(docs.some(d=>!counts[d.kind]||docs.filter(x=>x.kind===d.kind).length>counts[d.kind]!))reasons.push('EVIDENCE_KIND_CONFLICT');
  const used=proposal?.items.flatMap(i=>[i.ticketRef,i.workRef,i.completionRef,i.paymentRef])??[];
  if(used.some(ref=>!request.refs.includes(ref)))reasons.push('UNBOUND_PROPOSAL_REFERENCE');
  for(const field of ['reference','invoiceId']){
   const values=docs.filter(d=>d.kind==='payment').map(d=>d[field]);if(values.some(v=>typeof v!=='string'||!v)||new Set(values).size!==values.length)reasons.push('DUPLICATE_OR_UNKNOWN_PAYMENT');
  }
  for(const kind of ['ticket','work','completion','payment']){
   const ids=docs.filter(d=>d.kind===kind).map(d=>d.expenseId);if(ids.some(v=>typeof v!=='string'||!v)||new Set(ids).size!==ids.length)reasons.push('DUPLICATE_OR_UNKNOWN_EXPENSE');
  }
  const revisions=docs.filter(d=>['release','monitor','replay'].includes(d.kind)).map(d=>d.revision);
  if(revisions.some(v=>!v)||new Set(revisions).size>1||docs.some(d=>d.kind==='monitor'&&d.failure!==true||d.kind==='replay'&&(d.oldPass!==true||d.newPass!==false||d.rollbackPass!==true)||d.kind==='completion'&&d.completed!==true))reasons.push('CAUSALITY_OR_COMPLETION_CONFLICT');
  const money=(v:any)=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&BigInt(v)<2n**128n;
  for(const d of docs){
   if(d.kind==='ticket'){try{const facts=ticketFacts(d);for(const work of docs.filter(w=>w.kind==='work'&&w.expenseId===d.expenseId))if(facts.units!==work.units||facts.unitPrice!==work.unitPrice||facts.action!==work.action)throw Error('TICKET_CONFLICT');}catch{reasons.push('TICKET_CONFLICT_OR_UNKNOWN');}}
   if(d.kind==='completion'&&(!money(d.units)||!this.reviewer.originals.trust.runbooks[d.runbook]))reasons.push('UNKNOWN_OR_CONFLICTING_COMPLETION');
   if(d.kind==='release'&&(!money(d.occurredAt)||BigInt(d.occurredAt)!==n.data.declaredIncidentAt||BigInt(d.occurredAt)<p.quote.startAt||BigInt(d.occurredAt)>=p.quote.endAt))reasons.push('COVERAGE_CONFLICT');
   if(d.kind==='work'&&(!money(d.units)||!money(d.unitPrice)||this.reviewer.originals.trust.runbooks[d.runbook]?.[d.action]!==d.unitPrice))reasons.push('UNAPPROVED_WORK');
   if(d.kind==='payment'&&(!['paid','compensation','recovery'].every(k=>money(d[k]))||d.beneficiary?.toLowerCase()!==p.quote.beneficiary.toLowerCase()||d.token?.toLowerCase()!==p.quote.token.toLowerCase()))reasons.push('UNKNOWN_OR_CONFLICTING_PAYMENT');
  }
  for(const work of docs.filter(d=>d.kind==='work')){
   const limit=this.reviewer.originals.trust.semantic?.[work.runbook+':'+work.action];
   if(!limit||!money(work.units)||BigInt(work.units)===0n||BigInt(work.units)>BigInt(limit.maxUnits))reasons.push('QUANTITY_OR_CATEGORY_CONFLICT');
   for(const other of docs.filter(d=>d.expenseId===work.expenseId)){
    if(other.kind==='completion'&&(other.units!==work.units||other.runbook!==work.runbook))reasons.push('COMPLETION_CONFLICT');
    if(other.kind==='payment'&&(other.invoiceId!==work.invoiceId||!money(other.paid)||!money(other.compensation)||!money(other.recovery)||!money(work.units)||!money(work.unitPrice)||BigInt(other.paid)!==BigInt(work.units)*BigInt(work.unitPrice)||BigInt(other.compensation)+BigInt(other.recovery)>BigInt(other.paid)))reasons.push('PAYMENT_CONFLICT');
   }
  }
  if(proposal){try{verifyAgentItems(tools,proposal,p.quote.beneficiary,p.quote.token,true);}catch{reasons.push('EXPENSE_CONFLICT_OR_UNKNOWN');}}
  const incident=await chain.read('getIncident',[id]);
  if(incident.version!==0n||incident.manualHold||incident.activeDispute!==zeroHash||n.incidentId!==zeroHash||proposal?.route==='manual')reasons.push('FORCED_MANUAL');
  let assessment:any;
  if(!incomplete&&proposal&&!reasons.length&&(state.state!=='awaiting_evidence'||submit)){try{assessment=await this.reviewer.assess(request,proposal);}catch{reasons.push('INDEPENDENT_REVIEW_FAILED');}}
  state=this.store.tx(()=>{
   const latest=this.store.get('SELECT fingerprint,payload FROM semantic_intake WHERE id=?',id);
   if(latest.fingerprint!==fingerprint)throw Error('INTAKE_VERSION_CHANGED');
   const current=JSON.parse(latest.payload);
   if(current.state==='manual')return current;
   if(this.now()>=current.deadline)reasons.push('TECHNICAL_TIMEOUT');
   current.missing=missing;current.missingKinds=missingKinds;current.reasons=[...new Set(reasons)];
   current.state=reasons.length?'manual':incomplete?(current.supplementUsed?'manual':'awaiting_evidence'):assessment?'ready':current.state==='awaiting_evidence'?'awaiting_evidence':'awaiting_proposal';
   if(current.state==='manual'&&!reasons.length)current.reasons=['SUPPLEMENT_INCOMPLETE'];
   if(incomplete)current.acceptedSource={mode:'restore_or_once_rebind_missing',sources:this.reviewer.originals.trust.sources,rule:'Restore or add missing evidence, or replace missing originals, in one newly committed manifest preserving every available original and referencing the prior notice. Only approved independent sources are accepted.'};
   this.store.run('UPDATE semantic_intake SET payload=? WHERE id=?',json(current),id);return current;
  });
  return state.state==='ready'?{...state,assessment}:state;
 }
}
