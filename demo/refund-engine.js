(function(root){
 'use strict';
 const cryptoApi=()=>globalThis.crypto;
 const clone=x=>JSON.parse(JSON.stringify(x));
 const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
 const bytes=h=>Uint8Array.from(h.match(/../g)||[],v=>parseInt(v,16));
 const utf8=s=>new TextEncoder().encode(s);
 const join=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
 async function hash(b){if(!cryptoApi()?.subtle)throw Error('需要支持 Web Crypto 的浏览器，请通过 localhost 打开。');return hex(await cryptoApi().subtle.digest('SHA-256',b));}
 // Fixed demo schema: ASCII field names, integer amounts and ordinary strings only.
 // This serializer is not advertised as a general RFC 8785 implementation.
 function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
 const split=n=>{let k=1;while(k*2<n)k*=2;return k;};
 const nodeHash=(a,b)=>hash(join(Uint8Array.of(1),bytes(a),bytes(b)));
 async function tree(leaves){if(!leaves.length)return hash(new Uint8Array());if(leaves.length===1)return leaves[0];const k=split(leaves.length);return nodeHash(await tree(leaves.slice(0,k)),await tree(leaves.slice(k)));}
 async function proof(leaves,index){if(index<0||index>=leaves.length)throw Error('叶索引无效');if(leaves.length===1)return [];const k=split(leaves.length);return index<k?[...await proof(leaves.slice(0,k),index),{side:'right',hash:await tree(leaves.slice(k))}]:[...await proof(leaves.slice(k),index-k),{side:'left',hash:await tree(leaves.slice(0,k))}];}
 async function verifyPath(leaf,path,expected){let h=leaf;for(const p of path){if(!['left','right'].includes(p.side))return false;h=p.side==='left'?await nodeHash(p.hash,h):await nodeHash(h,p.hash);}return h===expected;}
 const stages=['接收任务','形成退款方案','授权判断','实际执行','业务结果'];
 function initial(){return {version:1,step:0,started:false,events:[],sealed:null,anchor:null,verification:null,offline:false,incident:null,reviewed:false,decision:null,decisions:[],payments:[],recoveries:[],baseRecovery:20000,plan:'actual',audit:[]};}
 function audit(s,text){s.audit.push({at:new Date().toISOString(),text});}
 function run(s){if(s.started)return;for(let i=1;i<=200;i++){
  const task='TASK-'+String(i).padStart(3,'0'),order='ORDER-'+String(i).padStart(3,'0');
  const payloads=[{order_id:order,order_total_usd:500,prior_refund_usd:250,ticket_status:'completed',application_version:'refund-1.1-bug'},
   {proposed_refund_usd:250,reason:'已完成退款任务被错误重新入队',rule_version:'refund-policy-1.0'},
   {authorization_type:'automatic',human_approval:false,approved_refund_usd:250,manual_threshold_usd:1000,daily_limit_usd:50000},
   {tool:'payment.refund',actual_refund_usd:250,idempotency_key:task+'-retry',request_status:'accepted',payment_id:'PAY-SECOND-'+i},
   {settlement_status:'settled',second_refund_usd:250,total_refunded_usd:500,source:'synthetic-payment-ledger',payment_id:'PAY-SECOND-'+i}];
  payloads.forEach((payload,j)=>s.events.push({event_id:task+'-'+j,task_id:task,stage:j,stage_name:stages[j],occurred_at:new Date(Date.UTC(2026,9,16,2,0,i*5+j)).toISOString(),source_sequence:(i-1)*5+j+1,payload}));
 }
 s.started=true;s.step=1;audit(s,'模拟执行200笔重复退款；达到每日50,000 USD上限，自动执行已暂停。');}
 async function seal(s){if(!s.started)throw Error('请先运行退款工作流');if(s.sealed)return;
  const nonces=s.events.map(()=>hex(cryptoApi().getRandomValues(new Uint8Array(32))));
  const commitments=await Promise.all(s.events.map((e,i)=>hash(join(utf8('FDE-EVIDENCE-v1'),bytes(nonces[i]),utf8(canonical(e))))));
  const leaves=await Promise.all(commitments.map(c=>hash(join(Uint8Array.of(0),bytes(c)))));
  s.sealed={created_at:new Date().toISOString(),nonces,commitments,leaves,root:await tree(leaves),size:leaves.length,firstProof:await proof(leaves,0)};
  audit(s,'本机计算1,000份快照承诺与Merkle批次根；未生成数字签名、未连接链。');}
 function anchor(s){if(!s.sealed)throw Error('请先封存快照');if(s.anchor?.status==='confirmed')return;
  s.anchor={status:s.offline?'queued':'confirmed',network:'SIMULATED-LOCAL-NO-CHAIN',receipt_id:'DEMO-ANCHOR-001',root:s.sealed.root,submitted_at:new Date().toISOString(),confirmed_at:s.offline?null:new Date().toISOString()};
  audit(s,s.offline?'模拟链失联：批次排队，保障状态不变。':'生成模拟存证回执；没有真实区块或链上交易。');}
 async function verify(s){if(!s.sealed)throw Error('请先封存快照');let failed=0,missing=0;
  for(let i=0;i<s.sealed.size;i++){const e=s.events[i];if(!e){missing++;continue;}const c=await hash(join(utf8('FDE-EVIDENCE-v1'),bytes(s.sealed.nonces[i]),utf8(canonical(e))));if(c!==s.sealed.commitments[i])failed++;}
  const inclusion=await verifyPath(s.sealed.leaves[0],s.sealed.firstProof,s.sealed.root);
  s.verification={failed,missing,checked:s.sealed.size,integrity:failed?'failed':missing?'unknown':'passed',inclusion,anchor:s.anchor?.status||'not_submitted',signature:'not_implemented',at:new Date().toISOString()};
  // A changed evidence finding invalidates an unpaid decision; posted payments remain auditable.
  s.reviewed=false;s.decision=null;audit(s,`本机核验：${failed}份摘要不匹配，${missing}份原件缺失；重新进入人工核赔。`);return s.verification;}
 function corrupt(s,mode){if(!s.sealed)throw Error('请先封存原始证据');if(mode==='tamper'&&s.events[0])s.events[0].payload.prior_refund_usd=0;else if(mode==='missing')s.events[0]=null;s.verification=null;s.reviewed=false;s.decision=null;audit(s,mode==='tamper'?'演练：修改第一份原件，封存摘要保持不变。':'演练：移除第一份原件，链上摘要不能还原原文。');}
 function report(s){if(!s.started)throw Error('请先运行退款工作流');if(!s.incident){s.incident={id:'DEMO-CLAIM-001',reported_at:new Date().toISOString(),reporter:'客户财务',cause:'refund-1.1-bug配置与幂等缺陷',tasks:200,status:'已报案 · 待人工复核'};audit(s,'客户直接报案；不以FDE认责、存证确认或完整证据为前提。');}s.step=3;}
 function assess(s){if(!s.incident)throw Error('请先报案');s.reviewed=true;s.decision=null;s.incident.status='已复核 · 待模拟保险人决定';audit(s,'模拟核损员用独立支付台账确认200笔多付、20,000到账追回和3,000处置费；补证结论不改写快照核验结果。');}
 function amounts(s){const recovered=s.baseRecovery+s.recoveries.reduce((n,r)=>n+r.amount,0),net=50000-recovered;
  const actual=Math.min(Math.max(0,net-10000)*.9,300000,1000000),fixed=Math.min(net>=10000?10000:net>=5000?5000:net>=1000?1000:0,20000);
  const economic=s.plan==='actual'?actual:s.plan==='fixed'?fixed:Math.max(actual,fixed),response=3000,total=economic+response,paid=s.payments.reduce((n,p)=>n+p.amount,0);
  return {gross:50000,recovered,net,actual,fixed,economic,response,total,paid,due:Math.round((total-paid)*100)/100,retained:net+response-total};}
 function decide(s){if(!s.reviewed)throw Error('请先完成人工核损');const a=amounts(s);s.decision={id:'DEMO-DECISION-'+(s.audit.length+1),total:a.total,plan:s.plan,at:new Date().toISOString(),evidence_basis:'合成支付台账与费用凭证，人工演练确认'};s.decisions.push(clone(s.decision));s.incident.status='模拟核定完成';audit(s,'模拟保险人确认承保与金额；本机核验不会自动作此决定。');}
 function pay(s){if(!s.decision||s.decision.total!==amounts(s).total||s.decision.plan!==s.plan)throw Error('需要当前核定结果');const a=amounts(s);if(a.due===0)return;
  s.payments.push({id:'DEMO-LEDGER-'+(s.payments.length+1),at:new Date().toISOString(),amount:a.due,decision_id:s.decision.id,kind:a.due>0?'模拟赔款入账':'模拟追回调整',recipient:'示例零售企业（无真实账户）'});audit(s,'模拟结算入账 '+a.due.toFixed(2)+' USD；没有资金转移。');s.incident.status='模拟结算完成';}
 function recover(s){if(s.recoveries.length)return;if(!s.payments.length)throw Error('先完成首次模拟结算');s.recoveries.push({id:'DEMO-RECOVERY-002',amount:15000,at:new Date().toISOString(),source:'synthetic-payment-ledger'});s.reviewed=false;s.decision=null;s.incident.status='新增追回 · 案件重开';audit(s,'新增15,000追回已到账，保留原赔款，重开核损。');}
 function setPlan(s,p){if(!['actual','fixed','hybrid'].includes(p))throw Error('未知方案');if(s.payments.length)throw Error('已结算案件的保障方案不可追溯更换，请重置演练');s.plan=p;s.decision=null;}
 const api={initial,run,seal,anchor,verify,corrupt,report,assess,amounts,decide,pay,recover,setPlan,stages,canonical,hash,tree,proof,verifyPath,clone};
 if(typeof module!=='undefined')module.exports=api;else root.RefundDemo=api;
})(typeof window!=='undefined'?window:globalThis);
