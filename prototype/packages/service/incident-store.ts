import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { canonicalize } from '../domain/evidence.ts';
import { IncidentFault, requireIncident, identifier, parseWorkflow, parseRun, parseIncident, type Actor, type Grant, type Role, type Workflow, type AgentRun, type Incident } from '../domain/incident-schema.ts';

const APPLICATION_ID = 0x494e4331;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const roles: Role[] = ['enterprise_admin','collector','investigator','reviewer','viewer','fde'];
type Kind = 'workflow' | 'run' | 'incident';
type RecordValue = Workflow | AgentRun | Incident;
const writes: Record<Kind, Role[]> = { workflow: ['enterprise_admin'], run: ['enterprise_admin','collector','fde'], incident: ['enterprise_admin','collector','investigator','fde'] };

/** Independent local-only store; never opens or migrates the insurance Store schema. */
export class IncidentStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      const appId = Number(this.db.prepare('PRAGMA application_id').get()!.application_id);
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      const tables = Number(this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()!.n);
      if (appId === 0 && version === 0 && tables === 0) {
        this.db.exec(`
          CREATE TABLE migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE accounts(actor_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, enabled INTEGER NOT NULL);
          CREATE TABLE grants(actor_id TEXT NOT NULL REFERENCES accounts(actor_id), project_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(actor_id,project_id,role));
          CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES accounts(actor_id), expires_at INTEGER NOT NULL);
          CREATE TABLE records(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,payload TEXT NOT NULL);
          CREATE INDEX records_scope ON records(tenant_id,project_id,kind,seq);
          CREATE TABLE requests(tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,actor_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,payload_hash TEXT NOT NULL,record_id TEXT NOT NULL REFERENCES records(id),PRIMARY KEY(tenant_id,project_id,actor_id,operation,key));
          CREATE TABLE audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1;
        `);
        this.db.prepare('INSERT INTO migrations VALUES(1,?)').run(new Date().toISOString());
      } else {
        requireIncident(appId === APPLICATION_ID, 'NOT_INCIDENT_DATABASE', 409);
        requireIncident(version === 1 || version === 2, 'UNSUPPORTED_DATABASE_SCHEMA', 409);
        requireIncident(this.db.prepare('SELECT version FROM migrations WHERE version=1').get(), 'INVALID_MIGRATION_HISTORY', 409);
      }
      if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) === 1) {
        this.db.exec(`
          CREATE TABLE incident_sources(id TEXT NOT NULL,tenant TEXT NOT NULL,project TEXT NOT NULL,payload TEXT NOT NULL,revoked_at TEXT,revocation_reason TEXT,PRIMARY KEY(tenant,project,id));
          CREATE TABLE incident_imports(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,project TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES records(id),package_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(tenant,project,package_id));
          CREATE TABLE incident_objects(tenant TEXT NOT NULL,project TEXT NOT NULL,id TEXT NOT NULL,descriptor TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(tenant,project,id));
          CREATE TABLE incident_import_keys(tenant TEXT NOT NULL,project TEXT NOT NULL,actor TEXT NOT NULL,key TEXT NOT NULL,digest TEXT NOT NULL,import_id TEXT NOT NULL REFERENCES incident_imports(id),PRIMARY KEY(tenant,project,actor,key));
          CREATE INDEX incident_import_runs ON incident_imports(tenant,project,run_id);
          PRAGMA user_version=2;
        `);
        this.db.prepare('INSERT INTO migrations VALUES(2,?)').run(new Date().toISOString());
      }
      requireIncident(this.db.prepare('SELECT version FROM migrations WHERE version=2').get(),'INVALID_MIGRATION_HISTORY',409);
      this.db.exec('COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    } catch (e) { try { this.db.exec('ROLLBACK'); } catch {} this.db.close(); throw e; }
  }
  close() { this.db.close(); }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(actor: string, action: string, target: string) { this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(),actor,action,target,new Date().toISOString()); }
  /** Trusted local provisioning only; deliberately no HTTP account/grant administration. */
  provision(actorId: string, tenantId: string, password: string, grants: Grant[], enabled = true) {
    requireIncident(identifier(actorId) && identifier(tenantId) && typeof password === 'string' && password.length >= 16 && password.length <= 256 && grants.length <= 100 && grants.every(g => identifier(g.projectId) && roles.includes(g.role)));
    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(password,salt,32).toString('hex');
    this.tx(() => {
      const old = this.db.prepare('SELECT tenant_id FROM accounts WHERE actor_id=?').get(actorId);
      requireIncident(!old || old.tenant_id === tenantId, 'ACCOUNT_TENANT_IMMUTABLE',409);
      this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash,enabled=excluded.enabled').run(actorId,tenantId,salt,passwordHash,Number(enabled));
      this.db.prepare('DELETE FROM grants WHERE actor_id=?').run(actorId);
      for (const g of grants) this.db.prepare('INSERT INTO grants VALUES(?,?,?)').run(actorId,g.projectId,g.role);
      this.db.prepare('DELETE FROM sessions WHERE actor_id=?').run(actorId);
      this.audit(actorId,'provision',actorId);
    });
  }
  login(actorId: string, password: string): { token: string; expiresAt: number } {
    requireIncident(identifier(actorId) && typeof password === 'string' && password.length <= 256, 'AUTH_REQUIRED',401);
    const account = this.db.prepare('SELECT * FROM accounts WHERE actor_id=?').get(actorId);
    const candidate = scryptSync(password,String(account?.salt ?? 'unregistered-account-salt'),32);
    const expected = account ? Buffer.from(String(account.password_hash),'hex') : Buffer.alloc(32);
    requireIncident(timingSafeEqual(candidate,expected) && account?.enabled === 1, 'AUTH_REQUIRED',401);
    const token = randomBytes(32).toString('hex'), expiresAt = Date.now() + 60 * 60 * 1000;
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),actorId,expiresAt);
    return { token, expiresAt };
  }
  authenticate(token: string): Actor {
    requireIncident(/^[0-9a-f]{64}$/.test(token), 'AUTH_REQUIRED',401);
    const row = this.db.prepare('SELECT a.actor_id,a.tenant_id FROM sessions s JOIN accounts a ON a.actor_id=s.actor_id WHERE s.token_hash=? AND s.expires_at>? AND a.enabled=1').get(digest(token),Date.now());
    requireIncident(row, 'AUTH_REQUIRED',401);
    return {actorId: String(row.actor_id),tenantId: String(row.tenant_id)};
  }
  logout(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token)); }
  authorize(actor: Actor, projectId: string, allowed?: Role[]) {
    requireIncident(identifier(projectId));
    const account = this.db.prepare('SELECT tenant_id,enabled FROM accounts WHERE actor_id=?').get(actor.actorId);
    requireIncident(account?.enabled === 1 && account.tenant_id === actor.tenantId,'AUTH_REQUIRED',401);
    const grants = this.db.prepare('SELECT role FROM grants WHERE actor_id=? AND project_id=?').all(actor.actorId,projectId);
    requireIncident(grants.length > 0,'NOT_FOUND',404);
    requireIncident(!allowed || grants.some(g => allowed.includes(g.role as Role)), 'ROLE_DENIED',403);
  }
  get(actor: Actor, projectId: string, kind: Kind, id: string): RecordValue {
    this.authorize(actor,projectId);
    requireIncident(identifier(id));
    const row = this.db.prepare('SELECT payload FROM records WHERE id=? AND tenant_id=? AND project_id=? AND kind=?').get(id,actor.tenantId,projectId,kind);
    requireIncident(row,'NOT_FOUND',404);
    return JSON.parse(String(row.payload));
  }
  list(actor: Actor, projectId: string, kind: Kind, cursor = '0', limit = 50) {
    this.authorize(actor,projectId);
    requireIncident(/^(0|[1-9]\d{0,14})$/.test(cursor) && Number.isSafeInteger(Number(cursor)) && Number.isInteger(limit) && limit >= 1 && limit <= 100,'INVALID_PAGE');
    const rows = this.db.prepare('SELECT seq,payload FROM records WHERE tenant_id=? AND project_id=? AND kind=? AND seq>? ORDER BY seq LIMIT ?').all(actor.tenantId,projectId,kind,Number(cursor),limit + 1);
    const more = rows.length > limit, page = rows.slice(0,limit);
    return { items: page.map(r => JSON.parse(String(r.payload)) as RecordValue), nextCursor: more ? String(page.at(-1)!.seq) : null };
  }
  create(actor: Actor, kind: Kind, raw: unknown, key: string): { record: RecordValue; replayed: boolean } {
    const input = kind === 'workflow' ? parseWorkflow(raw) : kind === 'run' ? parseRun(raw) : parseIncident(raw);
    requireIncident(identifier(key),'IDEMPOTENCY_KEY_REQUIRED');
    const payloadHash = digest(canonicalize(JSON.stringify(input)));
    return this.tx(() => {
      this.authorize(actor,input.projectId,writes[kind]);
      const previous = this.db.prepare('SELECT payload_hash,record_id FROM requests WHERE tenant_id=? AND project_id=? AND actor_id=? AND operation=? AND key=?').get(actor.tenantId,input.projectId,actor.actorId,kind,key);
      if (previous) {
        requireIncident(previous.payload_hash === payloadHash,'IDEMPOTENCY_CONFLICT',409);
        return {record:this.get(actor,input.projectId,kind,String(previous.record_id)),replayed:true};
      }
      if ('workflowId' in input) this.get(actor,input.projectId,'workflow',input.workflowId);
      if ('runIds' in input) {
        for (const id of input.runIds) {
          const run = this.get(actor,input.projectId,'run',id) as AgentRun;
          requireIncident(run.workflowId === input.workflowId,'RUN_WORKFLOW_MISMATCH',409);
        }
        for (const id of input.linkedIncidentIds) this.get(actor,input.projectId,'incident',id);
      }
      const id = randomUUID(), now = new Date().toISOString();
      const record = {...input, tenantId:actor.tenantId,createdAt:now,version:1,...(kind === 'workflow' ? {workflowId:id,status:'registered'} : kind === 'run' ? {runId:id} : {incidentId:id,declaredAt:now,status:'declared'})} as RecordValue;
      this.db.prepare('INSERT INTO records(id,kind,tenant_id,project_id,payload) VALUES(?,?,?,?,?)').run(id,kind,actor.tenantId,input.projectId,JSON.stringify(record));
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,?,?)').run(actor.tenantId,input.projectId,actor.actorId,kind,key,payloadHash,id);
      this.audit(actor.actorId,`create_${kind}`,id);
      return {record,replayed:false};
    });
  }
}
