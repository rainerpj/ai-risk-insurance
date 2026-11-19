import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import type {ModelCallRecord} from './openai-adapter.ts';

export type ModelPrice={version:string;model:string;input:string;cachedInput:string;output:string};
// Rates are micro-USD per million tokens. Amounts are estimated micro-USD, never insurer funds.
export type ModelSpendConfig={scope:string;price:ModelPrice;globalLimit:string;runLimit:string;runCalls:number;maxInputTokens:number};
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&(n as number)>=0;
const amount=(s:unknown):s is string=>typeof s==='string'&&/^(0|[1-9]\d{0,29})$/.test(s);
const identifier=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(s);
export function estimatedMicroUSD(p:ModelPrice,input:number,cached:number,output:number){
 if(![input,cached,output].every(integer)||cached>input||![p.input,p.cachedInput,p.output].every(amount))throw Error('MODEL_COST_SCHEMA');
 return ((BigInt(input-cached)*BigInt(p.input)+BigInt(cached)*BigInt(p.cachedInput)+BigInt(output)*BigInt(p.output)+999999n)/1000000n).toString();
}
export class ModelSpend {
 readonly db:DatabaseSync;readonly config:ModelSpendConfig;
 constructor(path:string,config:ModelSpendConfig,initialize=false){
  if(!identifier(config.scope)||!identifier(config.price.version)||!identifier(config.price.model)||![config.price.input,config.price.cachedInput,config.price.output,config.globalLimit,config.runLimit].every(amount)||BigInt(config.price.cachedInput)>BigInt(config.price.input)||!integer(config.runCalls)||config.runCalls<1||!integer(config.maxInputTokens)||config.maxInputTokens<1)throw Error('MODEL_COST_CONFIG');
  this.config=JSON.parse(JSON.stringify(config));
  Object.freeze(this.config.price);Object.freeze(this.config);
  if(!existsSync(path)&&!initialize)throw Error('MODEL_COST_DATABASE_MISSING');
  if(existsSync(path)&&initialize)throw Error('MODEL_COST_INITIALIZE_NEW_ONLY');
  this.db=new DatabaseSync(path);
  try{
   // Install the wait policy before journal/schema access can contend with another process.
   this.db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL');
   if(initialize){this.db.exec(`CREATE TABLE model_meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
    CREATE TABLE model_calls(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,digest TEXT NOT NULL,input_bound INTEGER NOT NULL,output_bound INTEGER NOT NULL,reserved TEXT NOT NULL,charged TEXT,state TEXT NOT NULL,record TEXT,created_at INTEGER NOT NULL,UNIQUE(run_id,ordinal));`);
    this.db.prepare('INSERT INTO model_meta VALUES(?,?)').run('config',JSON.stringify(this.config));
    this.db.prepare('INSERT INTO model_meta VALUES(?,?)').run('paused','0');
   }else{
    const tables=new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    if(!tables.has('model_meta')||!tables.has('model_calls')||this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw Error('MODEL_COST_SCHEMA');
    if(this.db.prepare("SELECT v FROM model_meta WHERE k='config'").get()?.v!==JSON.stringify(this.config))throw Error('MODEL_COST_CONFIG_MISMATCH');
   }
  }catch(e){this.db.close();throw e;}
 }
 private tx<T>(fn:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private rows(){return this.db.prepare('SELECT * FROM model_calls').all() as any[];}
 usage(runId?:string){const rows=this.rows().filter(r=>!runId||r.run_id===runId);return {estimatedMicroUSD:rows.reduce((n,r)=>n+BigInt(r.charged??r.reserved),0n).toString(),calls:rows.length,unknown:rows.filter(r=>r.state!=='settled').length};}
 /** Explicit run allowlist, derived from authenticated tenant jobs by the caller. Empty means no runs. */
 snapshot(runIds:readonly string[]){
  if(!Array.isArray(runIds)||runIds.some(id=>!identifier(id)))throw Error('MODEL_COST_RUN_FILTER');
  const allowed=new Set(runIds),rows=this.rows().filter(r=>allowed.has(r.run_id));
  let settled=0n,reserved=0n,input=0n,cached=0n,output=0n;let known=0;
  for(const row of rows){
   if(row.state==='settled'){
    settled+=BigInt(row.charged);const record=JSON.parse(row.record);
    input+=BigInt(record.inputTokens);cached+=BigInt(record.cachedInputTokens);output+=BigInt(record.outputTokens);known++;
   }else reserved+=BigInt(row.reserved);
  }
  return {currency:'USD',unit:'microUSD',basis:'frozen-price-estimate-not-provider-invoice',price:{...this.config.price},
   calls:rows.length,settledCalls:known,reservedCalls:rows.filter(r=>r.state==='reserved').length,unknownCalls:rows.filter(r=>r.state==='unknown').length,
   settledEstimatedMicroUSD:settled.toString(),unresolvedReservedMicroUSD:reserved.toString(),budgetOccupiedMicroUSD:(settled+reserved).toString(),
   tokens:{knownCalls:known,input:known?input.toString():null,cachedInput:known?cached.toString():null,output:known?output.toString():null},
   complete:known===rows.length};
 }
 reserve(runId:string,ordinal:number,digest:string,model:string,input:number,output:number){
  if(!identifier(runId)||!integer(ordinal)||ordinal<1||!/^[a-f0-9]{64}$/.test(digest)||model!==this.config.price.model||!integer(input)||input>this.config.maxInputTokens||!integer(output)||output<1||output>2000)throw Error('MODEL_COST_REQUEST');
  const id=runId+':'+ordinal,reserved=estimatedMicroUSD(this.config.price,input,0,output);
  return this.tx(()=>{
   if(this.db.prepare("SELECT v FROM model_meta WHERE k='paused'").get()?.v!=='0')throw Error('MODEL_COST_PAUSED');
   if(this.db.prepare('SELECT id FROM model_calls WHERE id=?').get(id))throw Error('MODEL_COST_REPLAY_FORBIDDEN');
   const global=this.usage(),run=this.usage(runId);
   if(this.rows().some(r=>r.run_id===runId&&r.state!=='settled'))throw Error('MODEL_COST_RUN_UNRESOLVED');
   if(BigInt(global.estimatedMicroUSD)+BigInt(reserved)>BigInt(this.config.globalLimit)||BigInt(run.estimatedMicroUSD)+BigInt(reserved)>BigInt(this.config.runLimit)||run.calls>=this.config.runCalls)throw Error('MODEL_COST_EXCEEDED');
   this.db.prepare('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?,NULL,\'reserved\',NULL,?)').run(id,runId,ordinal,digest,input,output,reserved,Date.now());
   return id;
  });
 }
 settle(id:string,record:ModelCallRecord){
  const overrun=this.tx(()=>{
   const row=this.db.prepare('SELECT * FROM model_calls WHERE id=?').get(id) as any;if(!row)throw Error('MODEL_COST_RESERVATION_MISSING');
   const encoded=JSON.stringify(record);
   if(row.record){if(row.record!==encoded)throw Error('MODEL_COST_SETTLEMENT_CONFLICT');return false;}
   const known=record.model===this.config.price.model&&record.responseModel===this.config.price.model&&integer(record.inputTokens)&&integer(record.outputTokens)&&integer(record.cachedInputTokens)&&record.cachedInputTokens<=record.inputTokens;
   const charged=known?estimatedMicroUSD(this.config.price,record.inputTokens!,record.cachedInputTokens!,record.outputTokens!):null;
   const over=known&&(record.inputTokens!>row.input_bound||record.outputTokens!>row.output_bound||BigInt(charged!)>BigInt(row.reserved));
   this.db.prepare('UPDATE model_calls SET charged=?,state=?,record=? WHERE id=?').run(charged,known?'settled':'unknown',encoded,id);
   if(over)this.db.prepare("UPDATE model_meta SET v='1' WHERE k='paused'").run();
   return over;
  });
  if(overrun)throw Error('MODEL_COST_OVERRUN');
 }
 close(){this.db.close();}
}
