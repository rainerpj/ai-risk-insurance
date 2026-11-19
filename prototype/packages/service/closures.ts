import {hash,json,Store} from './store.ts';
import {Chain} from './chain.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {historicalDecision} from './quality.ts';

/** Confirmed settlement closure, not a release of coverage/capital. Invoked by the indexer at its pinned checkpoint. */
export async function projectedClosures(s:Store,chain:Chain,views:any[],head:any){
 const events=s.all('SELECT * FROM events WHERE canonical=1 AND number<=? ORDER BY number,log_index',Number(head.number)).map(e=>({...e,data:JSON.parse(e.payload)}));
 const result:any[]=[];
 for(const [kind,id,tenant,payload] of views){
  if(kind!=='incident')continue;const i=JSON.parse(payload);
  if(BigInt(i.D)!==0n||BigInt(i.Q)!==0n||i.frozen||i.activeDispute!==zeroHash)continue;
  const related=events.filter(e=>e.data.incidentId===id),source=related.at(-1);if(!source)continue;
  let automatic:number|null=0;
  if([1,2].includes(Number(i.decision.channel))&&!i.manualHold){
   const versions=related.filter(e=>e.name==='DecisionRegistered');
   automatic=versions.length===Number(i.version)&&versions.every((e,n)=>BigInt(e.data.version)===BigInt(n+1))?1:null;
   if(automatic===1)for(const e of versions){
    try{const h=await historicalDecision(chain,id,String(e.data.version),head);if(![1,2].includes(Number(h.i.decision.channel))){automatic=0;break;}}
    catch{automatic=null;break;}
   }
  }
  const proof={incidentId:id,decisionVersion:i.version,decisionDigest:i.decisionDigest,incidentStateHash:hash(i),source:{blockHash:source.block_hash,txHash:source.tx_hash,logIndex:source.log_index},basis:'confirmed-settlement-v1',automatic};
  result.push([hash(proof),id,tenant,String(i.version),json(proof),automatic,Date.now(),1]);
 }
 return result;
}
