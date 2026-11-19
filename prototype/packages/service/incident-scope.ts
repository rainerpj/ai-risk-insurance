import {parseAbiItem} from 'viem';
import type {Chain} from './chain.ts';
import type {Request} from './reviewer.ts';

/** A notice commitment is the available same-incident key, not a claim of semantic identity.
 * Multiple separately submitted notices require human aggregation before automatic authorization.
 * An explicitly verified supplement may retain its original notice in the request. */
export async function assertSingleAutomaticIncident(chain:Chain,request:Request){
 const head=await chain.client.getBlock();
 const current=await chain.read('getNotice',[request.noticeId],head.number);
 const allowed=new Set<string>([request.noticeId,...(request.previousEvidence?[request.previousEvidence.noticeId]:[])]);
 const logs=await chain.client.getLogs({address:chain.core,event:parseAbiItem('event NoticeRegistered(bytes32 indexed noticeId, bytes32 indexed policyId, bytes32 digest, uint64 receivedAt)'),args:{policyId:request.policyId},fromBlock:0n,toBlock:head.number});
 const related:string[]=[];
 for(const log of logs){
  const noticeId=log.args.noticeId as string;if(allowed.has(noticeId))continue;
  const notice=await chain.read('getNotice',[noticeId],head.number);
  if(notice.data.policyId===request.policyId&&notice.data.incidentCommitment===current.data.incidentCommitment)related.push(noticeId);
 }
 if((await chain.block(head.number)).hash!==head.hash)throw Error('CHAIN_CHANGED');
 if(related.length)throw Error('MANUAL_AGGREGATION_REQUIRED:'+JSON.stringify({policyId:request.policyId,noticeId:request.noticeId,related:[...new Set(related)].sort()}));
}
