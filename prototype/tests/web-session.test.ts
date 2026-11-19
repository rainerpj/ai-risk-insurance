import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Execute the actual browser script with delayed transport responses. No copied implementation.
test('late authenticated responses cannot render after logout or identity replacement',async()=>{
 const elements=new Map<string,any>();
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:false,children:[],append(...children:any[]){this.children.push(...children);},replaceChildren(){this.children=[];this.textContent='';}});return elements.get(id);};
 let resolveResponse:(value:any)=>void=()=>{};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>({append(){}})},sessionStorage:{getItem:()=>'',removeItem(){},setItem(){}},fetch:()=>new Promise(resolve=>resolveResponse=resolve),window:{},console});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 runInContext("token='old';me={role:'ASSESSOR'}",context);
 const pending=runInContext("run(async()=>{const result=await api('/views/policy');$('policyList').textContent=result.secret;})",context);
 runInContext("token='new'",context);
 resolveResponse({ok:true,json:async()=>({secret:'previous-enterprise'})});await pending;
 assert.equal(element('policyList').textContent,'');assert.equal(element('message').textContent,'');
 runInContext("token='old';me={role:'ASSESSOR'}",context);
 const automation=runInContext('run(refreshAutomation)',context);
 runInContext("token='new';$('automationStatus').textContent='new-session'",context);
 resolveResponse({ok:true,json:async()=>({model:{label:'previous-enterprise'}})});await automation;
 assert.equal(element('automationStatus').textContent,'new-session');
 for(const id of ['policyList','poolList','grantList','budgetList','reservationList','metricsList','measurementList','samplingList','modelCostList','workloadList','intakeCostList','intakeCostHistory','intakeQualityChoices','intakeQualityHistory','intakeFollowupList'])element(id).children=['sensitive'];
 const logout=element('logout').onclick();resolveResponse({ok:true,json:async()=>({})});await logout;
 for(const id of ['policyList','poolList','grantList','budgetList','reservationList','metricsList','measurementList','samplingList','modelCostList','workloadList','intakeCostList','intakeCostHistory','intakeQualityChoices','intakeQualityHistory','intakeFollowupList'])assert.deepEqual(element(id).children,[]);
 assert.equal(element('intakeQualityForm').hidden,true);assert.equal(element('intakeResolveForm').hidden,true);assert.equal(element('intakeCostForm').hidden,true);assert.equal(element('measurementForm').hidden,true);assert.equal(element('metricsStatus').textContent,'');
 assert.equal(element('samplingStatus').textContent,'');assert.equal(element('workspace').hidden,true);assert.equal(element('login').hidden,false);
 assert.equal(runInContext('token',context),'');assert.equal(runInContext('me',context),undefined);
});

test('metric controls preserve null versus zero and delayed metrics cannot replace a new identity view',async()=>{
 const elements=new Map<string,any>(),pending:((v:any)=>void)[]=[];
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:false,children:[],append(...c:any[]){this.children.push(...c);},replaceChildren(){this.children=[];this.textContent='';}});return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:()=>({append(){}})},sessionStorage:{getItem:()=>'',setItem(){},removeItem(){}},fetch:()=>new Promise(resolve=>pending.push(resolve)),window:{},console});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 for(const fn of ['measuredInteger','measuredMoney','measuredBool'])assert.equal(runInContext(`${fn}('field')`,context),null);
 element('field').value='0';assert.equal(runInContext("measuredInteger('field')",context),'0');assert.equal(runInContext("measuredMoney('field')",context),'0');
 element('field').value='false';assert.equal(runInContext("measuredBool('field')",context),false);element('field').value='1.5';assert.throws(()=>runInContext("measuredInteger('field')",context));
 assert.equal(runInContext("meanLabel({mean:{numerator:'1',denominator:1}},1000000n)",context),'约 0.000001');
 assert.equal(runInContext("countLabel({observations:0,sum:null})",context),'未知（无已核实样本）');
 runInContext("token='old';me={role:'ASSESSOR',address:'a'}",context);const task=runInContext('run(()=>refreshMetrics([]))',context);
 runInContext("token='new';$('metricsStatus').textContent='new enterprise'",context);
 for(const resolve of pending)resolve({ok:true,json:async()=>({private:'previous enterprise'})});await task;
 assert.equal(element('metricsStatus').textContent,'new enterprise');assert.deepEqual(element('metricsList').children,[]);
 runInContext("token='sample-old'",context);const sampleTask=runInContext('run(refreshSamples)',context);
 runInContext("token='sample-new';$('samplingStatus').textContent='new sample enterprise'",context);
 pending.at(-1)!({ok:true,json:async()=>({private:'previous sample enterprise'})});await sampleTask;
 assert.equal(element('samplingStatus').textContent,'new sample enterprise');assert.deepEqual(element('samplingList').children,[]); runInContext("token='workload-old'",context);const workload=runInContext('run(refreshWorkload)',context);
 runInContext("token='workload-new'",context);element('workloadList').children=['new enterprise'];
 pending.at(-1)!({ok:true,json:async()=>({private:'old enterprise'})});await workload;assert.deepEqual(element('workloadList').children,['new enterprise']);
});

