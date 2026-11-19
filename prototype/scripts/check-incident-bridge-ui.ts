import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
const elements=new Map<string,any>(),storage=new Map([['incident-session','synthetic-token']]),calls:any[]=[];const $=(id:string)=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',checked:false});return elements.get(id);};
runInNewContext(readFileSync('web/incident-claim-bridge.js','utf8'),{document:{getElementById:$},sessionStorage:{getItem:(k:string)=>storage.get(k)??null,removeItem:(k:string)=>storage.delete(k)},crypto:{randomUUID},fetch:async(url:string,options:any)=>{calls.push({url,...options});return {ok:true,json:async()=>({mapping:{bridgeId:'synthetic'},installed:true,current:false,haltReason:'BRIDGE_HALTED'})};}});
for(const id of ['project','incident','reportId','reviewId','policyId'])$(id).value=id;$('coverageVersion').value='1';$('declaredIncidentAt').value='100';$('confirmSynthetic').checked=true;$('create').onsubmit({preventDefault(){}});await new Promise(setImmediate);
assert.equal(calls[0].url,'/api/incidents-v1/incidents/incident/test-claims');assert.equal(JSON.parse(calls[0].body).confirmSynthetic,true);assert.match($('status').textContent,/停止|失效/);assert.ok(calls.every(c=>!c.url.includes('/api/sign')&&!c.url.includes('/payment')));$('incident').oninput();assert.equal($('result').textContent,'');assert.equal($('confirmSynthetic').checked,false);
console.log('PASS synthetic DOM: mapping-only request, halt status retained and scope clearing. Not browser validation.');
