import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {setup,H as KH,U,id} from './chain-helper.ts';
import {hash,json,Store} from '../packages/service/store.ts';
import {H,Originals,type Trust,type Request} from '../packages/service/reviewer.ts';
import {Chain} from '../packages/service/chain.ts';
import {Budget,type BudgetConfig} from '../packages/service/budget.ts';
import {Reviewer,Authorizer} from '../packages/service/automatic.ts';
import {custom} from 'viem';
import hre from 'hardhat';
export const limits=(amount=1000n*U,count=5,version='1',window=3600)=>Object.fromEntries(['enterprise','fde','riskGroup','GLOBAL'].map(k=>[k,{version,window,amount:amount.toString(),count}])) as Record<'enterprise'|'fde'|'riskGroup'|'GLOBAL',BudgetConfig>;
export async function autoFixture(options:Parameters<typeof setup>[0]={},loss?:{gross:bigint;compensation:bigint;units?:bigint}){
  const c=await setup(options),dir=resolve('.local','m2b-'+c.runId);mkdirSync(dir,{recursive:true});
  await c.send(c.core,'grantRole',[KH('AUTO_REVIEWER'),c.accounts.outsider.address]);await c.send(c.core,'grantRole',[KH('AUTO_AUTHORIZER'),c.accounts.approver2.address]);
  const q=await c.issue(),trust:Trust={runtimeDeployment:"synthetic-app-rollout-7",sources:{},runbooks:{rollback:{restore:'100000000'}},templateId:H('coding-recovery-v1'),ruleVersion:H('static-v1'),modelVersion:H('static-no-model')};
  const commitment=id(),sourceKeys:Record<string,any>={},refs:string[]=[];
  const extra:Record<string,any>={release:{revision:'build-7',occurredAt:q.startAt.toString()},monitor:{revision:'build-7',failure:true},replay:{revision:'build-7',oldPass:true,newPass:false,rollbackPass:true},
    work:{runbook:'rollback',action:'restore',units:'8',unitPrice:'100000000',expenseId:'cost-1',invoiceId:'invoice-1'},completion:{runbook:'rollback',units:'8',expenseId:'cost-1',completed:true},
    payment:{expenseId:'cost-1',invoiceId:'invoice-1',paid:'800000000',compensation:'0',recovery:'0',beneficiary:q.beneficiary,token:q.token,reference:'bank-test-1'}};
  if(loss){
    const units=loss.units??1n;if(units<=0n||loss.gross%units!==0n)throw Error('FIXTURE_NON_INTEGER_UNIT_PRICE');
    trust.runbooks.rollback!.restore=(loss.gross/units).toString();
    extra.work.units=units.toString();extra.work.unitPrice=(loss.gross/units).toString();extra.completion.units=units.toString();
    extra.payment.paid=loss.gross.toString();extra.payment.compensation=loss.compensation.toString();
  }
  for(const kind of Object.keys(extra)){
    const key=generateKeyPairSync('ed25519');sourceKeys[kind]=key;trust.sources[kind]={kind,publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString()};
    const body={kind,deploymentId:c.salt,runtimeDeployment:trust.runtimeDeployment,policyId:q.quoteId,commitment,enterpriseId:q.enterpriseId,workflowHash:q.workflowHash,...extra[kind]};
    const doc={source:kind,body,signature:sign(null,Buffer.from(hash(body)),key.privateKey).toString('base64')},ref=hash(doc);writeFileSync(resolve(dir,ref+'.json'),json(doc));refs.push(ref);
  }
  const n=await c.notice(q,{incidentCommitment:commitment,evidenceHash:H(refs)}),grantId=id(),now=await c.now();
  const g={insurerId:q.insurerId,token:q.token,enterpriseId:q.enterpriseId,fdeId:q.fdeId,productId:q.productId,workflowHash:q.workflowHash,scopeHash:H({templateId:trust.templateId,runbooks:trust.runbooks,sources:trust.sources,runtimeDeployment:trust.runtimeDeployment}),riskGroupId:H('governance-risk'),...{templateId:trust.templateId,ruleVersion:trust.ruleVersion,modelVersion:trust.modelVersion},
    reviewer:c.accounts.outsider.address,authorizer:c.accounts.approver2.address,channel:1,budgetVersion:1n,validFrom:now-1n,validUntil:now+10000n,epoch:0n,reviewLimit:1000n*U,enabled:true};
  const registry={address:await c.read(c.core,'grantRegistry'),abi:(await hre.artifacts.readArtifact('GrantRegistry')).abi};await c.send(registry,'configure',[grantId,g]);
  const request:Request={policyId:q.quoteId,noticeId:n.n.noticeId,grantId,expiresAt:(now+3000n).toString(),refs};
  const makeChain=(who:'outsider'|'approver2'|'executor')=>new Chain(c.core.address,c.salt,custom(c.connection.provider),{[c.accounts[who].address.toLowerCase()]:c.accounts[who]});
  const budgetPath=resolve(dir,'budget.sqlite'),scope=`31337:${c.core.address}:${c.salt}`,budget=new Budget(budgetPath,scope,true);budget.configure(limits(),Number(now),0);budget.mapModel(g.modelVersion,g.riskGroupId);
  const reviewer=new Reviewer(makeChain('outsider'),new Originals(dir,trust),g.reviewer),authorizer=new Authorizer(makeChain('approver2'),new Originals(dir,trust),budget,g.authorizer);
  await authorizer.reconcile();
  const store=new Store(resolve(dir,'executor.sqlite'),scope);
  return {c,dir,q,n,request,g,registry,trust,sourceKeys,reviewer,authorizer,budget,budgetPath,scope,store,makeChain,async enable(approve=true,pay=true){await c.send(registry,'setChannel',[1,approve,pay,H('test switch')]);},close(){budget.close();store.close();}};
}
