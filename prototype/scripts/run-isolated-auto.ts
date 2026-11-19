import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdirSync,createWriteStream,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const directory=resolve('.local','isolated-auto-'+randomUUID());mkdirSync(directory,{recursive:true});
const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));
const rpc=`http://127.0.0.1:${port}`,env={...process.env,RPC_URL:rpc,CHAIN_ID:'31337'};
const node=spawn(process.execPath,['node_modules/hardhat/dist/src/cli.js','node','--hostname','127.0.0.1','--port',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const nodeLog=createWriteStream(resolve(directory,'node.log'));node.stdout!.pipe(nodeLog,{end:false});node.stderr!.pipe(nodeLog,{end:false});
const exited=(child:ChildProcess)=>new Promise<number|null>((r,j)=>{child.once('exit',r);child.once('error',j);});
const nodeExit=exited(node);const steps:any[]=[];
try{
 let ready=false;
 for(let attempt=0;attempt<100;attempt++){
  if(node.exitCode!==null||node.signalCode!==null)throw Error('ISOLATED_NODE_EXITED');
  try{const response=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(500)});ready=(await response.json() as any).result==='0x7a69';}catch{}
  if(ready)break;await new Promise(r=>setTimeout(r,100));
 }
 if(!ready)throw Error('ISOLATED_NODE_NOT_READY');
 for(const mode of ['deployment','l1','l2','supplement']){
  const log=createWriteStream(resolve(directory,mode+'.log'));
  const command=mode==='deployment'?['scripts/deploy-local.ts']:['scripts/scenario-auto.ts',...(mode==='l1'?[]:['--'+mode,'--stub'])];
  const child=spawn(process.execPath,['--import','tsx',...command],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout!.pipe(log,{end:false});child.stderr!.pipe(log,{end:false});
  const exitCode=await exited(child);await new Promise<void>(r=>log.end(r));steps.push({mode,exitCode});
  if(exitCode!==0)throw Error('SCENARIO_FAILED:'+mode);
  console.log('Isolated scenario passed:',mode);
 }
 writeFileSync(resolve(directory,'result.json'),JSON.stringify({status:'passed',rpc,steps,scope:'synthetic models and local EVM only'},null,2));
 console.log('Isolated process evidence:',directory);
}catch(e){writeFileSync(resolve(directory,'result.json'),JSON.stringify({status:'failed',rpc,steps,error:String(e)},null,2));console.error('Isolated evidence directory:',directory);throw e;}
finally{if(node.exitCode===null&&node.signalCode===null)node.kill();await nodeExit;await new Promise<void>(r=>nodeLog.end(r));}
