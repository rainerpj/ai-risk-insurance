import { randomUUID } from 'node:crypto';
import { canonicalize } from '../domain/evidence.ts';
import { exactObject,identifier,text,requireIncident as need,type Actor,type Incident } from '../domain/incident-schema.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentIngest,byteDigest } from './incident-ingest.ts';

const amount=(v:unknown):v is string|null=>v===null||(typeof v==='string'&&/^(0|[1-9]\d{0,77})$/.test(v));
const fields=['gross','paid','duplicate','compensation','recovery'] as const;
type EvidenceRef={importId:string;objectId:string;kind:'invoice'|'payment'|'compensation'|'recovery'};
export type ExpenseInput={projectId:string;expenseId:string;expectedVersion:number;category:'restoration'|'emergency'|'other';currency:string;scale:number;gross:string|null;paid:string|null;duplicate:string|null;compensation:string|null;recovery:string|null;voucherRef:string;evidenceRefs:EvidenceRef[];verification:'pending'|'confirmed';reason:string};
export type ExpenseRecord=ExpenseInput&{recordId:string;incidentId:string;tenantId:string;version:number;actorId:string;createdAt:string};
export function parseExpense(raw:unknown):ExpenseInput{
 exactObject(raw,['projectId','expenseId','expectedVersion','category','currency','scale',...fields,'voucherRef','evidenceRefs','verification','reason']);
 need(identifier(raw.projectId)&&identifier(raw.expenseId)&&Number.isSafeInteger(raw.expectedVersion)&&Number(raw.expectedVersion)>=0);
 need((typeof raw.category === 'string' && ['restoration','emergency','other'].includes(raw.category))&&typeof raw.currency==='string'&&/^[A-Z][A-Z0-9]{2,11}$/.test(raw.currency)&&Number.isInteger(raw.scale)&&Number(raw.scale)>=0&&Number(raw.scale)<=18,'INVALID_CURRENCY');
 need(fields.every(k=>amount(raw[k])),'INVALID_AMOUNT');need(text(raw.voucherRef)&&raw.voucherRef===raw.voucherRef.trim()&&text(raw.reason));
 need((typeof raw.verification === 'string' && ['pending','confirmed'].includes(raw.verification))&&Array.isArray(raw.evidenceRefs)&&raw.evidenceRefs.length<=100,'INVALID_EXPENSE_EVIDENCE');
 const refs=new Set<string>();for(const ref of raw.evidenceRefs){exactObject(ref,['importId','objectId','kind']);need(identifier(ref.importId)&&identifier(ref.objectId)&&(typeof ref.kind === 'string' && ['invoice','payment','compensation','recovery'].includes(ref.kind)));const key=JSON.stringify(ref);need(!refs.has(key),'DUPLICATE_REFERENCE');refs.add(key);}
 return raw as ExpenseInput;
}
export class IncidentExpense {
 constructor(readonly store:IncidentStore){}
 private records(actor:Actor,project:string,incident:string):ExpenseRecord[]{
  this.store.get(actor,project,'incident',incident);
  return this.store.db.prepare("SELECT payload FROM records WHERE tenant_id=? AND project_id=? AND kind='expense' ORDER BY seq").all(actor.tenantId,project).map(r=>JSON.parse(String(r.payload)) as ExpenseRecord).filter(r=>r.incidentId===incident);
 }
 private evidence(actor:Actor,incident:Incident,line:ExpenseInput){
  const ingest=new IncidentIngest(this.store),invoices:string[]=[],kinds=new Set<string>();let synthetic=false;
  for(const ref of line.evidenceRefs){const receipt=ingest.get(actor,line.projectId,ref.importId);need(incident.runIds.includes(receipt.runId)&&receipt.status==='accepted','EXPENSE_EVIDENCE_SCOPE',422);const original=ingest.usableOriginal(actor,line.projectId,ref.importId,ref.objectId);kinds.add(ref.kind);if(ref.kind==='invoice')invoices.push(original.descriptor.sha256);if(receipt.manifest.dataClass==='synthetic')synthetic=true;}
  return {invoices,kinds,synthetic};
 }
 append(actor:Actor,incidentId:string,raw:unknown,key:string){
  const input=parseExpense(raw);need(identifier(key),'IDEMPOTENCY_KEY_REQUIRED');const digest=byteDigest(canonicalize(JSON.stringify({incidentId,...input})));
  return this.store.tx(()=>{
   this.store.authorize(actor,input.projectId,['enterprise_admin','investigator']);const incident=this.store.get(actor,input.projectId,'incident',incidentId) as Incident;
   const old=this.store.db.prepare('SELECT payload_hash,record_id FROM requests WHERE tenant_id=? AND project_id=? AND actor_id=? AND operation=? AND key=?').get(actor.tenantId,input.projectId,actor.actorId,'expense',key);
   if(old){need(old.payload_hash===digest,'IDEMPOTENCY_CONFLICT',409);const row=this.store.db.prepare('SELECT payload FROM records WHERE id=?').get(String(old.record_id))!;return {expense:JSON.parse(String(row.payload)) as ExpenseRecord,replayed:true};}
   const history=this.records(actor,input.projectId,incidentId),previous=history.filter(r=>r.expenseId===input.expenseId).at(-1);
   need((previous?.version??0)===input.expectedVersion,'EXPENSE_VERSION_CONFLICT',409);
   this.evidence(actor,incident,input); // References must be readable and belong to this incident; not proof of payment.
   const expense:ExpenseRecord={...input,recordId:randomUUID(),incidentId,tenantId:actor.tenantId,version:input.expectedVersion+1,actorId:actor.actorId,createdAt:new Date().toISOString()};
   this.store.db.prepare('INSERT INTO records(id,kind,tenant_id,project_id,payload) VALUES(?,?,?,?,?)').run(expense.recordId,'expense',actor.tenantId,input.projectId,JSON.stringify(expense));
   this.store.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run(actor.tenantId,input.projectId,actor.actorId,'expense',key,digest,expense.recordId);
   this.store.audit(actor.actorId,'append_expense',expense.recordId);return {expense,replayed:false};
  });
 }
 summary(actor:Actor,project:string,incidentId:string){return this.store.tx(()=>{
  const incident=this.store.get(actor,project,'incident',incidentId) as Incident,history=this.records(actor,project,incidentId),latest=new Map<string,ExpenseRecord>();for(const r of history)latest.set(r.expenseId,r);
  const rows=[...latest.values()].sort((a,b)=>a.expenseId<b.expenseId?-1:1).map(line=>{
   const issues:string[]=[],identity=[`voucher:${line.voucherRef}`];let synthetic=false;
   try{const evidence=this.evidence(actor,incident,line);synthetic=evidence.synthetic;identity.push(...evidence.invoices.map(d=>`invoice:${d}`));for(const kind of ['invoice','payment'] as const)if(!evidence.kinds.has(kind))issues.push(`MISSING_${kind.toUpperCase()}_EVIDENCE`);for(const kind of ['compensation','recovery'] as const)if(line[kind]!==null&&BigInt(line[kind])>0n&&!evidence.kinds.has(kind))issues.push(`MISSING_${kind.toUpperCase()}_EVIDENCE`);}catch{issues.push('EVIDENCE_UNAVAILABLE');}
   if(line.verification!=='confirmed')issues.push('MANUAL_CONFIRMATION_PENDING');
   if(fields.some(k=>line[k]===null))issues.push('AMOUNT_UNKNOWN');
   let net:string|null=null;
   if(!issues.length){const gross=BigInt(line.gross!),paid=BigInt(line.paid!),deductions=BigInt(line.duplicate!)+BigInt(line.compensation!)+BigInt(line.recovery!);if(paid>gross||deductions>paid)issues.push('AMOUNT_CONTRADICTION');else net=(paid-deductions).toString();}
   return {line,identity,synthetic,issues,netVerified:net,countedNet:net,duplicateOf:null as string|null,legacyCategory:line.category==='restoration'?'restore':line.category==='emergency'?'mitigate':null};
  });
  // Overlap identifies conflicts; exclusion requires the same complete invoice set.
  const visited=new Set<number>();for(let i=0;i<rows.length;i++){if(visited.has(i))continue;const component=[i];visited.add(i);for(let j=0;j<component.length;j++){const current=rows[component[j]!]!;for(let k=0;k<rows.length;k++)if(!visited.has(k)&&rows[k]!.identity.some(id=>current.identity.includes(id))){visited.add(k);component.push(k);}}
   if(component.length<2)continue;const signature=(r:typeof rows[number])=>JSON.stringify([[...new Set(r.identity.filter(id=>id.startsWith('invoice:')))].sort(),r.line.currency,r.line.scale,r.line.category,...fields.map(k=>r.line[k]),r.netVerified]);const first=rows[component[0]!]!,same=component.every(k=>signature(rows[k]!)===signature(first))&&first.netVerified!==null;
   for(const k of component){const row=rows[k]!;if(!same){row.issues.push('DUPLICATE_VOUCHER_CONFLICT');row.countedNet=null;}else if(k!==component[0]){row.issues.push('DUPLICATE_VOUCHER_EXCLUDED');row.countedNet='0';row.duplicateOf=first.line.expenseId;}}
  }
  const groups=new Map<string,{currency:string;scale:number;dataClass:string;knownSubtotal:string;netTotal:string|null;unknownCount:number}>();for(const r of rows){const dataClass=r.synthetic?'synthetic':'approved_redacted_or_unknown',key=`${r.line.currency}/${r.line.scale}/${dataClass}`,g=groups.get(key)??{currency:r.line.currency,scale:r.line.scale,dataClass,knownSubtotal:'0',netTotal:'0',unknownCount:0};if(r.countedNet===null)g.unknownCount++;else g.knownSubtotal=(BigInt(g.knownSubtotal)+BigInt(r.countedNet)).toString();g.netTotal=g.unknownCount?null:g.knownSubtotal;groups.set(key,g);}
  return {incidentId,history,rows,totals:[...groups.values()],limitations:['Amounts are minimum-unit integers; currencies and scales are never merged or converted.','Confirmed means a recorded human attestation with readable references, not independent invoice or payment authentication.','Actual net loss is not an insured amount. Duplicate conflicts remain unknown; no automatic claim or payment.']};
 });}
}

