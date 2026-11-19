import type {Store} from './store.ts';
import type {Chain} from './chain.ts';
import {zeroHash} from '../domain/typed-data.ts';

/** Candidate grouping by declared commitment, never an adjudication of incident identity. */
export async function noticeGroups(store:Store,chain:Chain,tenant:string){
 const locals=store.all('SELECT id,payload,binding,received_at FROM notices WHERE tenant=?',tenant);
 let chainState='unavailable',confirmed:any[]=[];
 const height=store.getMeta('confirmed'),proof=store.getMeta('projectionHash');
 try{
  if(height!==undefined&&proof&&!store.getMeta('indexError')&&!store.getMeta('halted')){
   await chain.check();if((await chain.block(BigInt(height))).hash===proof){
    confirmed=store.all("SELECT id,payload FROM views WHERE kind='notice' AND tenant=?",tenant);
    if(store.getMeta('confirmed')===height&&store.getMeta('projectionHash')===proof)chainState='confirmed';else confirmed=[];
   }
  }
 }catch{confirmed=[];}
 const notices=new Map<string,any>();
 for(const row of locals){
  const p=JSON.parse(row.payload).payload,binding=row.binding?JSON.parse(row.binding):null;
  const claimedAmount=typeof p?.claimedAmount==='string'&&/^(0|[1-9]\d*)$/.test(p.claimedAmount)&&BigInt(p.claimedAmount)<2n**256n?p.claimedAmount:null;
  notices.set(row.id,{id:row.id,claimedAmount,policyId:binding?.authorization?.policyId??p?.policyId??null,commitment:p?.incidentCommitment??null,receivedAt:row.received_at,anchoredAt:null,incidentId:null,state:'local_only'});
 }
 for(const row of confirmed){const n=JSON.parse(row.payload),local=notices.get(row.id);
  notices.set(row.id,{id:row.id,claimedAmount:local?.claimedAmount??null,policyId:n.data.policyId,commitment:n.data.incidentCommitment,receivedAt:local?.receivedAt??null,anchoredAt:n.anchoredAt,incidentId:n.incidentId===zeroHash?null:n.incidentId,state:'confirmed'});
 }
 const groups=new Map<string,any>();
 for(const notice of notices.values()){
  const key=JSON.stringify([notice.policyId,notice.commitment,...(!notice.policyId||!notice.commitment?[notice.id]:[])]);
  const g=groups.get(key)??{policyId:notice.policyId,commitment:notice.commitment,notices:[],claimedTotal:null,amountStatus:'not_recorded',identityStatus:'requires_human_verification'};
  g.notices.push(notice);groups.set(key,g);
 }
 return {chainState,groups:[...groups.values()].map(g=>{
  const known=g.notices.filter((n:any)=>n.claimedAmount!==null),unknownAmounts=g.notices.length-known.length;
  const knownClaimedSubtotal=known.reduce((sum:bigint,n:any)=>sum+BigInt(n.claimedAmount),0n).toString();
  return {...g,claimedTotal:unknownAmounts?null:knownClaimedSubtotal,knownClaimedSubtotal,unknownAmounts,amountStatus:unknownAmounts?'incomplete':'declared_unverified',requiresAggregation:g.notices.length>1,localOnly:g.notices.filter((n:any)=>n.state==='local_only').length};
 }),limitation:'Claimed amounts are per-notice new requests, not verified loss. Candidate commitment groups require human identity and duplicate-expense verification. Missing amounts stay unknown. Offline notices are not visible to chain-only automatic authorization.'};
}
