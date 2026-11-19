import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { IncidentStore } from '../packages/service/incident-store.ts';
const directory = resolve('.local',`incidents-${randomUUID()}`);
mkdirSync(directory,{recursive:true});
const store = new IncidentStore(resolve(directory,'incidents.sqlite'));
const accounts = [
  {actorId:'demo-admin',tenantId:'demo-tenant',grants:[{projectId:'demo-project',role:'enterprise_admin' as const}]},
  {actorId:'demo-fde',tenantId:'demo-tenant',grants:[{projectId:'demo-project',role:'fde' as const}]},
  {actorId:'demo-viewer',tenantId:'demo-tenant',grants:[{projectId:'demo-project',role:'viewer' as const}]}
].map(account => ({...account,password:randomBytes(24).toString('hex')}));
try { for (const a of accounts) store.provision(a.actorId,a.tenantId,a.password,a.grants); } finally { store.close(); }
writeFileSync(resolve(directory,'credentials.private.json'),JSON.stringify({localDemoOnly:true,accounts},null,2),{flag:'wx',mode:0o600});
writeFileSync(resolve(directory,'config.json'),JSON.stringify({schemaVersion:1,database:'incidents.sqlite',port:3200},null,2),{flag:'wx'});
console.log(`Created local demo: ${directory}. Credentials remain in credentials.private.json; do not export.`);
