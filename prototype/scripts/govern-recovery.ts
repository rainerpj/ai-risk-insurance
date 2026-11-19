import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {keccak256} from 'viem';
import {Chain} from '../packages/service/chain.ts';
import {Store} from '../packages/service/store.ts';
import {BudgetObserver} from '../packages/service/budget-observer.ts';
import {RecoveryExecutor} from '../packages/service/recovery-executor.ts';

const [file,command,id,template,reason]=process.argv.slice(2);
if(!file||!command||!id||!['plan','plan-activation','tick','status'].includes(command)||!/^0x[a-f0-9]{64}$/.test(id))throw Error('Usage: govern-recovery <private-config> plan|plan-activation|tick|status <id> [template reason | request.json]');
const cfg=JSON.parse(readFileSync(file,'utf8')),root=dirname(resolve(file));
if(!Number.isSafeInteger(cfg.confirmations)||cfg.confirmations<1)throw Error('RECOVERY_CONFIRMATIONS');
const account=privateKeyToAccount(cfg.privateKey),chain=Chain.rpc(cfg.rpc,cfg.core,cfg.deploymentId,{[account.address.toLowerCase()]:account});
await chain.check();
const scope=`31337:${cfg.core}:${cfg.deploymentId}`,database=resolve(root,cfg.database);
if(!existsSync(database))throw Error('EXISTING_WORKBENCH_DATABASE_REQUIRED');
const store=new Store(database,scope),budgets=new Map<string,BudgetObserver>();
try{
 for(const item of cfg.budgets??[]){const owner=item.authorizer.toLowerCase();if(budgets.has(owner))throw Error('DUPLICATE_BUDGET_OWNER');budgets.set(owner,new BudgetObserver(resolve(root,item.database),scope));}
 const executor=new RecoveryExecutor(store,chain,account.address,budgets,cfg.confirmations);
 if(process.argv.includes('--test-exit-before-prepare')||process.argv.includes('--test-exit-before-sign')||process.argv.includes('--test-exit-after-sign')){
  const wallet=chain.wallet.bind(chain);chain.wallet=actor=>{const w=wallet(actor),sign=w.signTransaction.bind(w),prepare=w.prepareTransactionRequest.bind(w);return {...w,prepareTransactionRequest:async(request:any)=>{
   if(process.argv.includes('--test-exit-before-prepare'))process.exit(76);return prepare(request);
  },signTransaction:async(request:any)=>{
   if(process.argv.includes('--test-exit-before-sign'))process.exit(74);
   const raw=await sign(request);store.meta('testRecoverySignedHash:'+id,keccak256(raw));store.meta('testRecoverySigner:'+id+':'+process.pid,keccak256(raw));process.exit(75);
  }};};
 }
 // Fault injection is opt-in and applies only to this local development command.
 if(process.argv.includes('--test-exit-after-broadcast')){
  const send=chain.client.sendRawTransaction.bind(chain.client);
  chain.client.sendRawTransaction=async(args:any)=>{await send(args);process.exit(73);};
 }
 const activation=command==='plan-activation'?JSON.parse(readFileSync(resolve(root,template??''),'utf8')):null;
 const row=command==='plan-activation'?await executor.planActivation(id,activation.recoveryId,activation.request,activation.reason):command==='plan'?await executor.plan(id,template??'',reason??''):command==='tick'?await executor.tick(id):executor.get(id);
 // Never print signed bytes, the private configuration, or signer credentials.
 console.log(JSON.stringify({id:row.id,state:row.state,txHash:row.tx_hash,error:row.error}));
}finally{for(const budget of budgets.values())budget.close();store.close();}
