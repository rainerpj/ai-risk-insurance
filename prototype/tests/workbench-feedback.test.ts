import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

function page(){
 const elements=new Map<string,any>();
 const node=(tag='div'):any=>({tag,textContent:'',children:[],append(...items:any[]){this.children.push(...items);},replaceChildren(){this.children=[];this.textContent='';}});
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
 const context=createContext({document:{getElementById:element,querySelectorAll:()=>[],createElement:node},sessionStorage:{getItem:()=>'',removeItem(){}},window:{},console});
 runInContext(readFileSync(new URL('../web/app.js',import.meta.url),'utf8'),context);
 const text=(n:any):string=>[n.textContent,...n.children.map(text)].join(' ');
 const buttons=(n:any):number=>(n.tag==='button'?1:0)+n.children.reduce((sum:number,c:any)=>sum+buttons(c),0);
 return {context,element,text,buttons};
}

test('draft confirmation moves to read-only history; reorg and unknown never regain submit buttons',()=>{
 const p=page();
 const draft={id:'decision-1',payload:{d:{netApproved:'33000000000',reviewAmount:'33000000000'},reason:'synthetic'},signatures:{assessment:'a',decision:'d'}};
 p.context.drafts=[draft];
 for(const state of [undefined,'queued','signed','submitted','mined','unknown','confirmed','reorg_pending','failed','unrecognized']){
  p.context.transactions=state?[{id:draft.id,action:'registerDecision',state}]:[];
  runInContext('renderDrafts(drafts,transactions)',p.context);
  const pending=p.element('draftList'),history=p.element('submittedDraftList');
  if(state==='confirmed'){
   assert.doesNotMatch(p.text(pending),/decision-1/);assert.match(p.text(history),/决定已上链确认/);
   assert.equal(p.buttons(pending)+p.buttons(history),0);
  }else{
   assert.match(p.text(pending),/decision-1/);assert.doesNotMatch(p.text(history),/decision-1/);
   assert.equal(p.buttons(pending),state===undefined||state==='failed'?2:0);
   if(state==='reorg_pending')assert.match(p.text(pending),/确认已撤回/);
  }
 }
 // Only a registration transaction with the same business ID may classify a draft.
 p.context.transactions=[{id:draft.id,action:'executePayment',state:'confirmed'},{id:'other',action:'registerDecision',state:'confirmed'}];
 runInContext('renderDrafts(drafts,transactions)',p.context);assert.equal(p.buttons(p.element('draftList')),2);
});

test('payment refusals have actionable Chinese messages and other errors remain visible',async()=>{
 const p=page();
 for(const [code,expected] of [['PAYMENT_FROZEN',/已冻结付款.*解除冻结/],['PAYMENT_NOT_DUE',/没有待付金额.*重复付款/],['PAYMENT_EXCEEDS_DUE',/超过当前待付金额/],['PAYMENT_UNRESOLVED',/尚未确认.*不要重复提交/],['ROLE_DENIED',/ROLE_DENIED/]] as const){
  p.context.code=code;await runInContext('run(async()=>{throw Error(code)})',p.context);
  assert.match(p.element('message').textContent,expected);
 }
});
