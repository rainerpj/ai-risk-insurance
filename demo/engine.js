(function(root){
 'use strict';
 const presets={
 drama:{name:'AI 短剧',unit:'集交付成片',service:60000,volume:120,reference:120,frequency:20,losses:[5000,30000,150000],weights:[60,30,10],responses:[1000,3000,12000],legals:[0,10000,40000],gross:40000,recovery:5000,response:3000,legal:10000,event:'生成内容发生权利争议，已发布剧集需下架替换',scope:'已核实的素材替换、必要重制增量成本；另选事故处置与抗辩费用。预期票房、声誉损失、罚款、侵权和解及判赔不在本 Demo 中。',evidence:'交付版本与素材来源 → 权利主张/下架通知 → 受影响镜头清单 → 增量重制发票 → 已收补偿记录',grossLabel:'必要重制与替换的增量成本',recoveryLabel:'已收素材商补偿/其他赔款'},
 support:{name:'AI 智能客服',unit:'次已执行退款/补偿',service:44000,volume:20000,reference:20000,frequency:20,losses:[3000,30000,120000],weights:[60,30,10],responses:[500,3000,10000],legals:[0,5000,20000],gross:50000,recovery:20000,response:3000,legal:0,event:'客服工作流重复执行退款，造成客户实际资金损失',scope:'已执行错误退款或经核实须履行的错误补偿承诺。正常应付退款不计损失；仅生成但未执行的回复不自动产生经济赔款。罚款、第三方判赔不在本 Demo 中。',evidence:'批准的业务规则 → 会话与工具执行日志 → 支付结算流水 → 追回款到账记录 → 单一缺陷与批量归因',grossLabel:'错误支付/补偿的实际额外支出',recoveryLabel:'已追回款/其他同损失补偿'}
 };
 function initial(key){const p=presets[key];return {industry:key,plan:'actual',region:'新加坡',volume:p.volume,reference:p.reference,service:p.service,frequency:p.frequency,losses:[...p.losses],weights:[...p.weights],responses:[...p.responses],legals:[...p.legals],deductible:10000,share:90,eventCap:300000,annualCap:1000000,remaining:1000000,fixed:10000,fixedAnnual:20000,fixedRemaining:20000,responseOn:true,responseCap:100000,responseAnnual:200000,responseRemaining:200000,legalOn:false,legalCap:50000,legalAnnual:100000,legalRemaining:100000,expense:900,loading:35,gross:p.gross,recovery:p.recovery,response:p.response,legal:p.legal,paid:0,active:true,causal:true,evidence:true,excluded:false};}
 const nonneg=(v)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
 function validate(s){
  const errors=[];
  for(const k of ['volume','reference','service','frequency','deductible','share','eventCap','annualCap','remaining','fixed','fixedAnnual','fixedRemaining','responseCap','responseAnnual','responseRemaining','legalCap','legalAnnual','legalRemaining','expense','loading','gross','recovery','response','legal','paid'])if(!nonneg(s[k]))errors.push(k+' 必须为非负有限数字');
  for(const k of ['losses','weights','responses','legals'])if(!Array.isArray(s[k])||s[k].length!==3||!s[k].every(nonneg))errors.push(k+' 的三档参数无效');
  if(errors.length)return errors;
  if(s.reference<=0)errors.push('参考业务量必须大于 0');
  if(s.share>100||s.frequency>100||s.loading>=100)errors.push('赔付比例/事故概率不得超过 100%，费用加载必须低于 100%');
  if(Math.abs(s.weights.reduce((a,b)=>a+b,0)-100)>0.001)errors.push('三档事故权重之和必须为 100%');
  if(s.frequency*s.volume/s.reference>100)errors.push('放大后的年度事故概率超过 100%；请重新校准，不能直接线性外推');
  for(const [r,a]of [['remaining','annualCap'],['fixedRemaining','fixedAnnual'],['responseRemaining','responseAnnual'],['legalRemaining','legalAnnual']])if(s[r]>s[a])errors.push(r+' 不得超过年度总限额');
  if(s.recovery>s.gross)errors.push('本事故已收追回款不能超过申报经济支出');
  if(!['actual','fixed','hybrid'].includes(s.plan)||!presets[s.industry])errors.push('行业或方案无效');
  for(const k of ['responseOn','legalOn','active','causal','evidence','excluded'])if(typeof s[k]!=='boolean')errors.push(k+' 必须为布尔值');
  return errors;
 }
 function payout(s,net,response,legal,plan=s.plan,fresh=false){
  const annual=fresh?s.annualCap:s.remaining, fixedAnnual=fresh?s.fixedAnnual:s.fixedRemaining;
  const actual=Math.min(Math.max(0,net-s.deductible)*s.share/100,s.eventCap,annual);
  const fixed=net>=s.fixed&&s.fixed>0?Math.min(s.fixed,s.eventCap,annual,fixedAnnual):0;
  const economic=plan==='actual'?actual:plan==='fixed'?fixed:Math.max(actual,fixed);
  const responsePay=s.responseOn?Math.min(response,s.responseCap,fresh?s.responseAnnual:s.responseRemaining):0;
  const legalPay=s.legalOn?Math.min(legal,s.legalCap,fresh?s.legalAnnual:s.legalRemaining):0;
  return {actual,fixed,economic,responsePay,legalPay,total:economic+responsePay+legalPay};
 }
 function calculate(s){
  const errors=validate(s);if(errors.length)return {errors};
  const probability=s.frequency/100*s.volume/s.reference;
  const quote=['actual','fixed','hybrid'].map(plan=>{const rows=s.losses.map((n,i)=>({...payout(s,n,s.responses[i],s.legals[i],plan,true),probability:probability*s.weights[i]/100}));const expected=rows.reduce((a,r)=>a+r.total*r.probability,0);return {plan,expected,premium:(expected+s.expense)/(1-s.loading/100),rows};});
  const net=s.gross-s.recovery;const eligible=s.active&&s.causal&&s.evidence&&!s.excluded;
  const status=!s.active?'暂不符合：事故不在有效保障期或登记范围':s.excluded?'转人工审查：标记存在除外事项':!s.causal||!s.evidence?'待补证：尚不能核定赔款':'演示条件满足：可计算建议金额';
  const claims=eligible?['actual','fixed','hybrid'].map(plan=>{const p=payout(s,net,s.response,s.legal,plan);return {plan,...p,retained:net+s.response+s.legal-p.total,settlement:p.total-s.paid};}):[];
  return {errors:[],probability,quote,net,eligible,status,claims};
 }
 const api={presets,initial,validate,payout,calculate};if(typeof module!=='undefined')module.exports=api;else root.InsuranceDemo=api;
})(typeof window!=='undefined'?window:globalThis);
