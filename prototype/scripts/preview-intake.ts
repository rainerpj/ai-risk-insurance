// Isolated browser acceptance fixture; no connection to the existing 8545 node.
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {custom} from 'viem';
import {autoFixture} from '../tests/m2b-fixture.ts';
import {seedIntake} from '../tests/seed-intake.ts';
import {createApp,intakeMessage} from '../packages/service/api.ts';
import {id} from '../tests/chain-helper.ts';
import {zeroHash} from '../packages/domain/typed-data.ts';
import {recordQuality} from '../packages/service/quality.ts';
import {recordIntakeQuality} from '../packages/service/intake-quality.ts';
import {Chain} from '../packages/service/chain.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {observeRouting,routingObservations} from '../packages/service/routing-proof.ts';
import {json} from '../packages/service/store.ts';
const keys:Record<string,string>={},f=await autoFixture({captureKey:(name,key)=>{keys[name]=key;}}),{c}=f;
const offline=process.argv.includes('--offline');
const metrics=process.argv.includes('--metrics');
const intakeQuality=process.argv.includes('--intake-quality');
const governance=process.argv.includes('--governance');
if(process.argv.slice(2).some(v=>!['--offline','--metrics','--intake-quality','--governance'].includes(v))||offline&&(metrics||intakeQuality||governance)||governance&&(metrics||intakeQuality))throw Error('UNKNOWN_OR_CONFLICTING_PREVIEW_OPTION');
let disconnected=false;
const transport=custom({request:async(args:any)=>{if(disconnected)throw Error('SYNTHETIC_RPC_OFFLINE');return c.connection.provider.request(args); }},{retryCount:0});
const chain=new Chain(c.core.address,c.salt,transport,Object.fromEntries(Object.values(c.accounts).map(a=>[a.address.toLowerCase(),a])));
const second=await c.notice(f.q,{incidentCommitment:governance?id():f.n.n.incidentCommitment});
for(const noticeId of [f.request.noticeId,second.n.noticeId])await seedIntake(f.store,chain,c.accounts.insured,{...f.request,noticeId},800000000n);
await c.connection.provider.request({method:'evm_mine'});const index=new Indexer(f.store,chain,0n);await index.sync();
let qualityReviewId:string|null=null;
let governanceTriggerId:string|null=null,correctedTriggerId:string|null=null;
if(governance){
 const actor={address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},reviewer={...actor,address:c.accounts.assessor2.address.toLowerCase()};
 await f.enable();await observeRouting(f.store,f.reviewer,f.request);
 const portal={routing:async()=>routingObservations(f.store,f.q.enterpriseId),status:async()=>({}),import:async()=>({}),submit:async()=>({})};
 governanceTriggerId=id();await recordIntakeQuality(f.store,chain,actor,{id:governanceTriggerId,noticeId:f.request.noticeId,outcome:'missed_escalation',reason:'Synthetic intake anomaly with historical route and template pause'},{intakePortal:portal,safetyGovernor:c.accounts.governor.address});
 const assessed=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,assessed.a,assessed.signature);await c.send(c.core,'registerDecision',job.args,'executor');
 const worker=new Worker(f.store,chain);await worker.tick();await worker.tick();
 correctedTriggerId=id();await recordIntakeQuality(f.store,chain,actor,{id:correctedTriggerId,noticeId:second.n.noticeId,outcome:'unpaid_obligation',reason:'Synthetic unpaid intake case before manual correction'});
 const manual=await c.decision(f.q,[second.n.noticeId],id(),800000000n);await c.send(c.core,'registerDecision',manual.args,'executor');
 const payment=await c.payment(f.q,manual.d.incidentId,800000000n);await c.send(c.core,'executePayment',[payment.p,payment.sig],'executor');
 qualityReviewId=id();await recordQuality(f.store,chain,reviewer,{id:qualityReviewId,incidentId:manual.d.incidentId,decisionVersion:'1',outcome:'correct',reason:'Synthetic independent review of completed manual correction and payment'});
 await c.connection.provider.request({method:'evm_mine'});await index.sync();
}
if(metrics){
 const decision=await c.decision(f.q,[f.request.noticeId],id(),800000000n);await c.send(c.core,'registerDecision',decision.args,'executor');await c.connection.provider.request({method:'evm_mine'});
 qualityReviewId=id();await recordQuality(f.store,chain,{address:c.accounts.assessor2.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},{id:qualityReviewId,incidentId:decision.d.incidentId,decisionVersion:'1',outcome:'correct',reason:'Synthetic independent review for browser cost form acceptance'});
 await c.connection.provider.request({method:'evm_mine'});await index.sync();
}
const payload={noticeId:id(),policyId:null,incidentCommitment:id(),evidenceHash:zeroHash,declaredIncidentAt:f.q.startAt.toString(),summary:'合成浏览器离线报案，尚未核验或锚定',claimedAmount:'800000000'};
let intakeTriggerId:string|null=null;
if(intakeQuality){intakeTriggerId=id();await recordIntakeQuality(f.store,chain,{address:c.accounts.assessor.address.toLowerCase(),tenant:f.q.enterpriseId,role:'ASSESSOR'},{id:intakeTriggerId,noticeId:second.n.noticeId,outcome:'missed_escalation',reason:'Synthetic initial intake anomaly for independent browser followup'});}
const signature=await c.accounts.insured.signMessage({message:intakeMessage(f.store.getMeta('scope')!,payload)});
writeFileSync(resolve(f.dir,'offline-intake.json'),json({payload,signature}));
if(offline){disconnected=true;try{await index.sync();}catch(e){if(!String(e).includes('SYNTHETIC_RPC_OFFLINE'))throw e;}if(!f.store.getMeta('indexError'))throw Error('EXPECTED_OFFLINE_INDEX_ERROR');}
for(const [name,role] of [['insured','insured'],['assessor','ASSESSOR'],['assessor2','ASSESSOR'],['approver','CLAIM_APPROVER'],['supervisor','SUPERVISOR']] as const){
 f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',c.accounts[name].address.toLowerCase(),f.q.enterpriseId,role);
 writeFileSync(resolve(f.dir,'preview-'+name+'-private.json'),json({privateKey:keys[name]}));
}
// Reserve the listen socket first, then assign the same origin used by login challenges.
const app=createApp(f.store,chain);await app.listen({host:'127.0.0.1',port:0});
const origin='http://127.0.0.1:'+(app.server.address() as any).port;
await app.close();const page=createApp(f.store,chain,origin);await page.listen({host:'127.0.0.1',port:Number(new URL(origin).port)});
const metadata={origin,directory:f.dir,offline,metrics,governance,governanceTriggerId,correctedTriggerId,intakeTriggerId,supervisor:c.accounts.supervisor.address,qualityReviewId,qualityReviewer:c.accounts.assessor2.address,offlineNoticeId:payload.noticeId,policyId:f.q.quoteId,noticeIds:[f.request.noticeId,second.n.noticeId],templateId:f.g.templateId,insured:c.accounts.insured.address,assessor:c.accounts.assessor.address,approver:c.accounts.approver.address};
writeFileSync(resolve(f.dir,'preview-public.json'),json(metadata));writeFileSync(resolve(f.dir,'upload.txt'),'Synthetic browser evidence only. Not verified or anchored.');console.log(json(metadata));
async function stop(){await page.close();f.close();await c.connection.close();process.exit(0);}process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
