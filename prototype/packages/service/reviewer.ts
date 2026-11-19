import {verify,randomUUID} from 'node:crypto';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {hash,json} from './store.ts';
import {parseStrictJSON} from '../domain/evidence.ts';
import type {Chain} from './chain.ts';
import {encodeAbiParameters,keccak256,type Hex} from 'viem';
import {zeroHash} from '../domain/typed-data.ts';
export const H=(v:unknown)=>`0x${hash(v)}` as Hex;
export type Request={policyId:Hex;noticeId:Hex;grantId:Hex;expiresAt:string;refs:string[];previousEvidence?:{noticeId:Hex;refs:string[]}};
export const requestNoticeIds=(request:Request)=>[request.noticeId,...(request.previousEvidence?[request.previousEvidence.noticeId]:[])].sort();
export type Trust={runtimeDeployment:string;sources:Record<string,{kind:string;publicKey:string}>;runbooks:Record<string,Record<string,string>>;templateId:Hex;ruleVersion:Hex;modelVersion:Hex;semantic?:Record<string,{category:0|1;maxUnits:string}>};
export class Originals {
  constructor(public directory:string,public trust:Trust){
    if(!trust.runtimeDeployment)throw new Error('RUNTIME_DEPLOYMENT_REQUIRED');const sources=Object.values(trust.sources);for(const s of sources)if(sources.some(other=>other.kind!==s.kind&&other.publicKey===s.publicKey))throw new Error('INDEPENDENT_SOURCE_KEYS_REQUIRED');
  }
  read(ref:string){
    if(!/^[a-f0-9]{64}$/.test(ref))throw new Error('INVALID_EVIDENCE_REFERENCE');
    const doc=parseStrictJSON(readFileSync(resolve(this.directory,ref+'.json'),'utf8')) as any;
    return this.verify(doc,ref);
  }
  verify(doc:any,ref=hash(doc)){
    if(!doc||typeof doc!=='object'||!doc.body||typeof doc.body!=='object'||typeof doc.source!=='string'||typeof doc.signature!=='string')throw new Error('EVIDENCE_SCHEMA');
    if(hash(doc)!==ref)throw new Error('EVIDENCE_DIGEST_MISMATCH');
    if(Object.keys(doc).sort().join()!=='body,signature,source')throw new Error('EVIDENCE_SCHEMA');
    const source=this.trust.sources[doc.source];
    if(!source||source.kind!==doc.body.kind||!verify(null,Buffer.from(hash(doc.body)),source.publicKey,Buffer.from(doc.signature,'base64')))throw new Error('UNTRUSTED_SOURCE');
    const fields:Record<string,string>={release:'revision occurredAt',monitor:'revision failure',replay:'revision oldPass newPass rollbackPass',work:'runbook action units unitPrice expenseId invoiceId',completion:'runbook units expenseId completed',payment:'expenseId invoiceId paid compensation recovery beneficiary token reference',ticket:'narrative expenseId'};
    const expected=('kind policyId commitment enterpriseId workflowHash deploymentId runtimeDeployment '+fields[source.kind]).split(' ').sort().join();
    if(!fields[source.kind]||Object.keys(doc.body).sort().join()!==expected)throw new Error('EVIDENCE_SCHEMA');
    return doc.body;
  }
  import(text:string,scope:Record<string,string>){
    if(typeof text!=='string'||Buffer.byteLength(text)>100000)throw Error('ORIGINAL_SIZE');
    const doc=parseStrictJSON(text),ref=hash(doc),body=this.verify(doc,ref);
    for(const [key,value] of Object.entries(scope))if(body[key]!==value)throw Error('EVIDENCE_SCOPE');
    const target=resolve(this.directory,ref+'.json'),temporary=resolve(this.directory,'.import-'+randomUUID()+'.tmp');
    const fd=openSync(temporary,'wx',0o600);
    try{
      try{writeFileSync(fd,json(doc));fsyncSync(fd);}finally{closeSync(fd);}
      try{linkSync(temporary,target);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;this.read(ref);}
    }
    finally{unlinkSync(temporary);}
    return {ref,kind:body.kind};
  }
}
export function route(claimed:bigint,paid:bigint,due:bigint,net:bigint,forced:string[]=[]){
  const reviewAmount=[claimed,paid+due,net].reduce((a,b)=>a>b?a:b);
  return {reviewAmount,channel:forced.length?'manual':reviewAmount<=1000_000000n?'L1':reviewAmount<=10000_000000n?'L2':'manual',supervisor:reviewAmount>50000_000000n,reasons:forced};
}
const money=(v:unknown)=>{if(typeof v!=='string'||! /^(0|[1-9]\d*)$/.test(v))throw new Error('DECIMAL_STRING_REQUIRED');return BigInt(v);};
/** Both processes run this against originals and live chain. No caller-provided "valid" flags. */
export async function review(chain:Chain,originals:Originals,request:Request,grant:any){
  if(!request||Object.keys(request).sort().join()!=='expiresAt,grantId,noticeId,policyId,refs'||![request.policyId,request.noticeId,request.grantId].every(v=>/^0x[a-f0-9]{64}$/.test(v))||!Array.isArray(request.refs))throw new Error('REQUEST_SCHEMA');
  await chain.check();const q=(await chain.policy(request.policyId)).quote;
  const n=await chain.read('getNotice',[request.noticeId]);
  if(n.digest===zeroHash||n.data.policyId!==request.policyId||H(request.refs)!==n.data.evidenceHash)throw new Error('NOTICE_EVIDENCE_BINDING');
  if(request.refs.length!==6||new Set(request.refs).size!==6)throw new Error('EVIDENCE_SCHEMA');
  const docs=request.refs.map(r=>originals.read(r));const by=Object.fromEntries(docs.map(d=>[d.kind,d]));
  const required=['release','monitor','replay','work','completion','payment'];
  if(required.some(k=>!by[k])||Object.keys(by).length!==6)throw new Error('MISSING_INDEPENDENT_EVIDENCE');
  for(const d of docs)if(d.deploymentId!==chain.deploymentId||d.runtimeDeployment!==originals.trust.runtimeDeployment||d.policyId!==request.policyId||d.commitment!==n.data.incidentCommitment||d.enterpriseId!==q.enterpriseId||d.workflowHash!==q.workflowHash)throw new Error('EVIDENCE_SCOPE');
  const {release,monitor,replay,work,completion,payment}=by;
  const reasons:string[]=[];
  const occurred=money(release.occurredAt),now=(await chain.client.getBlock()).timestamp as bigint;
  if(occurred!==n.data.declaredIncidentAt||occurred<q.startAt||occurred>=q.endAt||occurred>now)reasons.push('OUTSIDE_COVERAGE');
  if(!release.revision||release.revision!==monitor.revision||release.revision!==replay.revision||monitor.failure!==true||replay.oldPass!==true||replay.newPass!==false||replay.rollbackPass!==true)reasons.push('CAUSALITY_OR_CONFLICT');
  if(work.runbook!==completion.runbook||work.expenseId!==completion.expenseId||work.expenseId!==payment.expenseId||completion.completed!==true||completion.units!==work.units||payment.invoiceId!==work.invoiceId)reasons.push('WORK_OR_INVOICE_CONFLICT');
  const rates=originals.trust.runbooks[work.runbook];const rate=rates?.[work.action];
  if(!rate||work.unitPrice!==rate)reasons.push('UNAPPROVED_RUNBOOK');
  const gross=money(work.unitPrice)*money(work.units),paid=money(payment.paid);
  if(gross!==paid||payment.beneficiary.toLowerCase()!==q.beneficiary.toLowerCase()||payment.token.toLowerCase()!==q.token.toLowerCase()||!payment.reference||!work.expenseId||!work.invoiceId)reasons.push('PAYMENT_MISMATCH');
  const compensation=money(payment.compensation),recovery=money(payment.recovery);
  if(compensation+recovery>gross)throw new Error('NEGATIVE_NET');
  const net=gross-compensation-recovery;
  const incidentId=H({deployment:chain.deploymentId,policy:request.policyId,commitment:n.data.incidentCommitment});
  const i=await chain.read('getIncident',[incidentId]);
  // Existing incidents are transferred to the human workflow in M2b; never split into a fresh auto ID.
  if(i.version!==0n||i.manualHold||i.activeDispute!==zeroHash||n.incidentId!==zeroHash)reasons.push('EXISTING_OR_MANUAL_INCIDENT');
  const p=await chain.policy(request.policyId);
  for(const actor of [grant.reviewer,grant.authorizer])if([q.insured,p.fde].some(address=>address.toLowerCase()===actor.toLowerCase()))reasons.push('SELF_REVIEW');
  if(net===0n||net>q.incidentLimit||p.paidTotal+p.dueTotal+net>q.annualLimit)reasons.push('ZERO_OR_CAP_CLIPPING');
  for(const k of ['templateId','ruleVersion','modelVersion'] as const)if(grant[k]!==originals.trust[k])reasons.push('PROFILE_VERSION_MISMATCH');
  if(grant.scopeHash!==H({templateId:originals.trust.templateId,runbooks:originals.trust.runbooks,sources:originals.trust.sources,runtimeDeployment:originals.trust.runtimeDeployment}))reasons.push('PROFILE_SCOPE_MISMATCH');
  const routing=route(gross,i.P,i.D,net,reasons);
  if(routing.channel!=='L1')throw new Error('MANUAL_REQUIRED:'+json(routing));
  const expiresAt=money(request.expiresAt);if(expiresAt<=now||expiresAt>now+3600n||expiresAt>grant.validUntil)throw new Error('SIGNATURE_LIFETIME');
  const amounts=[{gross,duplicate:0n,compensation,recovery},{gross:0n,duplicate:0n,compensation:0n,recovery:0n}] as const;
  const decisionId=H({request,incidentId,version:'1'}),reservationId=H({decisionId,purpose:'obligation'});
  const d={decisionId,policyId:request.policyId,incidentId,noticeSetHash:keccak256(encodeAbiParameters([{type:'bytes32[]'}],[[request.noticeId]])),version:1n,previousVersion:0n,
    expectedLedgerHash:await chain.read('ledgerHash',[request.policyId,incidentId]),assessmentHash:zeroHash,
    amountsHash:keccak256(encodeAbiParameters([{type:'tuple[2]',components:['gross','duplicate','compensation','recovery'].map(name=>({name,type:'uint256'}))}],[amounts])),
    netApproved:net,beneficiary:q.beneficiary,reasonHash:H({request,rule:originals.trust.ruleVersion}),reviewAmount:routing.reviewAmount,channel:1n,grantId:request.grantId,
    grantEpoch:BigInt(grant.epoch),budgetVersion:BigInt(grant.budgetVersion),reservationId,approver:grant.authorizer,signerEpoch:await chain.read('epochs',[grant.authorizer]),expiresAt};
  return {d,amounts,q,expenseKey:H({insurer:q.insurerId,token:q.token,enterprise:q.enterpriseId,expense:work.expenseId}),report:{request,incidentId,net:net.toString(),routing,sourceChecks:required,rule:originals.trust.ruleVersion}};
}
