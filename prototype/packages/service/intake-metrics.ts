import {keccak256,stringToHex} from 'viem';
import {Store,Fault,hash,json} from './store.ts';
import {Chain} from './chain.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {validateCostBreakdown,summarizeCostBreakdowns} from './cost-breakdown.ts';

const roles=['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'];
const fields=['id','noticeId','previousId','humanMs','costCurrency','costMicros','costBreakdown','reason'];
const id=(v:unknown)=>typeof v==='string'&&/^0x[a-f0-9]{64}$/.test(v);
const integer=(v:unknown)=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&BigInt(v)<2n**128n;
/** Cumulative staff-attested intake costs, not a claim decision or independent quality verdict. */
export async function recordIntakeMeasurement(s:Store,chain:Chain,actor:any,input:any){
 if(!roles.includes(actor.role))throw new Fault(403,'ROLE_DENIED');
 if(!input||Object.keys(input).sort().join()!==fields.sort().join()||!id(input.id)||!id(input.noticeId)||
  !(input.previousId===null||id(input.previousId))||!(input.humanMs===null||integer(input.humanMs))||
  !(input.costMicros===null||integer(input.costMicros))||!(input.costCurrency===null||typeof input.costCurrency==='string'&&/^[A-Z]{3}$/.test(input.costCurrency))||
  (input.costCurrency===null)!==(input.costMicros===null)||!input.costBreakdown||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>10000)throw new Fault(400,'INTAKE_MEASUREMENT_SCHEMA');
 validateCostBreakdown(input);
 const notice=s.get('SELECT * FROM notices WHERE id=? AND tenant=?',input.noticeId,actor.tenant);
 if(!notice)throw new Fault(404,'NOT_FOUND');
 if(notice.owner.toLowerCase()===actor.address.toLowerCase())throw new Fault(403,'INTAKE_OWNER_CANNOT_MEASURE');
 await chain.check();
 if(!await chain.read('hasRole',[keccak256(stringToHex(actor.role)),actor.address]))throw new Fault(403,'CHAIN_ROLE_REVOKED');
 const digest=hash({actor:actor.address,input});
 const existing=s.get('SELECT * FROM intake_measurements WHERE id=?',input.id);
 if(existing){if(existing.tenant!==actor.tenant)throw new Fault(404,'NOT_FOUND');if(existing.payload_hash!==digest)throw new Fault(409,'IMMUTABLE_MEASUREMENT');return {id:existing.id};}
 const live=await chain.read('getNotice',[input.noticeId]);
 if(live.incidentId!==zeroHash)throw new Fault(409,'NOTICE_ALREADY_BOUND');
 const payload={...input,noticePayloadHash:notice.payload_hash,basis:'cumulative staff-attested intake-only costs; excludes decision costs; not quality review'};
 return s.tx(()=>{
  const old=s.get('SELECT * FROM intake_measurements WHERE id=?',input.id);
  if(old){if(old.tenant!==actor.tenant)throw new Fault(404,'NOT_FOUND');if(old.payload_hash!==digest)throw new Fault(409,'IMMUTABLE_MEASUREMENT');return {id:old.id};}
  const latest=s.get('SELECT id FROM intake_measurements WHERE notice_id=? AND tenant=? ORDER BY rowid DESC LIMIT 1',input.noticeId,actor.tenant);
  if((latest?.id??null)!==input.previousId)throw new Fault(409,'STALE_INTAKE_MEASUREMENT');
  s.run('INSERT INTO intake_measurements VALUES(?,?,?,?,?,?,?)',input.id,input.noticeId,actor.tenant,actor.address,json(payload),digest,new Date().toISOString());
  s.audit(actor.address,'intake_measurement',input.id);return {id:input.id};
 });
}
export function intakeMeasurementHistory(s:Store,tenant:string){
 return s.all('SELECT id,notice_id,actor,payload,created_at FROM intake_measurements WHERE tenant=? ORDER BY rowid DESC',tenant).map(r=>({...r,payload:JSON.parse(r.payload)}));
}
/** Call only with the pending union at a validated workload checkpoint. Missing and chain-only receipts remain unmeasured. */
export function pendingIntakeCosts(s:Store,tenant:string,noticeIds:string[]){
 const latest=new Map<string,any>(),pending=new Set(noticeIds);
 for(const row of intakeMeasurementHistory(s,tenant)){
  if(!pending.has(row.notice_id)||latest.has(row.notice_id))continue;
  const notice=s.get('SELECT payload_hash FROM notices WHERE id=? AND tenant=?',row.notice_id,tenant);
  if(notice?.payload_hash===row.payload.noticePayloadHash)latest.set(row.notice_id,row.payload);
 }
 const values=[...latest.values()],costs=summarizeCostBreakdowns(values);
 const complete=values.filter(m=>m.costMicros!==null).length,human=values.filter(m=>m.humanMs!==null);
 return {basis:'latest cumulative intake measurement per pending notice ID; separate from incident costs and quality outcomes',
  noticeIds:pending.size,measuredNotices:values.length,unmeasuredNotices:pending.size-values.length,completeCosts:complete,partialCosts:values.length-complete,
  humanMs:{known:human.length,unknown:pending.size-human.length,sum:human.length?human.reduce((sum,m)=>sum+BigInt(m.humanMs),0n).toString():null},
  costs:{...costs,groups:costs.groups.map(g=>({...g,pendingPopulationTotalMicros:g.completeMeasurements===pending.size?g.totalMicros:null}))}};
}
