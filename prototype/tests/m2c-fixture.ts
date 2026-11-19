import {generateKeyPairSync,sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {autoFixture,limits} from './m2b-fixture.ts';
import {hash,json} from '../packages/service/store.ts';
import {Originals,H} from '../packages/service/reviewer.ts';
import {semanticScope} from '../packages/service/semantic-review.ts';
import {U,id} from './chain-helper.ts';
import {AgentEvidenceTools,type AgentProposal} from '../packages/service/agent.ts';
export async function semanticFixture(prices={recovery:'1000000000',emergency:'1000000000'},options:Parameters<typeof autoFixture>[0]={}){
 const f=await autoFixture(options),commitment=id(),trust=f.trust;
 trust.modelVersion=H('stub-semantic-v1');trust.ruleVersion=H('semantic-v2');trust.runbooks={recovery:{restore:prices.recovery},emergency:{mitigate:prices.emergency}};
 trust.semantic={'recovery:restore':{category:0,maxUnits:'4'},'emergency:mitigate':{category:1,maxUnits:'1'}};
 const key=generateKeyPairSync('ed25519');f.sourceKeys.ticket=key;trust.sources.ticket={kind:'ticket',publicKey:key.publicKey.export({type:'spki',format:'pem'}).toString()};
 const scope={enterpriseId:f.q.enterpriseId,policyId:f.q.quoteId,deploymentId:f.c.salt,runtimeDeployment:trust.runtimeDeployment,commitment,workflowHash:f.q.workflowHash};
 function put(kind:string,fields:any){const body={...scope,kind,...fields},doc={source:kind,body,signature:sign(null,Buffer.from(hash(body)),f.sourceKeys[kind].privateKey).toString('base64')},ref=hash(doc);writeFileSync(resolve(f.dir,ref+'.json'),json(doc));return ref;}
 const refs=[put('release',{revision:'build-7',occurredAt:f.q.startAt.toString()}),put('monitor',{revision:'build-7',failure:true}),put('replay',{revision:'build-7',oldPass:true,newPass:false,rollbackPass:true})];
 const proposal:AgentProposal={route:'recommend',items:[],reason:'stub extraction; independently matched signed originals'};
 for(const [runbook,action,units] of [['recovery','restore','4'],['emergency','mitigate','1']]){
  const expenseId=runbook!,price=prices[runbook as keyof typeof prices],display=(BigInt(price)/1000000n).toString()+'.'+(BigInt(price)%1000000n).toString().padStart(6,'0'),quote=runbook==='recovery'?`恢复工单：完成4个恢复单元，每个${display}测试币。`:`应急工单：完成1个应急单元，费用${display}测试币。`;
  const ticketRef=put('ticket',{expenseId,narrative:quote}),workRef=put('work',{runbook,action,units,unitPrice:price,expenseId,invoiceId:expenseId}),completionRef=put('completion',{runbook,units,expenseId,completed:true}),paymentRef=put('payment',{expenseId,invoiceId:expenseId,paid:(BigInt(units!)*BigInt(price)).toString(),compensation:'0',recovery:'0',beneficiary:f.q.beneficiary,token:f.q.token,reference:'bank-'+expenseId});
  refs.push(ticketRef,workRef,completionRef,paymentRef);proposal.items.push({ticketRef,workRef,completionRef,paymentRef,quote,action:action!,units:units!,unitPrice:price,expenseId});
 }
 const originals=new Originals(f.dir,trust),g={...f.g,channel:2,budgetVersion:2n,ruleVersion:trust.ruleVersion,modelVersion:trust.modelVersion,reviewLimit:10000n*U,scopeHash:semanticScope(originals)};
 await f.c.send(f.registry,'configure',[f.request.grantId,g]);
 const n=await f.c.notice(f.q,{incidentCommitment:commitment,evidenceHash:H(refs)}),request={...f.request,noticeId:n.n.noticeId,refs};
 f.budget.pause();f.budget.configure(limits(10000n*U,5,'2'),Number(await f.c.now()),0);f.budget.mapModel(trust.modelVersion,g.riskGroupId);await f.authorizer.reconcile();
 return {...f,g,n,request,originals,proposal,refs,scope,put,tools:new AgentEvidenceTools(originals,scope,refs),async enable(approve=true,pay=true){await f.c.send(f.registry,'setChannel',[2,approve,pay,H('explicit synthetic L2 test')]);}};
}
