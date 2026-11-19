// Browser acceptance fixture: isolated memory EVM, synthetic identities and live outbox.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {custom} from 'viem';
import {setup,id,json} from '../tests/chain-helper.ts';
import {Store} from '../packages/service/store.ts';
import {Chain} from '../packages/service/chain.ts';
import {Indexer,Worker} from '../packages/service/indexer.ts';
import {createApp,intakeMessage} from '../packages/service/api.ts';
import {zeroHash} from '../packages/domain/typed-data.ts';

const keys:Record<string,string>={};
const c=await setup({captureKey:(name,key)=>{keys[name]=key;}}),q=await c.issue();
const dir=resolve('.local','browser-workbench-'+c.runId);mkdirSync(dir,{recursive:true});
const scope=`31337:${c.core.address}:${c.salt}`;
const store=new Store(resolve(dir,'service.sqlite'),scope);
const chain=new Chain(c.core.address,c.salt,custom({request:async(args:any)=>{
  if(existsSync(resolve(dir,'offline.flag')))throw Error('SYNTHETIC_RPC_OFFLINE');
  return c.connection.provider.request(args);
}},{retryCount:0}),Object.fromEntries(Object.values(c.accounts).map(a=>[a.address.toLowerCase(),a])));
const identities:Record<string,string>={};
for(const [name,role] of [['insured','insured'],['assessor','ASSESSOR'],['assessor2','ASSESSOR'],['approver','CLAIM_APPROVER'],['supervisor','SUPERVISOR']] as const){
  identities[name]=c.accounts[name].address;
  store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',identities[name]!.toLowerCase(),q.enterpriseId,role);
  writeFileSync(resolve(dir,'preview-'+name+'-private.json'),json({privateKey:keys[name]}));
}
const now=await c.now();
const authorization={noticeId:id(),policyId:q.quoteId,incidentCommitment:id(),evidenceHash:zeroHash,declaredIncidentAt:q.startAt,submitter:c.accounts.insured.address,signerEpoch:await c.read(c.core,'epochs',[c.accounts.insured.address]),expiresAt:now+86400n};
const payload={noticeId:authorization.noticeId,policyId:q.quoteId,incidentCommitment:authorization.incidentCommitment,evidenceHash:zeroHash,declaredIncidentAt:q.startAt.toString(),summary:'2026-11-14 浏览器合成编程事故：恢复30000，应急3000',claimedAmount:'33000000000'};
writeFileSync(resolve(dir,'intake.json'),json({payload,signature:await c.accounts.insured.signMessage({message:intakeMessage(scope,payload)})}));
writeFileSync(resolve(dir,'binding.json'),json({authorization,signature:await c.sign('NoticeAuthorization',authorization,'insured')}));
writeFileSync(resolve(dir,'upload.txt'),'Synthetic browser acceptance evidence. Recovery 30000; emergency 3000. Not verified or anchored.');
const index=new Indexer(store,chain,0n),worker=new Worker(store,chain);
await c.connection.provider.request({method:'evm_mine'});await index.sync();
const first=createApp(store,chain);await first.listen({host:'127.0.0.1',port:0});
const port=(first.server.address() as any).port;await first.close();
const origin=`http://127.0.0.1:${port}`,app=createApp(store,chain,origin);await app.listen({host:'127.0.0.1',port});
// Optional synthetic setup for targeted UI regression. Business actions below use
// the service API and real local-chain Worker; browser assertions start afterward.
let feedback:Record<string,string>|undefined;
if(process.argv.includes('--feedback')){
 const tokens:Record<string,string>={};
 for(const who of ['insured','assessor','approver'] as const){
  const ch=(await app.inject({method:'POST',url:'/api/auth/challenge',payload:{address:c.accounts[who].address}})).json();
  const logged=await app.inject({method:'POST',url:'/api/auth/login',payload:{id:ch.id,signature:await c.accounts[who].signMessage({message:ch.message})}});
  if(logged.statusCode!==200)throw Error('PREVIEW_LOGIN_FAILED');tokens[who]=logged.json().token;
 }
 const request=async(who:string,url:string,body:unknown)=>{
  const response=await app.inject({method:'POST',url:'/api'+url,headers:{authorization:'Bearer '+tokens[who]},payload:JSON.parse(json(body))});
  if(response.statusCode>=300)throw Error('PREVIEW_SETUP_FAILED:'+url+':'+response.body);return response.json();
 };
 const confirm=async()=>{await worker.tick();await c.connection.provider.request({method:'evm_mine'});await index.sync();};
 await request('insured','/notices',{payload,signature:await c.accounts.insured.signMessage({message:intakeMessage(scope,payload)})});
 await request('insured',`/notices/${authorization.noticeId}/bind`,{authorization,signature:await c.sign('NoticeAuthorization',authorization,'insured')});await confirm();
 const incidentId=id();const draft=await request('assessor','/drafts',{policyId:q.quoteId,incidentId,noticeIds:[authorization.noticeId],approver:c.accounts.approver.address,reason:'界面问题专项合成夹具：33000测试币，非真实保险决定',expenses:[{gross:'30000000000',duplicate:'0',compensation:'0',recovery:'0'},{gross:'3000000000',duplicate:'0',compensation:'0',recovery:'0'}]});
 await request('approver',`/drafts/${draft.id}/sign`,{});await request('approver',`/drafts/${draft.id}/submit`,{});await confirm();
 await request('approver','/manual/freeze',{incidentId,reason:'专项浏览器冻结拒付测试'});await confirm();
 feedback={incidentId,draftId:draft.id};console.log('Feedback fixture:',json(feedback));
}
writeFileSync(resolve(dir,'preview-public.json'),json({origin,directory:dir,policyId:q.quoteId,noticeId:authorization.noticeId,identities,runId:c.runId}));
console.log(json({origin,directory:dir,policyId:q.quoteId,noticeId:authorization.noticeId,identities,runId:c.runId,feedback}));
let busy=false,stopping=false;
const timer=setInterval(async()=>{if(busy||stopping)return;busy=true;try{
  await c.connection.provider.request({method:'evm_mine'});await index.sync();await worker.tick();
}catch(e){store.meta('indexError',(e as Error).message);}finally{busy=false;}},1000);
async function stop(){stopping=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,25));await app.close();store.close();await c.connection.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
