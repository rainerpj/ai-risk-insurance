import {recoverMessageAddress} from 'viem';
import type {Reviewer} from './automatic.ts';
import type {Request} from './reviewer.ts';
import {H} from './reviewer.ts';
import {Store,json,hash} from './store.ts';
import {Chain,grantAbi} from './chain.ts';
import {zeroHash} from '../domain/typed-data.ts';

export const routingMessage=(payload:any)=>'FDE local routing observation v1\n'+json(payload);
function init(s:Store){s.db.exec('CREATE TABLE IF NOT EXISTS routing_observations(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,notice_id TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL)');}
/** Records entry into the configured service; does not claim successful review or approval. */
export async function observeRouting(s:Store,worker:Reviewer,request:Request){
 init(s);
 if(!request||![request.policyId,request.noticeId,request.grantId].every(v=>typeof v==='string'&&/^0x[a-f0-9]{64}$/.test(v))||!Array.isArray(request.refs)||request.refs.some(r=>typeof r!=='string'||!/^[a-f0-9]{64}$/.test(r)))throw Error('ROUTING_REQUEST_SCHEMA');
 const chain=worker.chain;await chain.check();const head=await chain.client.getBlock(),notice=await chain.read('getNotice',[request.noticeId],head.number),policy=await chain.read('getPolicy',[request.policyId],head.number),registry=await chain.read('grantRegistry',[],head.number);
 const g:any=await chain.client.readContract({address:registry,abi:grantAbi,functionName:'getGrant',args:[request.grantId],blockNumber:head.number});
 if(!policy.issuedAt||notice.digest===zeroHash||notice.data.policyId!==request.policyId||notice.data.evidenceHash!==H(request.refs)||g.enterpriseId!==policy.quote.enterpriseId||g.reviewer.toLowerCase()!==worker.actor.toLowerCase()||![1,2].includes(Number(g.channel))||g.templateId!==worker.originals.trust.templateId||g.ruleVersion!==worker.originals.trust.ruleVersion||g.modelVersion!==worker.originals.trust.modelVersion)throw Error('ROUTING_SCOPE_MISMATCH');
 const payload={kind:'routing-observation-v1',scope:s.getMeta('scope'),deploymentId:chain.deploymentId,core:chain.core,tenant:policy.quote.enterpriseId,noticeId:request.noticeId,policyId:request.policyId,noticeDigest:notice.digest,grantId:request.grantId,grantEpoch:g.epoch.toString(),channel:Number(g.channel),templateId:g.templateId,ruleVersion:g.ruleVersion,modelVersion:g.modelVersion,reviewer:worker.actor.toLowerCase(),authorizer:g.authorizer.toLowerCase(),block:head.number.toString(),blockHash:head.hash,requestHash:hash(request)};
 const id=H(payload),signature=await chain.wallet(worker.actor).account.signMessage({message:routingMessage(payload)});
 if((await chain.block(head.number)).hash!==head.hash)throw Error('CHAIN_CHANGED');
 s.tx(()=>{s.run('INSERT INTO routing_observations VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,payload.tenant,request.noticeId,json(payload),signature);});return {id,payload,signature};
}
export function routingObservations(s:Store,tenant:string){init(s);return {scope:s.getMeta('scope'),tenant,observations:s.all('SELECT id,payload,signature FROM routing_observations WHERE tenant=? ORDER BY rowid DESC',tenant).map(r=>({...r,payload:JSON.parse(r.payload)}))};}
/** Verify historical Grant and chain snapshot, never substitute the current Grant configuration. */
export async function verifyRoutingProof(chain:Chain,scope:string,tenant:string,noticeId:string,proof:any){
 const p=proof?.payload;
 if(!p||p.kind!=='routing-observation-v1'||p.scope!==scope||p.tenant!==tenant||p.noticeId!==noticeId||p.deploymentId!==chain.deploymentId||p.core.toLowerCase()!==chain.core.toLowerCase()||proof.id!==H(p))throw Error('ROUTING_PROOF_SCOPE');
 await chain.check();const block=await chain.block(BigInt(p.block));if(block.hash!==p.blockHash)throw Error('ROUTING_PROOF_REORGED');
 const n=await chain.read('getNotice',[noticeId],block.number),policy=await chain.read('getPolicy',[p.policyId],block.number),registry=await chain.read('grantRegistry',[],block.number);
 const g:any=await chain.client.readContract({address:registry,abi:grantAbi,functionName:'getGrant',args:[p.grantId],blockNumber:block.number});
 if(n.digest!==p.noticeDigest||n.data.policyId!==p.policyId||policy.quote.enterpriseId!==tenant||g.enterpriseId!==tenant||g.epoch.toString()!==p.grantEpoch||Number(g.channel)!==p.channel||g.templateId!==p.templateId||g.ruleVersion!==p.ruleVersion||g.modelVersion!==p.modelVersion||g.reviewer.toLowerCase()!==p.reviewer||g.authorizer.toLowerCase()!==p.authorizer||(await recoverMessageAddress({message:routingMessage(p),signature:proof.signature})).toLowerCase()!==p.reviewer)throw Error('ROUTING_PROOF_INVALID');
 if((await chain.block(block.number)).hash!==p.blockHash)throw Error('ROUTING_PROOF_REORGED');return p;
}

