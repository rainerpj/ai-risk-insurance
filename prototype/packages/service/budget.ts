import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {json} from './store.ts';
export type Dimensions={deploymentId:string;insurerId:string;token:string;enterpriseId:string;fdeId:string;riskGroupId:string};
export type BudgetConfig={version:string;window:number;amount:string;count:number};
const dimensions=['enterprise','fde','riskGroup','GLOBAL'] as const;
/** Reuse the authorizer's exact rolling accounting for read-only governance observers. */
export function readBudgetUsage(reader:Pick<Budget,'get'|'all'>,d:Dimensions,now:number){
  return Budget.prototype.usage.call({get:reader.get.bind(reader),all:reader.all.bind(reader),same:Budget.prototype.same} as Budget,d,now);
}
export class Budget {
  db:DatabaseSync;
  constructor(path:string,scope:string,initialize=false){
    if(!existsSync(path)&&!initialize)throw new Error('BUDGET_DATABASE_MISSING');
    if(existsSync(path)&&initialize)throw new Error('BUDGET_INITIALIZATION_REQUIRES_NEW_DATABASE');
    this.db=new DatabaseSync(path);
    // An existing database must not silently recreate a lost monetary table.
    if(!initialize){
      const required=['meta','limits','reservations','expenses','payments','releases','jobs','signatures','risk_groups','history'];
      const present=new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
      if(required.some(name=>!present.has(name))){this.db.close();throw new Error('BUDGET_SCHEMA_MISSING');}
      if(this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok'){this.db.close();throw new Error('BUDGET_INTEGRITY_FAILED');}
    }
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS limits(dimension TEXT PRIMARY KEY,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,decision_id TEXT UNIQUE NOT NULL,incident TEXT NOT NULL,dims TEXT NOT NULL,amount TEXT NOT NULL,remaining TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_obligation_per_incident ON reservations(incident);
      CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,amount TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,paid_at INTEGER,block_hash TEXT,tx_hash TEXT,raw TEXT);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,height TEXT NOT NULL,block_hash TEXT NOT NULL,remaining TEXT NOT NULL,pending TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,request TEXT NOT NULL,envelope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signatures(id TEXT PRIMARY KEY,payload TEXT NOT NULL,signature TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS risk_groups(model TEXT PRIMARY KEY,group_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,action TEXT NOT NULL,payload TEXT NOT NULL);
    `);
    if(!initialize&&!this.meta('scope')){this.db.close();throw new Error('BUDGET_SCHEMA_MISSING');}
    if(this.meta('scope')&&this.meta('scope')!==scope){this.db.close();throw new Error('BUDGET_DEPLOYMENT_MISMATCH');}
    this.set('scope',scope);this.set('ready','0'); // Every process restart requires chain reconciliation before signing.
  }
  get(sql:string,...args:any[]):any{return this.db.prepare(sql).get(...args);}
  all(sql:string,...args:any[]):any[]{return this.db.prepare(sql).all(...args);}
  run(sql:string,...args:any[]){return this.db.prepare(sql).run(...args);}
  meta(k:string){return this.get('SELECT v FROM meta WHERE k=?',k)?.v as string|undefined;}
  set(k:string,v:string){this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',k,v);}
  tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');if((e as Error).message==='CLOCK_RECONCILIATION_REQUIRED')this.pause();throw e;}}
  audit(action:string,payload:unknown){this.run('INSERT INTO history(action,payload) VALUES(?,?)',action,json(payload));}
  clock(now:number){const previous=Number(this.meta('clock')??now);if(!Number.isSafeInteger(now)||now<previous||now-previous>3600){this.set('ready','0');throw new Error('CLOCK_RECONCILIATION_REQUIRED');}this.set('clock',String(now));}
  ready(now:number){this.set('clock',String(now));this.set('ready','1');}
  pause(){this.set('ready','0');}
  configure(config:Record<typeof dimensions[number],BudgetConfig>,now:number,historySince:number,migration?:{from:string;to:string},proof?:{height:bigint;hash:string;grantIds:string[]}){
    this.tx(()=>{if(this.meta('ready')==='1')throw new Error('PAUSE_BEFORE_CONFIG_CHANGE');if(!Number.isSafeInteger(now)||!Number.isSafeInteger(historySince)||historySince<0)throw new Error('CONFIG_OR_HISTORY_INVALID');for(const dim of dimensions){const c=config[dim];if(!c||!/^[1-9]\d*$/.test(c.version)||!Number.isSafeInteger(c.window)||c.window<1||!/^[1-9]\d*$/.test(c.amount)||!Number.isSafeInteger(c.count)||c.count<1||historySince>now-c.window)throw new Error('CONFIG_OR_HISTORY_INVALID');
      const old=this.get('SELECT config FROM limits WHERE dimension=?',dim);if(old&&BigInt(c.version)<=BigInt(JSON.parse(old.config).version))throw new Error('CONFIG_VERSION_NOT_INCREASING');
      this.run('INSERT INTO limits VALUES(?,?) ON CONFLICT(dimension) DO UPDATE SET config=excluded.config',dim,json(c));}
      if(migration)this.moveGroup(migration.from,migration.to);if(proof)this.set('configurationProof',json(proof));this.audit('config',config);});
  }
  mapModel(model:string,group:string){if(this.meta('ready')==='1')throw new Error('PAUSE_BEFORE_MAPPING');const old=this.get('SELECT group_id FROM risk_groups WHERE model=?',model);if(old&&old.group_id!==group)throw new Error('USE_RISK_GROUP_MIGRATION');this.run('INSERT OR IGNORE INTO risk_groups VALUES(?,?)',model,group);}
  group(model:string){const value=this.get('SELECT group_id FROM risk_groups WHERE model=?',model)?.group_id;if(!value)throw new Error('UNREGISTERED_RISK_GROUP');return value as string;}
  migrateGroup(from:string,to:string){if(this.meta('ready')==='1')throw new Error('PAUSE_BEFORE_MAPPING');this.tx(()=>this.moveGroup(from,to));}
  private moveGroup(from:string,to:string){if(!from||!to||from===to)throw new Error('RISK_GROUP_MIGRATION_INVALID');for(const r of this.all('SELECT id,dims FROM reservations')){const d=JSON.parse(r.dims);if(d.riskGroupId===from){d.riskGroupId=to;this.run('UPDATE reservations SET dims=? WHERE id=?',json(d),r.id);}}this.run('UPDATE risk_groups SET group_id=? WHERE group_id=?',to,from);this.audit('risk_group_migration',{from,to});}

  same(a:Dimensions,b:Dimensions,dim:string){return a.deploymentId===b.deploymentId&&a.insurerId===b.insurerId&&a.token.toLowerCase()===b.token.toLowerCase()&&(dim==='GLOBAL'||(a as any)[dim+'Id']===(b as any)[dim+'Id']);}
  usage(d:Dimensions,now:number){const result:Record<string,{amount:bigint;count:number;limit:BudgetConfig}>={};
    for(const dimension of dimensions){const row=this.get('SELECT config FROM limits WHERE dimension=?',dimension);if(!row)throw new Error('BUDGET_NOT_CONFIGURED');const limit=JSON.parse(row.config) as BudgetConfig;let amount=0n,count=0;
      for(const r of this.all('SELECT * FROM reservations'))if(this.same(d,JSON.parse(r.dims),dimension)){
        amount+=BigInt(r.remaining);
        for(const p of this.all('SELECT * FROM payments WHERE reservation_id=?',r.id)){
          if(p.state==='confirmed'){if(p.paid_at>now-limit.window&&p.paid_at<=now){amount+=BigInt(p.amount);count++;}}
          else if(p.state!=='released')count++;
        }
      }result[dimension]={amount,count,limit};
    }return result;
  }
  assertAvailable(d:Dimensions,now:number,amount:bigint,count:number){for(const u of Object.values(this.usage(d,now)))if(u.amount+amount>BigInt(u.limit.amount)||u.count+count>u.limit.count)throw new Error('ROLLING_BUDGET_EXCEEDED');}
  reserve(id:string,decisionId:string,incident:string,d:Dimensions,amount:bigint,payload:unknown,now:number,expenseKey?:string|string[]){
    return this.tx(()=>{this.clock(now);if(this.meta('ready')!=='1')throw new Error('RECONCILIATION_REQUIRED');const old=this.get('SELECT * FROM reservations WHERE id=?',id);if(old){if(old.payload!==json(payload)||old.decision_id!==decisionId||old.dims!==json(d)||BigInt(old.amount)!==amount)throw new Error('RESERVATION_CONFLICT');const expected=expenseKey===undefined?[]:Array.isArray(expenseKey)?expenseKey:[expenseKey];const stored=this.all('SELECT id FROM expenses WHERE reservation_id=?',id).map(e=>e.id);if(json([...expected].sort())!==json(stored.sort()))throw new Error('EXPENSE_SET_CONFLICT');return old;}
      const keys=expenseKey===undefined?[]:Array.isArray(expenseKey)?expenseKey:[expenseKey];if(new Set(keys).size!==keys.length)throw new Error('DUPLICATE_EXPENSE');
      for(const key of keys){const e=this.get('SELECT * FROM expenses WHERE id=?',key);if(e&&e.reservation_id!==id)throw new Error('EXPENSE_ALREADY_USED');this.run('INSERT OR IGNORE INTO expenses VALUES(?,?)',key,id);}
      if(amount<0n)throw new Error('NEGATIVE_RESERVATION');this.assertAvailable(d,now,amount,0);
      this.run("INSERT INTO reservations VALUES(?,?,?,?,?,?,?,'reserved')",id,decisionId,incident,json(d),amount.toString(),amount.toString(),json(payload));this.audit('reserve',{id,decisionId,amount,d});return this.get('SELECT * FROM reservations WHERE id=?',id);});
  }
  payment(id:string,reservationId:string,amount:bigint,payload:unknown,now:number){
    return this.tx(()=>{this.clock(now);if(this.meta('ready')!=='1')throw new Error('RECONCILIATION_REQUIRED');const old=this.get('SELECT * FROM payments WHERE id=?',id);if(old){if(old.payload!==json(payload)||old.reservation_id!==reservationId||BigInt(old.amount)!==amount)throw new Error('PAYMENT_CONFLICT');return old;}
      const r=this.get('SELECT * FROM reservations WHERE id=?',reservationId);if(!r||r.state==='released')throw new Error('RESERVATION_REQUIRED');
      // One executable installment per obligation. Unknown/reorg/failed attempts retain their slot.
      if(this.get("SELECT id FROM payments WHERE reservation_id=? AND state NOT IN ('confirmed','released')",reservationId))throw new Error('PAYMENT_UNRESOLVED');
      if(amount<=0n||amount>BigInt(r.remaining))throw new Error('PAYMENT_EXCEEDS_RESERVATION');this.assertAvailable(JSON.parse(r.dims),now,0n,1);
      this.run("INSERT INTO payments(id,reservation_id,amount,payload,state) VALUES(?,?,?,?,'reserved')",id,reservationId,amount.toString(),json(payload));this.audit('payment_reserved',{id,reservationId,amount});return this.get('SELECT * FROM payments WHERE id=?',id);});
  }
  signature(id:string,payload:unknown,signature:string){this.tx(()=>{const old=this.get('SELECT * FROM signatures WHERE id=?',id);if(old&&(old.payload!==json(payload)||old.signature!==signature))throw new Error('SIGNED_PAYLOAD_CONFLICT');this.run('INSERT OR IGNORE INTO signatures VALUES(?,?,?)',id,json(payload),signature);});}
  confirmed(id:string,blockHash:string,time:number){this.tx(()=>{const p=this.get('SELECT * FROM payments WHERE id=?',id);if(!p)throw new Error('PAYMENT_NOT_FOUND');if(p.state==='released')throw new Error('RELEASED_PAYMENT_CONFIRMED');if(p.state==='confirmed'){if(p.block_hash!==blockHash||p.paid_at!==time)throw new Error('REORG_REQUIRED');return;}
    const r=this.get('SELECT * FROM reservations WHERE id=?',p.reservation_id);if(BigInt(r.remaining)<BigInt(p.amount))throw new Error('RESERVATION_UNDERFLOW');this.run('UPDATE reservations SET remaining=? WHERE id=?',(BigInt(r.remaining)-BigInt(p.amount)).toString(),r.id);this.run("UPDATE payments SET state='confirmed',block_hash=?,paid_at=? WHERE id=?",blockHash,time,id);this.audit('confirmed',{id,blockHash,time});});}
  reorg(id:string){this.tx(()=>{const p=this.get('SELECT * FROM payments WHERE id=?',id);if(!p)throw new Error('PAYMENT_NOT_FOUND');if(p.state==='confirmed'){const r=this.get('SELECT * FROM reservations WHERE id=?',p.reservation_id);this.run('UPDATE reservations SET remaining=? WHERE id=?',(BigInt(r.remaining)+BigInt(p.amount)).toString(),r.id);}this.run("UPDATE payments SET state='reorg_pending',paid_at=NULL,block_hash=NULL WHERE id=?",id);this.audit('reorg',{id});});}
  migrateDecision(id:string,newDecisionId:string,payload:unknown){this.tx(()=>{const r=this.get('SELECT * FROM reservations WHERE id=?',id);if(!r||this.get("SELECT id FROM payments WHERE reservation_id=? AND state NOT IN ('confirmed','released')",id))throw new Error('UNRESOLVED_MIGRATION');this.run('UPDATE reservations SET decision_id=?,payload=? WHERE id=?',newDecisionId,json(payload),id);this.audit('decision_migration',{id,newDecisionId});});}
  // Only the authorizer's chain reconciliation calls this; never exposed as a caller-supplied boolean API.
  release(id:string){this.tx(()=>{if(this.get("SELECT id FROM payments WHERE reservation_id=? AND state NOT IN ('confirmed','released')",id))throw new Error('PAYMENT_UNRESOLVED');this.run("UPDATE reservations SET remaining='0',state='released' WHERE id=?",id);this.audit('release',{id});});}
  close(){this.db.close();}
}
