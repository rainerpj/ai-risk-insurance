const $=id=>document.getElementById(id);let epoch=0,busy=false;const keys=new Map();
function clear(){epoch++;$('result').textContent='';$('confirmSynthetic').checked=false;}
async function api(path,options={}){const token=sessionStorage.getItem('incident-session');if(!token)throw Error('请先登录');const response=await fetch('/api/incidents-v1'+path,{...options,headers:{authorization:'Bearer '+token,...(options.body?{'content-type':'application/json'}:{}),...(options.key?{'idempotency-key':options.key}:{})}});if(!response.ok){if(response.status===401){sessionStorage.removeItem('incident-session');clear();}throw Error((await response.json()).error);}return response.json();}
async function guard(fn){if(busy)return;busy=true;try{await fn();}catch(e){$('status').textContent=e.message;}finally{busy=false;}}
function display(result){$('result').textContent=JSON.stringify(result,null,2);$('status').textContent=result.haltReason||result.current===false?'桥接已停止或源报告失效；禁止后续执行':'映射已读取；源报告状态不代表当前链上可付款';}
$('load').onsubmit=e=>{e.preventDefault();guard(async()=>{clear();const current=epoch,result=await api(`/incidents/${encodeURIComponent($('incident').value)}/test-claims?projectId=${encodeURIComponent($('project').value)}`);if(current===epoch)display(result);});};
$('create').onsubmit=e=>{e.preventDefault();guard(async()=>{const current=epoch,id=$('incident').value,body=JSON.stringify({projectId:$('project').value,reportId:$('reportId').value,reviewId:$('reviewId').value,coverageVersion:Number($('coverageVersion').value),policyId:$('policyId').value,declaredIncidentAt:$('declaredIncidentAt').value,confirmSynthetic:$('confirmSynthetic').checked}),identity=sessionStorage.getItem('incident-session')+id+body,key=keys.get(identity)??crypto.randomUUID();keys.set(identity,key);const result=await api(`/incidents/${encodeURIComponent(id)}/test-claims`,{method:'POST',body,key});if(current===epoch){display(result);}});};
for(const id of ['project','incident','reportId','reviewId','coverageVersion','policyId','declaredIncidentAt'])$(id).oninput=clear;
$('logout').onclick=()=>guard(async()=>{try{await api('/session',{method:'DELETE'});}finally{sessionStorage.removeItem('incident-session');keys.clear();clear();for(const id of ['reportId','reviewId','policyId','declaredIncidentAt'])$(id).value='';$('status').textContent='已退出';}});
$('project').value=sessionStorage.getItem('incident-project')||'';



