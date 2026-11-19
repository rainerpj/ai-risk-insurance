import {encodeFunctionData,keccak256} from 'viem';
import {Store,hash,json} from './store.ts';
import {Chain,grantAbi} from './chain.ts';
import {recoveryReadiness,type RecoveryBudget} from './recovery-readiness.ts';
import {activationReadiness,type ActivationRequest} from './activation-readiness.ts';

/** Separate governor process. Never enables channels or Grants. Signed bytes are never replaced. */
export class RecoveryExecutor {
 constructor(private s:Store,private chain:Chain,private actor:string,private budgets:ReadonlyMap<string,RecoveryBudget>,private confirmations=2){
  if(!Number.isSafeInteger(confirmations)||confirmations<1)throw Error('RECOVERY_CONFIRMATIONS');
  s.db.exec(`CREATE TABLE IF NOT EXISTS recovery_plans(id TEXT PRIMARY KEY,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,raw TEXT,tx_hash TEXT,receipt TEXT,error TEXT)`);
  s.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_pending_recovery ON recovery_plans((1)) WHERE state IN ('signing','prepared','unknown','submitted')");
  s.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_recovery_preparation ON recovery_plans((1)) WHERE state IN ('preparing','signing','prepared','unknown','submitted'); CREATE TABLE IF NOT EXISTS recovery_unsigned(plan_id TEXT PRIMARY KEY REFERENCES recovery_plans(id),payload TEXT NOT NULL,payload_hash TEXT NOT NULL)");
 }
 get(id:string){const r=this.s.get('SELECT * FROM recovery_plans WHERE id=?',id);if(!r)throw Error('RECOVERY_PLAN_NOT_FOUND');return r;}
 async planActivation(id:string,recoveryId:string,request:ActivationRequest,reason:string){
  if(!/^0x[a-f0-9]{64}$/.test(id)||!/^0x[a-f0-9]{64}$/.test(reason)||/^0x0{64}$/.test(reason))throw Error('RECOVERY_PLAN_SCHEMA');
  const input={action:'activation',recoveryId,request,reason,actor:this.actor.toLowerCase()},old=this.s.get('SELECT * FROM recovery_plans WHERE id=?',id);
  if(old){const p=JSON.parse(old.payload);if(hash({action:p.action,recoveryId:p.recoveryId,request:p.request,reason:p.reason,actor:p.actor})!==hash(input))throw Error('RECOVERY_PLAN_CONFLICT');return old;}
  const report=await activationReadiness(this.s,this.chain,recoveryId,request,this.budgets,this.confirmations);
  if(!report.ready)throw Error(`ACTIVATION_NOT_READY:${report.reasons.join(',')}`);
  const payload={id,...input,templateId:report.templateId,report};
  this.s.run('INSERT INTO recovery_plans VALUES(?,?,?,\'planned\',NULL,NULL,NULL,NULL)',id,json(payload),hash(payload));return this.get(id);
 }
 async plan(id:string,templateId:string,reason:string){
  if(!/^0x[a-f0-9]{64}$/.test(id)||!/^0x[a-f0-9]{64}$/.test(reason)||/^0x0{64}$/.test(reason))throw Error('RECOVERY_PLAN_SCHEMA');
  const old=this.s.get('SELECT * FROM recovery_plans WHERE id=?',id);
  if(old){const p=JSON.parse(old.payload);if(p.templateId!==templateId||p.reason!==reason||p.actor!==this.actor.toLowerCase())throw Error('RECOVERY_PLAN_CONFLICT');return old;}
  const report=await recoveryReadiness(this.s,this.chain,templateId,this.budgets,this.confirmations);
  if(!report.ready)throw Error(`RECOVERY_NOT_READY:${report.reasons.join(',')}`);
  const payload={id,templateId,reason,actor:this.actor.toLowerCase(),report};
  this.s.run('INSERT INTO recovery_plans VALUES(?,?,?,\'planned\',NULL,NULL,NULL,NULL)',id,json(payload),hash(payload));
  return this.get(id);
 }
 private async validate(p:any){
  if(p.actor!==this.actor.toLowerCase()||p.report.scope!==this.s.getMeta('scope'))throw Error('RECOVERY_EXECUTOR_SCOPE');
  const current=p.action==='activation'?await activationReadiness(this.s,this.chain,p.recoveryId,p.request,this.budgets,this.confirmations):await recoveryReadiness(this.s,this.chain,p.templateId,this.budgets,this.confirmations);
  if(!current.ready||current.digest!==p.report.digest)throw Error('RECOVERY_PLAN_STALE');
 }
 async tick(id:string){
  let row=this.get(id);const p=JSON.parse(row.payload);
  if(hash(p)!==row.payload_hash||p.actor!==this.actor.toLowerCase()||p.report.scope!==this.s.getMeta('scope'))throw Error('RECOVERY_EXECUTOR_SCOPE');
  // Always resolve the original hash first, including after a previous confirmation or a lost response.
  if(row.tx_hash){
   let receipt:any;
   try{receipt=await this.chain.client.getTransactionReceipt({hash:row.tx_hash});}
   catch(e:any){if(e.name!=='TransactionReceiptNotFoundError')throw e;}
   if(receipt){
    if((await this.chain.block(receipt.blockNumber)).hash!==receipt.blockHash){this.s.run("UPDATE recovery_plans SET state='unknown',error='RECEIPT_REORG' WHERE id=?",id);return this.get(id);}
    const tip=await this.chain.client.getBlockNumber({cacheTime:0});
    const state=receipt.status!=='success'?'reverted':BigInt(tip)-BigInt(receipt.blockNumber)+1n>=BigInt(this.confirmations)?'confirmed':'submitted';
    this.s.run('UPDATE recovery_plans SET state=?,receipt=?,error=NULL WHERE id=?',state,json(receipt),id);return this.get(id);
   }
   // Receipt once observed then lost: do not silently replay through a reorg.
   if(row.receipt){this.s.run("UPDATE recovery_plans SET state='unknown',error='RECEIPT_LOST' WHERE id=?",id);return this.get(id);}
  }
  if(['reverted','stale'].includes(row.state))return row;
  // Legacy interrupted jobs have no proof that their unsigned request was fixed before signing.
  if(row.state==='signing'&&!this.s.get('SELECT plan_id FROM recovery_unsigned WHERE plan_id=?',id))return row;
  if(!row.raw){
   try{await this.validate(p);}catch(e){if((e as Error).message==='RECOVERY_PLAN_STALE')this.s.run("UPDATE recovery_plans SET state='stale',error='RECOVERY_PLAN_STALE' WHERE id=? AND raw IS NULL AND state IN ('preparing','signing')",id);throw e;}
   if(row.state==='planned'&&!this.s.run("UPDATE recovery_plans SET state='preparing' WHERE id=? AND state='planned'",id).changes)return this.get(id);
   try{
    await this.chain.check();const target=await this.chain.read('grantRegistry');
    let name='recoverVersion',args:any[]=[p.templateId,BigInt(p.report.governanceRevision),`0x${row.payload_hash}`,p.reason];
    if(p.action==='activation'){
     if(p.request.kind==='configure'){
      const grant={...p.request.grant,channel:Number(p.request.grant.channel)};
      for(const field of ['budgetVersion','validFrom','validUntil','epoch','reviewLimit'])grant[field]=BigInt(grant[field]);
      name='configureRecovered';args=[p.request.grantId,grant,BigInt(p.report.governanceRevision),p.report.evidence];
     }else{name='enableRecoveredChannel';args=[p.request.grantId,p.request.approve,p.request.pay,BigInt(p.report.governanceRevision),p.report.evidence,p.reason];}
    }
    await this.chain.client.simulateContract({address:target,abi:grantAbi,functionName:name,args,account:this.actor});
    const w=this.chain.wallet(this.actor),data=encodeFunctionData({abi:grantAbi,functionName:name,args});
    let unsigned=this.s.get('SELECT * FROM recovery_unsigned WHERE plan_id=?',id);
    if(!unsigned){
     const request=await w.prepareTransactionRequest({to:target,data,gas:14_000_000n}),fixed:Record<string,any>={};
     // Only transaction fields; never persist an account object or signer implementation.
     for(const key of ['to','data','nonce','chainId','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','value','type','accessList'])if(request[key]!==undefined)fixed[key]=request[key];
     this.s.tx(()=>{
      if(!['preparing','signing'].includes(this.get(id).state))return;
      this.s.run('INSERT OR IGNORE INTO recovery_unsigned VALUES(?,?,?)',id,json(fixed),hash(fixed));
      this.s.run("UPDATE recovery_plans SET state='signing' WHERE id=? AND state='preparing'",id);
     });
     unsigned=this.s.get('SELECT * FROM recovery_unsigned WHERE plan_id=?',id);
    }
    if(!unsigned)return this.get(id);
    const fixed=JSON.parse(unsigned.payload);
    if(hash(fixed)!==unsigned.payload_hash||fixed.to.toLowerCase()!==target.toLowerCase()||fixed.data!==data||Number(fixed.chainId)!==31337)throw Error('UNSIGNED_RECOVERY_CONFLICT');
    for(const key of ['gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','value'])if(fixed[key]!==undefined)fixed[key]=BigInt(fixed[key]);
    await this.validate(p);
    const raw=await w.signTransaction(fixed),txHash=keccak256(raw);
    this.s.tx(()=>{
     const latest=this.get(id);if(latest.raw){if(latest.raw!==raw||latest.tx_hash!==txHash)throw Error('RECOVERY_SIGNATURE_CONFLICT');return;}
     this.s.run("UPDATE recovery_plans SET state='prepared',raw=?,tx_hash=? WHERE id=? AND state='signing'",raw,txHash,id);
    });
   }catch(e){
    if((e as Error).message==='RECOVERY_PLAN_STALE')this.s.run("UPDATE recovery_plans SET state='stale',error='RECOVERY_PLAN_STALE' WHERE id=? AND raw IS NULL AND state IN ('preparing','signing')",id);
    else this.s.run("UPDATE recovery_plans SET error='SIGNING_REQUIRES_REVIEW' WHERE id=? AND state IN ('preparing','signing')",id);
    throw e;
   }
   row=this.get(id);
   if(!row.raw||['confirmed','reverted','stale'].includes(row.state))return row;
  }
  try{await this.validate(p);}catch(e){this.s.run("UPDATE recovery_plans SET state=CASE WHEN state='prepared' THEN 'stale' ELSE 'unknown' END,error='RECOVERY_PLAN_STALE' WHERE id=? AND state IN ('prepared','unknown','submitted')",id);throw e;}
  // Persist ambiguity before I/O. A timeout must never generate new signed bytes.
  if(!this.s.run("UPDATE recovery_plans SET state='unknown',error=NULL WHERE id=? AND state IN ('prepared','unknown','submitted')",id).changes)return this.get(id);
  try{await this.chain.client.sendRawTransaction({serializedTransaction:row.raw});this.s.run("UPDATE recovery_plans SET state='submitted' WHERE id=? AND state='unknown'",id);}
  catch{this.s.run("UPDATE recovery_plans SET error='BROADCAST_OUTCOME_UNKNOWN' WHERE id=? AND state='unknown'",id);}
  return this.get(id);
 }
}
