import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {Store} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {createApp} from '../packages/service/api.ts';
import {remoteBudget} from '../packages/service/operations.ts';
import {remoteIntakePortal} from '../packages/service/intake-portal.ts';
import {refreshSampling} from '../packages/service/sampling.ts';
const path=process.argv[2];if(!path)throw new Error('Usage: pnpm serve .local/workbench-<runId>/config.json');
const cfg=JSON.parse(readFileSync(path,'utf8'));
const accounts=Object.fromEntries(Object.entries(cfg.accounts as Record<string,`0x${string}`>).map(([address,key])=>{const account=privateKeyToAccount(key);if(account.address.toLowerCase()!==address.toLowerCase())throw new Error('SIGNER_ADDRESS_MISMATCH');return [address.toLowerCase(),account];}));
const chain=Chain.rpc(cfg.rpc,cfg.core,cfg.deploymentId,accounts,cfg.registry);
const store=new Store(resolve(dirname(path),cfg.database),`31337:${cfg.core}:${cfg.deploymentId}`);
for(const i of cfg.identities)store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?) ON CONFLICT(address) DO NOTHING',i.address.toLowerCase(),i.tenant,i.role);
const port=cfg.port??3100,origin=`http://127.0.0.1:${port}`;
const automation={grantIds:cfg.automation?.grantIds??[],safetyGovernor:cfg.automation?.safetyGovernor,...(cfg.automation?.observerUrl?{budgetSnapshot:remoteBudget(cfg.automation.observerUrl,cfg.automation.observerToken,store.getMeta('scope')!)}:{})};
const portal=cfg.automation?.reviewerUrl?{intakePortal:remoteIntakePortal(cfg.automation.reviewerUrl,cfg.automation.portalTokens??{},store.getMeta('scope')!)}:{};
const index=new Indexer(store,chain,BigInt(cfg.startBlock)),worker=new Worker(store,chain),app=createApp(store,chain,origin,{...automation,...portal});
let running=false,stopping=false;
async function cycle(){if(running||stopping)return;running=true;try{if(process.argv.includes('--rebuild')&&store.getMeta('halted')==='NO_COMMON_ANCESTOR')await index.rebuild();else await index.sync();await worker.tick();try{await refreshSampling(store,chain);}catch(e){store.meta('samplingError',(e as Error).message);}}catch(e){store.meta('indexError',(e as Error).message);}finally{running=false;}}
await app.listen({host:'127.0.0.1',port});console.log(`Workbench: ${origin} (local test identities only)`);
const timer=setInterval(cycle,1000);void cycle();
async function stop(){stopping=true;clearInterval(timer);while(running)await new Promise(r=>setTimeout(r,25));await app.close();store.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
