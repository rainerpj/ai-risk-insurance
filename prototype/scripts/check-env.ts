import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {assertLocal} from '../packages/domain/local.ts';
const pkg=JSON.parse(readFileSync('package.json','utf8')),issues:string[]=[];
if(process.version!=='v'+pkg.engines.node)issues.push('NODE_VERSION_MISMATCH');
const manager=process.env.npm_config_user_agent?.split(' ')[0]??null;
if(manager!==pkg.packageManager.replace('@','/'))issues.push('PNPM_VERSION_MISMATCH_OR_NOT_INVOKED_WITH_PNPM');
let local=true;try{assertLocal(process.env.RPC_URL??'http://127.0.0.1:8545',Number(process.env.CHAIN_ID??31337));}catch{local=false;issues.push('LOCAL_CHAIN_CONFIGURATION_INVALID');}
const db=new DatabaseSync(':memory:');let sqlite:string;try{sqlite=String(db.prepare('SELECT sqlite_version() version').get()!.version);}finally{db.close();}
let rpcState='not-checked';
if(process.argv.includes('--rpc')&&local){
 try{const r=await fetch(process.env.RPC_URL??'http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(3000)});rpcState=(await r.json() as any).result==='0x7a69'?'local-31337':'wrong-chain';}catch{rpcState='unavailable';}
 if(rpcState!=='local-31337')issues.push('LOCAL_RPC_UNAVAILABLE_OR_WRONG_CHAIN');
}
console.log(JSON.stringify({node:process.version,expectedNode:pkg.engines.node,packageManager:manager,expectedPackageManager:pkg.packageManager,sqlite,localConfigurationValid:local,rpcState,realModelCredentialConfigured:Boolean(process.env.OPENAI_API_KEY?.trim()),realModelAcceptance:'not-verified',issues},null,2));
if(issues.length)process.exitCode=1;