/** Explicit local-test-only mapping. No production terms or insurance approval. */
export function localTestCoverage(net:string|null,raw:unknown){
 exactObject(raw,['mode','termsVersion','currency','scale','deductible','shareNumerator','shareDenominator','incidentLimit','annualRemaining']);
 need(raw.mode==='local_test'&&text(raw.termsVersion)&&typeof raw.currency==='string'&&/^[A-Z][A-Z0-9]{2,11}$/.test(raw.currency)&&Number.isInteger(raw.scale)&&Number(raw.scale)>=0&&Number(raw.scale)<=18,'INVALID_TEST_TERMS');
 for(const k of ['deductible','shareNumerator','shareDenominator','incidentLimit','annualRemaining'])need(raw[k]!==null&&amount(raw[k]),'INVALID_TEST_TERMS');
 const n=BigInt(raw.shareNumerator as string),d=BigInt(raw.shareDenominator as string);need(d>0n&&n<=d,'INVALID_TEST_SHARE');need(amount(net));
 if(net===null)return {mode:'local_test',terms:raw,proposedAmount:null};
 const base=BigInt(net)>BigInt(raw.deductible as string)?BigInt(net)-BigInt(raw.deductible as string):0n,shared=base*n/d;
 const proposed=[shared,BigInt(raw.incidentLimit as string),BigInt(raw.annualRemaining as string)].reduce((a,b)=>a<b?a:b);
 return {mode:'local_test',terms:raw,proposedAmount:proposed.toString()};
}