test('intake resolution excludes original author and supervisor opinions and preserves retry ID on server rejection',async()=>{
 const elements=new Map<string,any>(),requests:any[]=[];
 const node=()=>({value:'',textContent:'',hidden:false,children:[] as any[],append(...c:any[]){this.children.push(...c);},replaceChildren(){this.children=[];this.value='';}});
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:node},sessionStorage:{getItem:()=>''},window:{},console,Uint8Array,crypto:{getRandomValues:(v:Uint8Array)=>v.fill(2)},fetch:async(path:string,options:any)=>{requests.push({path,body:JSON.parse(options.body)});return {ok:false,json:async()=>({error:'REVIEW_SUPERSEDED'})};}});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 const review=(id:string,actor:string,notice='notice')=>({id,actor,notice_id:notice,proof_state:'canonical',payload:{outcome:'no_issue_observed',sourceHash:'source',reason:'followup'}});
 const trigger={id:'trigger',actor:'reporter',notice_id:'notice',proof_state:'canonical',payload:{disposition:'pending_independent_resolution',sourceHash:'source',outcome:'missed_escalation'}};
 (context as any).rows=[review('good','independent'),review('self','me'),review('author','reporter'),review('foreign','independent','foreign'),trigger];
 runInContext("token='session';me={role:'ASSESSOR',address:'me'};renderIntakeResolution(rows,[],[])",context);assert.equal(element('intakeResolveForm').hidden,true);
 runInContext("me.role='SUPERVISOR';renderIntakeResolution(rows,[],[])",context);element('irTrigger').value='trigger';element('irTrigger').onchange();element('irType').value='false_alarm';element('irType').onchange();
 assert.deepEqual(element('irReview').children.map((o:any)=>o.value),['','good']);
 element('irReview').value='good';element('irReason').value='supervisor evidence';await element('intakeResolveSubmit').onclick();const first=element('irId').value;await element('intakeResolveSubmit').onclick();assert.equal(requests.length,2);assert.equal(requests[0].body.id,requests[1].body.id);assert.equal(element('irId').value,first);assert.equal(element('message').textContent,'REVIEW_SUPERSEDED');
});

test('pool cards distinguish restricted unsolicited transfers from withdrawable capital',()=>{
 const elements=new Map<string,any>();
 const node=()=>({textContent:'',children:[] as any[],append(...c:any[]){this.children.push(...c);},replaceChildren(){this.children=[];this.textContent='';}});
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:node},sessionStorage:{getItem:()=>''},window:{},console});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 const texts=(n:any):string=>[n.textContent,...n.children.map(texts)].join(' ');
 runInContext("renderPools([{id:'synthetic',payload:{balances:['10000000','7000000','1000000'],H:'1000000',K:'0',B:'1000000'}}])",context);
 assert.match(texts(element('poolList')),/U 7\.000000 \/ W 1\.000000/);assert.match(texts(element('poolList')),/待对账/);assert.match(texts(element('poolList')),/不代表保费或投保成功/);
 runInContext("renderPools([{id:'synthetic',payload:{balances:['3000000','0','1000000'],H:'1000000',K:'0',B:'1000000'}}])",context);
 assert.match(texts(element('poolList')),/没有已确认的意外转入/);assert.doesNotMatch(texts(element('poolList')),/存在待对账/);
});

