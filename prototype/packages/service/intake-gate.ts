import {DatabaseSync} from 'node:sqlite';
import {verifyMessage} from 'viem';
import {hash} from './store.ts';
import type {Request} from './reviewer.ts';

/** Local configured source only; never accept an intake path or total from an API caller. */
export function localIntakeGate(path:string,scope:string){
 return async<T=void>(request:Request,quote:any,decision:any,commitment:string,work:()=>Promise<T>=async()=>undefined as T)=>{
  // Opening read-only first prevents a missing configured source from being silently created.
  const probe=new DatabaseSync(path,{readOnly:true});probe.close();
  const db=new DatabaseSync(path);let locked=false;
  try{
   try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');locked=true;}
   catch(e){if([5,6].includes((e as any).errcode))throw Error('INTAKE_BUSY_RETRY');throw e;}
   // Reserve the writer lock without permitting this connection to mutate source records.
   db.exec('PRAGMA query_only=ON');
   if((db.prepare("SELECT value FROM meta WHERE key='scope'").get() as any)?.value!==scope)throw Error('INTAKE_DEPLOYMENT_MISMATCH');
   const rows=db.prepare('SELECT id,owner,payload,payload_hash,binding FROM notices WHERE tenant=?').all(quote.enterpriseId) as any[];
   const allowed=new Set([request.noticeId,...(request.previousEvidence?[request.previousEvidence.noticeId]:[])]);
   let current=false,total=0n;
   for(const row of rows){
    const {payload,signature}=JSON.parse(row.payload),binding=row.binding?JSON.parse(row.binding):null;
    if(!payload||payload.incidentCommitment!==commitment)continue;
    const policyId=binding?.authorization?.policyId??payload.policyId;
    if(policyId&&policyId!==request.policyId)continue;
    if(payload.noticeId!==row.id||row.owner.toLowerCase()!==quote.insured.toLowerCase()||row.payload_hash!==hash(payload)||!await verifyMessage({address:quote.insured,message:`FDE local intake v1\nDeployment: ${scope}\nPayload SHA256: ${hash(payload)}`,signature}))throw Error('INTAKE_SIGNATURE_INVALID');
    if(!policyId||!allowed.has(row.id))throw Error('MANUAL_LOCAL_AGGREGATION_REQUIRED');
    if(row.id===request.noticeId)current=true;
    if(typeof payload.claimedAmount!=='string'||!/^(0|[1-9]\d*)$/.test(payload.claimedAmount)||BigInt(payload.claimedAmount)>=2n**256n)throw Error('MANUAL_CLAIMED_AMOUNT_UNKNOWN');
    total+=BigInt(payload.claimedAmount);
   }
   if(!current)throw Error('INTAKE_RECEIPT_REQUIRED');
   if(total>BigInt(decision.reviewAmount))throw Error('MANUAL_CLAIM_EXCEEDS_REVIEW');
   return await work();
  }finally{try{if(locked)db.exec('ROLLBACK');}finally{db.close();}}
 };
}
