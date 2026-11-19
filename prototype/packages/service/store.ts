import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from '../domain/evidence.ts';
export const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
export const hash = (v: unknown) => createHash('sha256').update(canonicalize(json(v))).digest('hex');
export class Fault extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export class Store {
  db: DatabaseSync;
  constructor(path: string, scope: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identities(address TEXT PRIMARY KEY,tenant TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,address TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,address TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,received_at TEXT NOT NULL,binding TEXT,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,notice_id TEXT NOT NULL REFERENCES notices(id),tenant TEXT NOT NULL,content BLOB NOT NULL,digest TEXT NOT NULL,media_type TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,incident TEXT NOT NULL,actor TEXT NOT NULL,role TEXT NOT NULL,reason TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_reviews(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,incident TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,pause_job TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_cases(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES quality_reviews(id),tenant TEXT NOT NULL,incident TEXT NOT NULL,decision_version TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_resolutions(id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES quality_cases(id),tenant TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_measurements(id TEXT PRIMARY KEY,review_id TEXT NOT NULL UNIQUE REFERENCES quality_reviews(id),tenant TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_measurements(id TEXT PRIMARY KEY,notice_id TEXT NOT NULL REFERENCES notices(id),tenant TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_quality(id TEXT PRIMARY KEY,notice_id TEXT NOT NULL REFERENCES notices(id),tenant TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_resolutions(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES intake_quality(id),tenant TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_followups(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL REFERENCES intake_quality(id),tenant TEXT NOT NULL,incident TEXT NOT NULL,decision_version TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quality_samples(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,incident TEXT NOT NULL,decision_version TEXT NOT NULL,payload TEXT NOT NULL,canonical INTEGER NOT NULL,selected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,payload TEXT NOT NULL,signatures TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signed_messages(digest TEXT NOT NULL,actor TEXT NOT NULL,tenant TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(digest,actor));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,state TEXT NOT NULL,raw TEXT,tx_hash TEXT,receipt TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS blocks(hash TEXT PRIMARY KEY,number INTEGER NOT NULL,parent TEXT NOT NULL,canonical INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_canonical_height ON blocks(number) WHERE canonical=1;
      CREATE TABLE IF NOT EXISTS events(block_hash TEXT NOT NULL,tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,number INTEGER NOT NULL,address TEXT NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,canonical INTEGER NOT NULL,PRIMARY KEY(block_hash,tx_hash,log_index));
      CREATE TABLE IF NOT EXISTS decision_observations(block_hash TEXT NOT NULL,tx_hash TEXT NOT NULL,log_index INTEGER NOT NULL,confirmed_observed_at INTEGER NOT NULL,PRIMARY KEY(block_hash,tx_hash,log_index));
      CREATE TABLE IF NOT EXISTS claim_closures(id TEXT PRIMARY KEY,incident TEXT NOT NULL,tenant TEXT NOT NULL,version TEXT NOT NULL,payload TEXT NOT NULL,automatic INTEGER,observed_at INTEGER NOT NULL,active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS views(kind TEXT NOT NULL,id TEXT NOT NULL,tenant TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    if (this.getMeta('schema') && this.getMeta('schema') !== '1') {this.db.close();throw new Error('UNSUPPORTED_SCHEMA');}
    if (this.getMeta('scope') && this.getMeta('scope') !== scope) {this.db.close();throw new Error('DEPLOYMENT_MISMATCH');}
    this.meta('schema','1'); this.meta('scope',scope);
    if(!this.getMeta('timingStartedAt'))this.meta('timingStartedAt',String(Date.now()));
  }
  get(sql: string, ...args: any[]): any { return this.db.prepare(sql).get(...args); }
  all(sql: string, ...args: any[]): any[] { return this.db.prepare(sql).all(...args); }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  getMeta(key: string): string | undefined { return this.get('SELECT value FROM meta WHERE key=?',key)?.value; }
  meta(key: string,value: string) { this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value); }
  audit(actor: string,action: string,target: string) { this.run('INSERT INTO audit VALUES(?,?,?,?,?)',randomUUID(),actor,action,target,new Date().toISOString()); }
  close() { this.db.close(); }
}
