// Local synthetic browser fixture; no public RPC or real credentials.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {custom} from 'viem';
import {setup,json} from '../tests/chain-helper.ts';
import {bridgeSource} from '../tests/incident-bridge-fixture.ts';
import {Store} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {IncidentClaimBridge} from '../packages/service/incident-claim-bridge.ts';
import {createIncidentApp} from '../packages/service/incident-api.ts';
const c=await setup(),q=await c.issue({annualLimit:10000000n,incidentLimit:10000000n}),f=await bridgeSource(q);
const directory=resolve('.local',`incident-n12-browser-${c.runId}`);mkdirSync(directory,{recursive:true});
f.store.logout(f.token);
const legacy=new Store(resolve(directory,'legacy.sqlite'),`31337:${c.core.address}:${c.salt}`);
const chain=new Chain(c.core.address,c.salt,custom(c.connection.provider),Object.fromEntries(Object.values(c.accounts).map(a=>[a.address.toLowerCase(),a])));
const bridge=new IncidentClaimBridge(f.store,legacy,chain,[{tenantId:'tenant',projectId:'project',workflowId:f.workflow.workflowId,policyId:q.quoteId}]);
const app=createIncidentApp(f.store,'http://127.0.0.1:3218',bridge);await app.listen({host:'127.0.0.1',port:3218});
writeFileSync(resolve(directory,'fixture.json'),json({directory,sourceDatabase:f.file,origin:'http://127.0.0.1:3218',projectId:'project',workflowId:f.workflow.workflowId,incidentId:f.incident.incidentId,input:f.input,accounts:['admin','investigator','reviewer','viewer','foreign'],password:f.password,scope:'synthetic browser fixture, mapping only; no payment'}));
console.log(directory);
let stopping=false,supplemented=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);await app.close();f.store.close();legacy.close();await c.connection.close();}
const timer=setInterval(()=>{if(existsSync(resolve(directory,'supplement.flag'))&&!supplemented){f.add('N12 synthetic late evidence');supplemented=true;}if(existsSync(resolve(directory,'stop.flag')))void stop();},500);
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
