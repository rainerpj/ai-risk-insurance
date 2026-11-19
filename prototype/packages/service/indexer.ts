import { assertBridge } from './incident-bridge-gate.ts';
import { Store, json } from './store.ts';
import { Chain, vaultAbi } from './chain.ts';
import {projectedClosures} from './closures.ts';
export class Indexer {
  busy = false;
  constructor(public store: Store, public chain: Chain, public startBlock: bigint, public confirmations=2, public lookback=64) {
    if(startBlock<0n || confirmations<1 || lookback<1) throw new Error('INVALID_INDEX_CONFIG');
    const config=json({startBlock,confirmations});
    if(store.getMeta('indexConfig') && store.getMeta('indexConfig')!==config) throw new Error('INDEX_CONFIG_MISMATCH');
    store.meta('indexConfig',config);
  }
  async rebuild() {
    this.store.tx(()=>{ this.store.run('UPDATE blocks SET canonical=0');this.store.run('UPDATE events SET canonical=0');this.store.run('DELETE FROM views');this.store.meta('halted','rebuilding'); });
    await this.sync(true);
  }
  async sync(rebuilding=false) {
    if(this.busy) return; this.busy=true;
    const s=this.store;
    try {
      await this.chain.check();
      if(s.getMeta('halted') && !rebuilding) return;
      const tip=await this.chain.client.getBlockNumber({cacheTime:0});
      let last=s.get('SELECT * FROM blocks WHERE canonical=1 ORDER BY number DESC LIMIT 1');
      if(last && (BigInt(last.number)>tip || (await this.chain.block(BigInt(last.number))).hash!==last.hash)) {
        let ancestor: any;
        for(const b of s.all('SELECT * FROM blocks WHERE canonical=1 ORDER BY number DESC LIMIT ?',this.lookback)) {
          if(BigInt(b.number)<=tip && (await this.chain.block(BigInt(b.number))).hash===b.hash) { ancestor=b;break; }
        }
        s.tx(()=>{
          const n=ancestor?.number ?? -1;
          s.run('UPDATE blocks SET canonical=0 WHERE number>?',n);s.run('UPDATE events SET canonical=0 WHERE number>?',n);
          s.run('DELETE FROM views');
          s.run("UPDATE outbox SET state='reorg_pending' WHERE state IN ('confirmed','mined','failed') AND receipt IS NOT NULL");
          if(!ancestor)s.meta('halted','NO_COMMON_ANCESTOR');
        });
        if(!ancestor)return; last=ancestor;
      }
      let parent=last?.hash;
      const pools=new Set<string>(s.all("SELECT payload FROM events WHERE canonical=1 AND name='PoolRegistered'").map(e=>JSON.parse(e.payload).pool));
      for(let n=last?BigInt(last.number)+1n:this.startBlock;n<=tip;n++) {
        const b=await this.chain.block(n), events=await this.chain.events(n,[...pools]);
        for(const e of events)if(e.name==='PoolRegistered')pools.add((e.payload as any).pool);
        if(parent && b.parentHash!==parent)throw new Error('CHAIN_CHANGED_DURING_SYNC');
        if(events.some((e:any)=>e.blockHash!==b.hash))throw new Error('LOG_BLOCK_MISMATCH');
        s.tx(()=>{
          s.run('INSERT INTO blocks VALUES(?,?,?,1) ON CONFLICT(hash) DO UPDATE SET canonical=1',b.hash,Number(n),b.parentHash);
          for(const e of events)s.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(block_hash,tx_hash,log_index) DO UPDATE SET canonical=1',b.hash,e.transactionHash,e.logIndex,Number(n),e.address,e.name,json(e.payload));
        }); parent=b.hash;
      }
      const confirmed=tip-BigInt(this.confirmations-1);
      if(confirmed>=this.startBlock)await this.project(confirmed);
      await this.reconcile(tip);
      s.meta('head',tip.toString());s.meta('confirmed',confirmed.toString());s.meta('halted','');s.meta('indexError','');
    } catch(e) { s.meta('indexError',(e as Error).message);throw e; } finally { this.busy=false; }
  }
  async project(height: bigint) {
    const s=this.store, block=await this.chain.block(height);
    const rows=s.all('SELECT name,payload FROM events WHERE canonical=1 AND number<=? ORDER BY number,log_index',Number(height));
    const policies=new Set<string>(),incidents=new Set<string>(),notices=new Set<string>(),pools=new Set<string>();
    for(const row of rows){const e=JSON.parse(row.payload);if(row.name==='PolicyIssued')policies.add(e.policyId);if(row.name==='DecisionRegistered')incidents.add(e.incidentId);if(row.name==='NoticeRegistered')notices.add(e.noticeId);if(row.name==='PoolRegistered')pools.add(e.pool);}
    const views:any[]=[];
    for(const id of policies){const p=await this.chain.read('getPolicy',[id],height);views.push(['policy',id,p.quote.enterpriseId,json(p)]);}
    for(const id of incidents){const i=await this.chain.read('getIncident',[id],height);const p=await this.chain.read('getPolicy',[i.policyId],height);views.push(['incident',id,p.quote.enterpriseId,json(i)]);}
    for(const id of notices){const n=await this.chain.read('getNotice',[id],height);const p=await this.chain.read('getPolicy',[n.data.policyId],height);views.push(['notice',id,p.quote.enterpriseId,json(n)]);}
    for(const id of pools){const p:any={};for(const name of ['balances','H','K','B','classifiedAssets'])p[name]=await this.chain.client.readContract({address:id,abi:vaultAbi,functionName:name,blockNumber:height});views.push(['pool',id,'staff',json(p)]);}
    const closures=await projectedClosures(s,this.chain,views,block);
    if((await this.chain.block(height)).hash!==block.hash)throw new Error('CHAIN_CHANGED_DURING_PROJECTION');
    // One observation instant for this atomic projection, including immediately settled decisions.
    const observedAt=Date.now();for(const row of closures)row[6]=observedAt;
    // Block-pinned chain reads are the authoritative reconciliation; never sum duplicate payment logs into money.
    s.tx(()=>{s.run('DELETE FROM views');for(const v of views)s.run('INSERT INTO views VALUES(?,?,?,?)',...v);
      s.run('UPDATE claim_closures SET active=0');for(const row of closures)s.run('INSERT INTO claim_closures VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=1',...row);
      // Wall-clock observation, not block time. Rebuilds/restarts preserve the first observation of this source.
      s.run("INSERT OR IGNORE INTO decision_observations SELECT block_hash,tx_hash,log_index,? FROM events WHERE canonical=1 AND name='DecisionRegistered' AND number<=?",observedAt,Number(height));
      s.meta('projectionHash',block.hash!);});
  }
  async reconcile(tip: bigint) {
    const s=this.store;
    for(const job of s.all('SELECT * FROM outbox')) {
      let r:any;
      if(job.tx_hash)try {r=await this.chain.client.getTransactionReceipt({hash:job.tx_hash});}catch(e:any){if(e.name!=='TransactionReceiptNotFoundError')throw e;}
      // Another relayer or same-nonce replacement may have executed the immutable business ID.
      if(!r){const mapping:Record<string,[string,string]>={submitNotice:['NoticeRegistered','noticeId'],executePayment:['PaymentExecuted','paymentId'],registerDecision:['DecisionRegistered','decisionId']};const match=mapping[job.action];
        if(match)for(const e of s.all('SELECT tx_hash,payload FROM events WHERE canonical=1 AND name=?',match[0]))if(JSON.parse(e.payload)[match[1]]===job.id){r=await this.chain.client.getTransactionReceipt({hash:e.tx_hash});break;}
      }
      if(!r){if(job.tx_hash||job.receipt)s.run("UPDATE outbox SET state=? WHERE id=?",job.receipt?'reorg_pending':'unknown',job.id);continue;}
      const canonical=(await this.chain.block(r.blockNumber)).hash===r.blockHash;
      const state=!canonical?'reorg_pending':tip-r.blockNumber+1n<BigInt(this.confirmations)?'mined':r.status==='success'?'confirmed':'failed';
      s.run('UPDATE outbox SET state=?,receipt=?,error=? WHERE id=?',state,json(r),state==='failed'?'TRANSACTION_REVERTED':null,job.id);
    }
  }
}
export class Worker {
  busy=false;
  constructor(public s:Store,public chain:Chain){}
  async tick() {
    if(this.busy || this.s.getMeta('halted') || this.s.getMeta('indexError'))return;this.busy=true;
    try{
      await this.chain.check();
      const blocked=new Set<string>();
      for(const job of this.s.all("SELECT * FROM outbox WHERE state NOT IN ('confirmed','failed') ORDER BY rowid")) {
        if(blocked.has(job.actor))continue;blocked.add(job.actor);
        if(job.state==='mined')continue;
        try{
          await assertBridge(this.s,'action',{action:job.action,args:JSON.parse(job.payload)});let raw=job.raw,txHash=job.tx_hash;
          if(!raw){const p=await this.chain.prepare(job.actor,job.action,JSON.parse(job.payload));raw=p.raw;txHash=p.txHash;
            this.s.run("UPDATE outbox SET raw=?,tx_hash=?,state='signed',error=NULL WHERE id=?",raw,txHash,job.id);
          }
          await assertBridge(this.s,'action',{action:job.action,args:JSON.parse(job.payload)});
          // Crash/timeout after broadcast leaves the SAME signed bytes and hash durable for retry.
          this.s.run("UPDATE outbox SET state='unknown' WHERE id=?",job.id);
          const result=await this.chain.client.sendRawTransaction({serializedTransaction:raw});
          if(result!==txHash)throw new Error('TRANSACTION_HASH_MISMATCH');
          this.s.run("UPDATE outbox SET state='submitted',error=NULL WHERE id=?",job.id);
        }catch(e:any){
          const reverted=!job.raw && /reverted|ContractFunctionRevertedError/.test(e.message);
          this.s.run('UPDATE outbox SET state=?,error=? WHERE id=?',reverted?'failed':this.s.get('SELECT raw FROM outbox WHERE id=?',job.id).raw?'unknown':'queued',String(e.shortMessage??e.message).slice(0,500),job.id);
        }
      }
    }finally{this.busy=false;}
  }
}

