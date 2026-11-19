import {writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {autoFixture,limits} from '../tests/m2b-fixture.ts';
import {json,Store} from '../packages/service/store.ts';
import {seedIntake} from '../tests/seed-intake.ts';
import {U} from '../tests/chain-helper.ts';
const keys:Record<string,string>={};const f=await autoFixture({network:'localhost',captureKey:(name,key)=>keys[name]=key});
async function port(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const value=(server.address() as any).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return value;}
const quality=process.argv.includes('--quality');
try{
 await f.enable(true,false);const a=await f.reviewer.assess(f.request),job=await f.authorizer.authorize(f.request,a.a,a.signature);await f.c.send(f.c.core,'registerDecision',job.args,'executor');
 await f.enable(false,false);if(!quality)await f.c.send(f.registry,'configure',[f.request.grantId,{...f.g,budgetVersion:2n}]);await f.c.connection.provider.request({method:'evm_mine'});
 if(!quality)await f.authorizer.reconfigure(limits(500n*U,5,'2'),[f.request.grantId],0);await f.authorizer.reconcile();
 const webPort=await port(),observerPort=await port(),observerToken=randomBytes(32).toString('hex');
 const common={rpc:'http://127.0.0.1:8545',core:f.c.core.address,deploymentId:f.c.salt,startBlock:'0'};
 const names=['insured','assessor','approver','supervisor'] as const,roles={insured:'insured',assessor:'ASSESSOR',approver:'CLAIM_APPROVER',supervisor:'SUPERVISOR'};
 const identities=names.map(name=>({address:f.c.accounts[name].address,tenant:f.q.enterpriseId,role:roles[name]}));
 const web={...common,port:webPort,database:'workbench.sqlite',identities,accounts:Object.fromEntries([...names,...(quality?['governor'] as const:[])].map(name=>[f.c.accounts[name].address.toLowerCase(),keys[name]])),automation:{...(quality?{safetyGovernor:f.c.accounts.governor.address}:{}),grantIds:[f.request.grantId],observerUrl:`http://127.0.0.1:${observerPort}`,observerToken}};
 const authorizer={...common,role:'authorizer',port:observerPort,database:'budget.sqlite',intakeDatabase:'workbench.sqlite',privateKey:keys.approver2,trust:f.trust,originals:'.',reviewerToken:randomBytes(32).toString('hex'),executorToken:randomBytes(32).toString('hex'),observerToken};
 const intake=new Store(f.dir+'/workbench.sqlite',f.scope);try{await seedIntake(intake,f.makeChain('executor'),f.c.accounts.insured,f.request,800n*U);}finally{intake.close();}
 writeFileSync(f.dir+'/workbench.json',json(web));writeFileSync(f.dir+'/authorizer.json',json(authorizer));
 writeFileSync(f.dir+'/public.json',json({runId:f.c.runId,url:`http://127.0.0.1:${webPort}`,identities,policy:f.q.quoteId,incident:(job.args[0] as any).incidentId,grantId:f.request.grantId,due:'800000000',budgetLimit:quality?'1000000000':'500000000',quality}));
 console.log(json({directory:f.dir,url:`http://127.0.0.1:${webPort}`,publicFixture:f.dir+'/public.json'}));
}finally{f.close();await f.c.connection.close();}
