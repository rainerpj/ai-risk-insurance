import {readFileSync} from 'node:fs';
import {Chain} from './chain.ts';
import {Budget} from './budget.ts';
import {json} from './store.ts';
import {assertLocal} from '../domain/local.ts';
import type {IntakePortal} from './intake-portal.ts';
const abi=JSON.parse(readFileSync(new URL('../domain/abi/GrantRegistry.json',import.meta.url),'utf8'));
export type OperationsOptions={grantIds?:string[];budgetSnapshot?:(tenant:string)=>Promise<any>;safetyGovernor?:string;intakePortal?:IntakePortal};
/** Public operational projection only. Never contains signed jobs, raw transactions or source documents. */
export function budgetSnapshot(budget:Budget,tenant:string,now:number){
  const rows=budget.all('SELECT * FROM reservations').filter(r=>JSON.parse(r.dims).enterpriseId===tenant);
  const reservations=rows.map(r=>({id:r.id,incident:r.incident,remaining:r.remaining,state:r.state}));
  const payments=rows.flatMap(r=>budget.all('SELECT id,amount,state FROM payments WHERE reservation_id=?',r.id));
  const dimensions=new Map(rows.map(r=>{const d=JSON.parse(r.dims);return [json(d),d];}));
  const usage=[...dimensions.values()].map(d=>({token:d.token,insurerId:d.insurerId,fdeId:d.fdeId,riskGroupId:d.riskGroupId,
    dimensions:Object.entries(budget.usage(d,now)).map(([dimension,u])=>({dimension,used:u.amount.toString(),count:u.count,limit:u.limit.amount,countLimit:u.limit.count,window:u.limit.window,version:u.limit.version,exceeded:u.amount>BigInt(u.limit.amount)||u.count>u.limit.count}))}));
  return {scope:budget.meta('scope'),tenant,ready:budget.meta('ready')==='1',asOf:now,reservations,payments,usage};
}
export function remoteBudget(baseUrl:string,token:string,scope:string){
  assertLocal(baseUrl);if(token.length<32)throw new Error('OBSERVER_CAPABILITY_REQUIRED');
  return async(tenant:string)=>{
    const response=await fetch(new URL('/operations/'+encodeURIComponent(tenant),baseUrl),{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(2500),redirect:'error'});
    if(!response.ok)throw new Error('BUDGET_OBSERVER_UNAVAILABLE');
    const data:any=await response.json();if(data.scope!==scope||data.tenant!==tenant)throw new Error('OBSERVER_SCOPE_MISMATCH');return data;
  };
}
export async function operations(chain:Chain,tenant:string,options:OperationsOptions={}){
  const result:any={mode:'local-synthetic',tenant,chain:{state:'unavailable'},budget:{state:'not_configured'},modelCosts:{state:'not_configured'},model:{state:'not_verified',label:'真实模型未验收'}};
  try{
    await chain.check();const head=await chain.client.getBlock(),registry=await chain.read('grantRegistry',[],head.number);
    const read=(functionName:string,args:any[])=>chain.client.readContract({address:registry,abi,functionName,args,blockNumber:head.number});
    const channels=[];for(const channel of [1,2])channels.push({channel,approve:await read('approvalEnabled',[channel]),pay:await read('paymentEnabled',[channel])});
    const grants=[];for(const id of options.grantIds??[]){const g=await read('getGrant',[id]);if(g.enterpriseId!==tenant)continue;
      grants.push({id,token:g.token,channel:g.channel,epoch:g.epoch.toString(),budgetVersion:g.budgetVersion.toString(),enabled:g.enabled,validUntil:g.validUntil.toString(),reviewLimit:g.reviewLimit.toString(),
        templateId:g.templateId,ruleVersion:g.ruleVersion,modelVersion:g.modelVersion,templatePaused:await read('disabledVersion',[g.templateId]),rulePaused:await read('disabledVersion',[g.ruleVersion]),modelPaused:await read('disabledVersion',[g.modelVersion])});
    }
    if((await chain.block(head.number)).hash!==head.hash)throw new Error('CHAIN_CHANGED');
    result.chain={state:'available',block:head.number.toString(),hash:head.hash,confirmation:'head-not-final',channels,grants};
  }catch{result.chain={state:'unavailable',reason:'链不可用或当前部署不支持自动通道；不能视为开关已关闭'};}
  if(options.budgetSnapshot)try{result.budget={state:'available',...await options.budgetSnapshot(tenant)};}catch{result.budget={state:'unavailable',reason:'预算服务未完成连接或范围核验'};}
  if(options.intakePortal?.costs)try{const costs=await options.intakePortal.costs(tenant);if(costs.tenant!==tenant)throw Error('MODEL_COST_TENANT_MISMATCH');result.modelCosts={...costs,state:'available'};}catch{result.modelCosts={state:'unavailable',reason:'模型费用服务不可核验，不能视为零费用'};}
  return result;
}
