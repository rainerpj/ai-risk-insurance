import {readFileSync} from 'node:fs';
import {assertSingleAutomaticIncident} from './incident-scope.ts';
import type {localIntakeGate} from './intake-gate.ts';
import {recoverTypedDataAddress,parseAbiItem,type Hex} from 'viem';
import {domain,types,digest,decisionContentHash,zeroHash} from '../domain/typed-data.ts';
import {Chain} from './chain.ts';
import {Budget,type BudgetConfig} from './budget.ts';
import {Originals,review,H,requestNoticeIds,type Request} from './reviewer.ts';
import {json} from './store.ts';
import {reviewSemantic} from './semantic-review.ts';
import type {AgentProposal} from './agent.ts';
const abi=JSON.parse(readFileSync(new URL('../domain/abi/GrantRegistry.json',import.meta.url),'utf8'));
export const typed=(type:keyof typeof types,data:any)=>{
  if(!data||Object.keys(data).sort().join()!==types[type].map(f=>f.name).sort().join())throw new Error('TYPED_SCHEMA');
  return Object.fromEntries(types[type].map(f=>{if(f.type.startsWith('uint')&&typeof data[f.name]!=='bigint'&&(typeof data[f.name]!=='string'||!/^(0|[1-9]\d*)$/.test(data[f.name])))throw new Error('DECIMAL_STRING_REQUIRED');return [f.name,f.type.startsWith('uint')?BigInt(data[f.name]):data[f.name]];}));
};
export class Reviewer {
  routingObserver?: (request:Request)=>Promise<unknown>;
  constructor(public chain:Chain,public originals:Originals,public actor:string,public record:(report:any)=>void=()=>{}){}
  async grant(id:string){return this.chain.client.readContract({address:await this.chain.read('grantRegistry'),abi,functionName:'getGrant',args:[id]});}
  async assess(request:Request,proposal?:AgentProposal){
    try{
    if(this.routingObserver)await this.routingObserver(request);
    const g=await this.grant(request.grantId);if(g.reviewer.toLowerCase()!==this.actor.toLowerCase())throw new Error('REVIEWER_IDENTITY');
    const r=Number(g.channel)===2?await reviewSemantic(this.chain,this.originals,request,g,proposal!):await review(this.chain,this.originals,request,g);
    const a={decisionContentHash:decisionContentHash(r.d),assessor:this.actor,signerEpoch:await this.chain.read('epochs',[this.actor]),expiresAt:r.d.expiresAt};
    this.record(r.report);return {request,a,signature:await this.chain.sign(this.actor,'Assessment',a),report:r.report};
    }catch(e){this.record({request,route:'manual',error:(e as Error).message});throw e;}
  }
}
/** Separate process, account, database and capability from both reviewer and relayer. */
export class Authorizer {
  intakeGate?:ReturnType<typeof localIntakeGate>;
  private async withIntake<T>(request:Request,q:any,d:any,work:()=>Promise<T>):Promise<T>{
    if(!this.intakeGate)return work();
    const commitment=(await this.chain.read('getNotice',[request.noticeId])).data.incidentCommitment;
    return this.intakeGate(request,q,d,commitment,work);
  }
  private busy=false;
  constructor(public chain:Chain,public originals:Originals,public budget:Budget,public actor:string,public startBlock=0n,public confirmations=2){}
  async exclusive<T>(fn:()=>Promise<T>){if(this.busy)throw new Error('AUTHORIZER_BUSY_RETRY');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  async grant(id:string){return this.chain.client.readContract({address:await this.chain.read('grantRegistry'),abi,functionName:'getGrant',args:[id]});}
  private async configurationProof(){
    const saved=this.budget.meta('configurationProof');if(!saved)return;
    const proof=JSON.parse(saved),height=BigInt(proof.height),tip=await this.chain.client.getBlockNumber({cacheTime:0});
    if(height>tip||(await this.chain.block(height)).hash!==proof.hash){this.budget.pause();throw new Error('CONFIG_PROOF_ORPHANED');}
  }
  private async dependencies(i:any,now:bigint){
    for(const dependency of [i.assessment,i.decision]){
      const actor=dependency.assessor??dependency.approver;
      if(BigInt(dependency.expiresAt)<=now||BigInt(dependency.signerEpoch)!==await this.chain.read('epochs',[actor]))throw new Error('DEPENDENCY_EXPIRED_OR_REVOKED');
    }
  }
  async gate(q:any,d:any,reviewer:string,payment=false,manualHold=false){
    await this.chain.check();await this.configurationProof();
    if(d.approver.toLowerCase()!==this.actor.toLowerCase())throw new Error('AUTHORIZER_IDENTITY');
    if(this.budget.meta('ready')!=='1')throw new Error('RECONCILIATION_REQUIRED');
    const configs=this.budget.all('SELECT config FROM limits');if(configs.length!==4)throw new Error('BUDGET_NOT_CONFIGURED');
    for(const row of configs)if(BigInt(JSON.parse(row.config).version)!==d.budgetVersion)throw new Error('BUDGET_VERSION');
    await this.chain.client.readContract({address:await this.chain.read('grantRegistry'),abi,functionName:'validate',args:[q,d,reviewer,payment,manualHold]});
  }
  async authorize(request:Request,assessment:any,signature:Hex,proposal?:AgentProposal){return this.exclusive(async()=>{
    const g=await this.grant(request.grantId),r=Number(g.channel)===2?await reviewSemantic(this.chain,this.originals,request,g,proposal!):await review(this.chain,this.originals,request,g),a=typed('Assessment',assessment);
    if(a.assessor.toLowerCase()!==g.reviewer.toLowerCase()||a.assessor.toLowerCase()===this.actor.toLowerCase()||a.decisionContentHash!==decisionContentHash(r.d)||a.expiresAt!==r.d.expiresAt||a.signerEpoch!==await this.chain.read('epochs',[a.assessor]))throw new Error('INDEPENDENT_ASSESSMENT_REQUIRED');
    const scope=domain(this.chain.core,this.chain.deploymentId);
    if((await recoverTypedDataAddress({domain:scope,types,primaryType:'Assessment',message:a,signature})).toLowerCase()!==a.assessor.toLowerCase())throw new Error('INVALID_REVIEW_SIGNATURE');
    r.d.assessmentHash=digest('Assessment',a,scope);await this.gate(r.q,r.d,a.assessor);
    try{await assertSingleAutomaticIncident(this.chain,request);}catch(e){this.budget.audit('automatic_incident_scope_blocked',{request,reason:String(e)});throw e;}
    return this.withIntake(request,r.q,r.d,async()=>{
    const dims={deploymentId:this.chain.deploymentId,insurerId:r.q.insurerId,token:r.q.token,enterpriseId:r.q.enterpriseId,fdeId:r.q.fdeId,riskGroupId:this.budget.group(g.modelVersion)};
    if(dims.riskGroupId!==g.riskGroupId)throw new Error('RISK_GROUP_MISMATCH');
    const now=Number((await this.chain.client.getBlock()).timestamp);
    this.budget.reserve(r.d.reservationId,r.d.decisionId,r.d.incidentId,dims,r.d.netApproved,{request,d:r.d,...(proposal?{proposal}:{})},now,r.expenseKey);
    const sig=await this.chain.sign(this.actor,'ClaimDecision',r.d);
    // If killed here, reservation survives. Deterministic payload/signature retries cannot create another obligation.
    this.budget.signature(r.d.decisionId,r.d,sig);
    this.budget.audit('independent_evidence_review',r.report);
    const supervisor={decisionDigest:zeroHash,supervisor:'0x'+'00'.repeat(20),signerEpoch:0n,expiresAt:0n};
    const job={id:r.d.decisionId,action:'registerDecision',args:[r.d,r.amounts,requestNoticeIds(request),a,signature,sig,supervisor,'0x'],report:r.report};
    this.budget.run('INSERT OR IGNORE INTO jobs VALUES(?,?,?)',job.id,json(request),json(job));return job;
    });
  });}
  async payment(reservationId:string,amountString:string,requestId:string){return this.exclusive(async()=>{
    if(!/^[1-9]\d*$/.test(amountString)||!/^0x[a-f0-9]{64}$/.test(requestId))throw new Error('PAYMENT_SCHEMA');
    const r=this.budget.get('SELECT * FROM reservations WHERE id=?',reservationId);if(!r||r.state==='released')throw new Error('RESERVATION_REQUIRED');
    const original=JSON.parse(r.payload),i=await this.chain.incident(r.incident),q=(await this.chain.policy(i.policyId)).quote,d=i.decision;
    try{await assertSingleAutomaticIncident(this.chain,original.request);}catch(e){this.budget.audit('automatic_incident_scope_blocked',{request:original.request,reason:String(e)});throw e;}
    return this.withIntake(original.request,q,d,async()=>{
    if(d.decisionId!==r.decision_id||i.frozen||i.manualHold)throw new Error('DECISION_CHANGED_OR_MANUAL');
    await this.gate(q,d,i.assessment.assessor,true,i.manualHold);
    const now=Number((await this.chain.client.getBlock()).timestamp),amount=BigInt(amountString),paymentId=H({reservationId,requestId});
    await this.dependencies(i,BigInt(now));
    const cached=this.budget.get('SELECT * FROM signatures WHERE id=?',paymentId);
    if(cached){const p=typed('PaymentAuthorization',JSON.parse(cached.payload));if(p.amount!==amount)throw new Error('PAYMENT_CONFLICT');return {id:paymentId,action:'executePayment',args:[p,cached.signature]};}
    if(amount>i.D||BigInt(original.d.expiresAt)<=BigInt(now))throw new Error('PAYMENT_EXCEEDS_DUE_OR_EXPIRED');
    const p={paymentId,policyId:i.policyId,incidentId:r.incident,decisionVersion:i.version,decisionDigest:i.decisionDigest,token:q.token,beneficiary:q.beneficiary,amount,installmentIndex:i.installmentIndex+1n,
      grantId:d.grantId,grantEpoch:BigInt(d.grantEpoch),budgetVersion:BigInt(d.budgetVersion),reservationId:H({paymentId,purpose:'payment'}),supersedesPaymentId:zeroHash,signerEpoch:await this.chain.read('epochs',[this.actor]),expiresAt:BigInt(original.d.expiresAt)};
    this.budget.payment(paymentId,reservationId,amount,p,now);
    const sig=await this.chain.sign(this.actor,'PaymentAuthorization',p);this.budget.signature(paymentId,p,sig);
    return {id:paymentId,action:'executePayment',args:[p,sig]};
    });
  });}
  async reconcile(){return this.exclusive(()=>this.reconcileState());}
  private async reconcileState(checkConfiguration=true){
    this.budget.pause();await this.chain.check();if(checkConfiguration)await this.configurationProof();const tip=await this.chain.client.getBlockNumber({cacheTime:0}),height=tip-BigInt(this.confirmations-1);
    if(height<this.startBlock)throw new Error('WAIT_FOR_CONFIRMATIONS');
    const head=await this.chain.block(height);
    for(const release of this.budget.all('SELECT * FROM releases')){
      const canonical=BigInt(release.height)<=height&&(await this.chain.block(BigInt(release.height))).hash===release.block_hash;
      if(!canonical)this.budget.tx(()=>{this.budget.run("UPDATE reservations SET remaining=?,state='reserved' WHERE id=?",release.remaining,release.id);for(const p of JSON.parse(release.pending))this.budget.run("UPDATE payments SET state='reorg_pending' WHERE id=?",p);this.budget.run('DELETE FROM releases WHERE id=?',release.id);this.budget.audit('release_reorg_restored',{id:release.id});});
    }
    const logs=await this.chain.client.getLogs({address:this.chain.core,event:parseAbiItem('event PaymentExecuted(bytes32 indexed paymentId, bytes32 indexed incidentId, uint256 amount, uint256 paidTotal, uint256 due)'),fromBlock:this.startBlock,toBlock:height});
    const map=new Map(logs.map((e:any)=>[e.args.paymentId,e]));
    for(const p of this.budget.all('SELECT * FROM payments')){
      const log=map.get(p.id) as any;
      if(p.state==='confirmed'&&(!log||log.blockHash!==p.block_hash))this.budget.reorg(p.id);
      if(log){const b=await this.chain.block(log.blockNumber);if(b.hash!==log.blockHash||BigInt(p.amount)!==log.args.amount)throw new Error('CANONICAL_PAYMENT_MISMATCH');this.budget.confirmed(p.id,b.hash!,Number(b.timestamp));}
    }
    if((await this.chain.block(height)).hash!==head.hash)throw new Error('CHAIN_CHANGED_DURING_RECONCILIATION');
    this.budget.audit('reconcile',{height,hash:head.hash});this.budget.ready(Number((await this.chain.client.getBlock()).timestamp));
  }
  async releaseExpired(reservationId:string){return this.exclusive(async()=>{
    // Expiry is irreversible; pause/revocation alone can be undone and therefore cannot free funds.
    this.budget.pause();const tip=await this.chain.client.getBlockNumber({cacheTime:0}),height=tip-BigInt(this.confirmations-1),block=await this.chain.block(height);
    const r=this.budget.get('SELECT * FROM reservations WHERE id=?',reservationId);if(!r)throw new Error('RESERVATION_REQUIRED');
    const d=JSON.parse(r.payload).d;
    if(block.timestamp<=BigInt(d.expiresAt)||await this.chain.read('usedDecisionIds',[r.decision_id],height))throw new Error('EXECUTABLE_OR_REGISTERED_OBLIGATION');
    if((await this.chain.block(height)).hash!==block.hash)throw new Error('CHAIN_CHANGED');
    this.budget.tx(()=>{if(this.budget.get("SELECT id FROM payments WHERE reservation_id=? AND state NOT IN ('confirmed','released')",reservationId))throw new Error('PAYMENT_UNRESOLVED');this.budget.run('INSERT OR IGNORE INTO releases VALUES(?,?,?,?,?)',reservationId,height.toString(),block.hash,r.remaining,'[]');this.budget.run("UPDATE reservations SET remaining='0',state='released' WHERE id=?",reservationId);this.budget.audit('expired_release',{reservationId,height,hash:block.hash});});
  });}
  async reconfigure(config:Record<'enterprise'|'fde'|'riskGroup'|'GLOBAL',BudgetConfig>,grantIds:string[],historySince:number,migration?:{from:string;to:string}){return this.exclusive(async()=>{
    await this.reconcileState(false);this.budget.pause();
    const height=await this.chain.client.getBlockNumber({cacheTime:0})-BigInt(this.confirmations-1),block=await this.chain.block(height),registry=await this.chain.read('grantRegistry');
    const read=(name:string,args:any[])=>this.chain.client.readContract({address:registry,abi,functionName:name,args,blockNumber:height});
    for(const channel of [1,2])if(await read('approvalEnabled',[channel])||await read('paymentEnabled',[channel]))throw new Error('CONFIRMED_CHANNEL_PAUSE_REQUIRED');
    const observed=new Map<string,bigint>();
    for(const r of this.budget.all('SELECT payload FROM reservations')){const d=JSON.parse(r.payload).d;observed.set(d.grantId,BigInt(d.grantEpoch)> (observed.get(d.grantId)??0n)?BigInt(d.grantEpoch):observed.get(d.grantId)!);}
    for(const id of observed.keys())if(!grantIds.includes(id))throw new Error('ALL_SIGNED_GRANTS_REQUIRED');
    if(!grantIds.length)throw new Error('GRANT_REQUIRED');
    for(const id of grantIds){const g=await read('getGrant',[id]);if(g.epoch<1n||g.epoch<=(observed.get(id)??0n)||g.authorizer.toLowerCase()!==this.actor.toLowerCase())throw new Error('CONFIRMED_GRANT_EPOCH_BUMP_REQUIRED');
      for(const value of Object.values(config))if(BigInt(value.version)!==BigInt(g.budgetVersion))throw new Error('BUDGET_VERSION');}
    // This operation never releases outstanding amounts, even when old grants are invalidated.
    if((await this.chain.block(height)).hash!==block.hash)throw new Error('CHAIN_CHANGED');
    this.budget.configure(config,Number(block.timestamp),historySince,migration,{height,hash:block.hash!,grantIds});this.budget.audit('confirmed_config_gate',{height,hash:block.hash,grantIds});
  });}
  async releaseTransferred(reservationId:string){return this.exclusive(async()=>{
    this.budget.pause();await this.chain.check();const height=await this.chain.client.getBlockNumber({cacheTime:0})-BigInt(this.confirmations-1),block=await this.chain.block(height);
    const r=this.budget.get('SELECT * FROM reservations WHERE id=?',reservationId);if(!r)throw new Error('RESERVATION_REQUIRED');const d=JSON.parse(r.payload).d;
    const i=await this.chain.read('getIncident',[r.incident],height);
    if(block.timestamp<=BigInt(d.expiresAt)||i.version<=BigInt(d.version)||!i.manualHold||BigInt(i.decision.channel)!==0n)throw new Error('CONFIRMED_MANUAL_TAKEOVER_AND_EXPIRY_REQUIRED');
    const pending=this.budget.all("SELECT * FROM payments WHERE reservation_id=? AND state NOT IN ('confirmed','released')",reservationId);
    for(const p of pending){if(await this.chain.read('usedPaymentIds',[p.id],height))throw new Error('RECONCILE_PAYMENTS_FIRST');if(block.timestamp<=BigInt(JSON.parse(p.payload).expiresAt))throw new Error('SIGNATURE_STILL_EXECUTABLE');}
    if((await this.chain.block(height)).hash!==block.hash)throw new Error('CHAIN_CHANGED');
    this.budget.tx(()=>{this.budget.run('INSERT OR IGNORE INTO releases VALUES(?,?,?,?,?)',reservationId,height.toString(),block.hash,r.remaining,json(pending.map(p=>p.id)));for(const p of pending)this.budget.run("UPDATE payments SET state='released' WHERE id=?",p.id);this.budget.run("UPDATE reservations SET remaining='0',state='released' WHERE id=?",reservationId);this.budget.audit('manual_takeover_release',{reservationId,height,hash:block.hash,decision:i.decisionDigest});});
  });}
}