test('notice grouping cards disclose unknown amount and unverified identity instead of implying a merged approval',()=>{
 const elements=new Map<string,any>();
 const node=()=>({textContent:'',children:[] as any[],append(...c:any[]){this.children.push(...c);},replaceChildren(){this.children=[];}});
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:node},sessionStorage:{getItem:()=>''},window:{},console});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 const texts=(n:any):string=>[n.textContent,...n.children.map(texts)].join(' ');
 runInContext("renderNoticeGroups({chainState:'unavailable',groups:[{requiresAggregation:true,policyId:'policy',commitment:'commitment',localOnly:2,notices:[{id:'first'},{id:'second'}]}]})",context);
 const rendered=texts(element('noticeList'));assert.match(rendered,/去重通知 2/);assert.match(rendered,/first、second/);assert.match(rendered,/累计申请额未知/);assert.match(rendered,/仅是归集线索/);assert.match(rendered,/仅展示本地受理/);
  element('noticeList').replaceChildren();
  runInContext("renderNoticeGroups({chainState:'confirmed',groups:[{requiresAggregation:true,policyId:'policy',commitment:'commitment',localOnly:0,claimedTotal:'10800000000',notices:[{id:'first'},{id:'second'}]}]})",context);
  assert.match(texts(element('noticeList')),/累计声明申请 10800.000000/);assert.match(texts(element('noticeList')),/未核损/);assert.doesNotMatch(texts(element('noticeList')),/累计申请额未知/);
});

test('model cost cards distinguish unknown, micro-dollar values and unavailable service',()=>{
 const elements=new Map<string,any>();
 const node=()=>({textContent:'',children:[] as any[],append(...c:any[]){this.children.push(...c);},replaceChildren(){this.children=[];}});
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:node},sessionStorage:{getItem:()=>''},window:{},console});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 const texts=(n:any):string=>[n.textContent,...n.children.map(texts)].join(' ');
 runInContext("renderModelCosts({state:'available',price:{model:'stub',version:'synthetic'},jobs:1,calls:2,settledCalls:1,settledEstimatedMicroUSD:'1',unresolvedReservedMicroUSD:'20',budgetOccupiedMicroUSD:'21',reservedCalls:0,unknownCalls:1,complete:false,tokens:{knownCalls:1,input:'0',cachedInput:'0',output:'0'}})",context);
 assert.match(texts(element('modelCostList')),/0.000001 USD/);assert.match(texts(element('modelCostList')),/输入 0/);assert.match(texts(element('modelCostList')),/用量不完整/);
 runInContext("renderModelCosts({state:'unavailable'})",context);assert.match(texts(element('modelCostList')),/不能视为零费用/);assert.doesNotMatch(texts(element('modelCostList')),/0.000001/);
 runInContext("renderModelCosts({state:'not_configured'})",context);assert.match(texts(element('modelCostList')),/尚未配置/);
});

test('supervisor resolution form filters own and foreign opinions, requires explicit choice, and preserves retry ID on failure',async()=>{
 const elements=new Map<string,any>(),requests:any[]=[];
 const node=()=>({value:'',hidden:false,textContent:'',children:[] as any[],append(...c:any[]){this.children.push(...c);},replaceChildren(){this.children=[];this.value='';}});
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:node},sessionStorage:{getItem:()=>''},window:{},console,Uint8Array,crypto:{getRandomValues:(v:Uint8Array)=>v.fill(1)},fetch:async(path:string,options:any)=>{requests.push({path,body:JSON.parse(options.body)});return {ok:false,status:409,json:async()=>({error:'INDEPENDENT_CURRENT_REVIEW_REQUIRED'})};}});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 const cases=[{id:'case',incident:'incident',decision_version:'1',state:'reviewed',trigger_id:'trigger'}];
 const review=(id:string,actor:string,incident='incident')=>({id,actor,incident,proof_state:'canonical',payload:{outcome:'correct',decisionVersion:'2',reason:'verified'}});
 (context as any).cases=cases;(context as any).reviews=[review('eligible','other'),review('self','me'),review('foreign','other','foreign'),review('trigger','other')];
 runInContext("token='session';me={role:'ASSESSOR',address:'me'};renderResolutionForm(cases,reviews)",context);assert.equal(element('resolutionForm').hidden,true);
 runInContext("me.role='SUPERVISOR';renderResolutionForm(cases,reviews)",context);assert.equal(element('resolutionForm').hidden,false);
 element('resolutionCase').value='case';element('resolutionCase').onchange();assert.deepEqual(element('resolutionReview').children.map((o:any)=>o.value),['','eligible']);
 element('resolutionReview').value='eligible';element('resolutionReason').value='supervisor basis';await element('resolutionSubmit').onclick();assert.equal(requests.length,0);
 element('resolutionType').value='corrected';await element('resolutionSubmit').onclick();const id=element('resolutionId').value;assert.match(id,/^0x01/);await element('resolutionSubmit').onclick();assert.equal(requests.length,2);assert.equal(requests[0].body.id,requests[1].body.id);assert.equal(element('resolutionId').value,id);assert.equal(element('message').textContent,'INDEPENDENT_CURRENT_REVIEW_REQUIRED');
});



