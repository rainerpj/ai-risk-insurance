// Local synthetic UI fixture; independent review only, no payout.
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {autoFixture} from '../tests/m2b-fixture.ts';
import {createApp} from '../packages/service/api.ts';
import {recordQuality} from '../packages/service/quality.ts';
import {json} from '../packages/service/store.ts';
import {id,H} from '../tests/chain-helper.ts';
import {Indexer} from '../packages/service/indexer.ts';
import {refreshSampling} from '../packages/service/sampling.ts';
const keys:Record<string,string>={},f=await autoFixture({network:'localhost',captureKey:(name,key)=>{keys[name]=key;}});
await f.enable();const assessment=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessment.a,assessment.signature),decision=job.args[0] as any;
await f.c.send(f.c.core,'registerDecision',job.args,'executor');await f.enable(false,false);
const actor={address:f.c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},reviewId=id();
if(!process.argv.includes('--pending-sample'))await recordQuality(f.store,f.makeChain('executor'),actor,{id:reviewId,incidentId:decision.incidentId,decisionVersion:'1',outcome:'correct',reason:'合成浏览器样本：复核通过，耗时和成本待采集。'});
const deployment=(f.c.records as {action:string;receipt:{blockNumber:bigint}}[]).find(r=>r.action==='deploy InsuranceCore')!;
await new Indexer(f.store,f.makeChain('executor'),deployment.receipt.blockNumber).sync();await refreshSampling(f.store,f.makeChain('executor'));
f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',actor.address,actor.tenant,actor.role);
f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts.supervisor.address.toLowerCase(),H('isolated metrics enterprise'),'SUPERVISOR');
const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as any).port;await new Promise<void>(r=>socket.close(()=>r()));
const origin='http://127.0.0.1:'+port,app=createApp(f.store,f.makeChain('executor'),origin,{grantIds:[f.request.grantId]});await app.listen({host:'127.0.0.1',port});
for(const name of ['assessor','supervisor'])writeFileSync(resolve(f.dir,'preview-'+name+'-private.json'),json({privateKey:keys[name]}));
const metadata={origin,assessor:actor.address,otherEnterpriseReviewer:f.c.accounts.supervisor.address,reviewId,incidentId:decision.incidentId,directory:f.dir};
writeFileSync(resolve(f.dir,'preview-public.json'),json(metadata));console.log(json(metadata));
async function stop(){await app.close();f.close();await f.c.connection.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
