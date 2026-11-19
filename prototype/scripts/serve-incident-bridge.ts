import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {parseStrictJSON} from '../packages/domain/evidence.ts';
import {exactObject,requireIncident as need} from '../packages/domain/incident-schema.ts';
import {IncidentStore} from '../packages/service/incident-store.ts';
import {Store} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {createApp} from '../packages/service/api.ts';
import {createIncidentApp} from '../packages/service/incident-api.ts';
import {IncidentClaimBridge,type BridgeTarget} from '../packages/service/incident-claim-bridge.ts';
const path=process.argv[2];if(!path)throw Error('Usage: serve-incident-bridge.ts <bridge-config.json>');
const config=parseStrictJSON(readFileSync(path,'utf8'));exactObject(config,['incidentConfig','serviceConfig','targets']);need(typeof config.incidentConfig==='string'&&typeof config.serviceConfig==='string'&&Array.isArray(config.targets)&&config.targets.length>0);
for(const t of config.targets){exactObject(t,['tenantId','projectId','workflowId','policyId']);need(Object.values(t).every(v=>typeof v==='string'&&v.length>0));}
const incidentPath=resolve(dirname(path),config.incidentConfig),servicePath=resolve(dirname(path),config.serviceConfig),ic=JSON.parse(readFileSync(incidentPath,'utf8')),sc=JSON.parse(readFileSync(servicePath,'utf8'));exactObject(ic,['schemaVersion','database','port']);need(ic.schemaVersion===1&&typeof ic.database==='string'&&Number.isInteger(ic.port)&&Number(ic.port)>=1024&&Number(ic.port)<=65535);
const sourceFile=resolve(dirname(incidentPath),ic.database),legacyFile=resolve(dirname(servicePath),sc.database);need(existsSync(sourceFile)&&existsSync(legacyFile),'BRIDGE_EXISTING_DATABASES_REQUIRED');
const accounts=Object.fromEntries(Object.entries(sc.accounts as Record<string,`0x${string}`>).map(([address,key])=>{const account=privateKeyToAccount(key);need(account.address.toLowerCase()===address.toLowerCase(),'SIGNER_ADDRESS_MISMATCH');return [address.toLowerCase(),account];}));
const chain=Chain.rpc(sc.rpc,sc.core,sc.deploymentId,accounts,sc.registry);await chain.check();const port=sc.port??3100;need(Number.isInteger(port)&&port>=1024&&port<=65535&&port!==ic.port,'BRIDGE_PORT_INVALID');
const source=new IncidentStore(sourceFile),legacy=new Store(legacyFile,`31337:${sc.core}:${sc.deploymentId}`),bridge=new IncidentClaimBridge(source,legacy,chain,config.targets as BridgeTarget[]),index=new Indexer(legacy,chain,BigInt(sc.startBlock)),worker=new Worker(legacy,chain);
const app=createApp(legacy,chain,`http://127.0.0.1:${port}`),incidents=createIncidentApp(source,`http://127.0.0.1:${ic.port}`,bridge);let running=false,stopping=false;
async function cycle(){if(running||stopping)return;running=true;try{await index.sync();await worker.tick();}catch(e){legacy.meta('indexError',(e as Error).message);}finally{running=false;}}
try{await app.listen({host:'127.0.0.1',port});await incidents.listen({host:'127.0.0.1',port:Number(ic.port)});}catch(e){await app.close();await incidents.close();source.close();legacy.close();throw e;}
console.log(`Local manual bridge: http://127.0.0.1:${ic.port}/test-claims ; manual workbench: http://127.0.0.1:${port}`);const timer=setInterval(()=>void cycle(),1000);void cycle();
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,25));await app.close();await incidents.close();source.close();legacy.close();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
