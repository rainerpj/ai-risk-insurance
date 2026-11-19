import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
import { exactObject, requireIncident } from '../packages/domain/incident-schema.ts';
const path = process.argv[2];
if (!path) throw new Error('Usage: serve:incidents <local-config.json>');
const config = JSON.parse(readFileSync(path,'utf8'));
exactObject(config,['schemaVersion','database','port']);
requireIncident(config.schemaVersion === 1 && typeof config.database === 'string' && config.database.length > 0 && Number.isInteger(config.port) && Number(config.port) >= 1024 && Number(config.port) <= 65535);
const store = new IncidentStore(resolve(dirname(path),config.database));
const origin = `http://127.0.0.1:${config.port}`;
const app = createIncidentApp(store,origin);
try { await app.listen({host:'127.0.0.1',port:Number(config.port)}); } catch(e) { store.close(); throw e; }
console.log(`Local incident API: ${origin}/api/incidents-v1 (synthetic / approved redacted data only)`);
let stopping = false;
async function stop() { if(stopping)return;stopping=true;await app.close();store.close(); }
process.on('SIGINT',() => void stop());process.on('SIGTERM',() => void stop());
