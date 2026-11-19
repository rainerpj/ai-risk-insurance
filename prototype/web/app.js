const $=id=>document.getElementById(id);let token=sessionStorage.getItem('fde-session')||'',challenge,me;
const message=v=>$('message').textContent=v;
const errorMessages={PAYMENT_FROZEN:'该事故已冻结付款。请先核对冻结原因，由有权限的核赔员解除冻结并确认后再付款。',PAYMENT_NOT_DUE:'该事故当前没有待付金额，请勿重复付款。',PAYMENT_EXCEEDS_DUE:'本期付款金额超过当前待付金额，请刷新账本后调整。',PAYMENT_UNRESOLVED:'已有付款交易尚未确认，请在“交易与审阅”中核对原交易，不要重复提交。'};
async function api(path,body){const session=token;const r=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();if(session!==token)throw Error('STALE_SESSION');if(!r.ok)throw Error(v.error||r.status);return v;}
function bind(id,fn){$(id).onclick=()=>run(fn);}
async function run(fn){try{await fn();}catch(e){if(e.message!=='STALE_SESSION')message(errorMessages[e.message]||e.message);}}
function units(value){if(!/^\d+(\.\d{1,6})?$/.test(value))throw Error('金额须为非负数，最多六位小数');const [a,b='']=value.split('.');return (BigInt(a)*1000000n+BigInt(b.padEnd(6,'0'))).toString();}
function money(v){const n=BigInt(v);return `${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;}
function randomId(){return '0x'+Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');}
function card(target,title,lines,detail){const c=document.createElement('div');c.className='card';const h=document.createElement('h3');h.textContent=title;c.append(h);for(const line of lines){const p=document.createElement('p');p.textContent=line;c.append(p);}if(detail){const d=document.createElement('details'),s=document.createElement('summary'),p=document.createElement('pre');s.textContent='查看原始记录';p.textContent=JSON.stringify(detail,null,2);d.append(s,p);c.append(d);}$(target).append(c);return c;}
function clear(id,rows){$(id).replaceChildren();if(!rows.length){const p=document.createElement('p');p.className='empty';p.textContent='暂无本身份可查看的记录';$(id).append(p);}}
async function refresh(){me=await api('/me');$('login').hidden=true;$('workspace').hidden=false;$('identity').textContent=`${me.role} · ${me.address}`;const status=await api('/status');$('chainStatus').textContent=`链头 ${status.head??'待同步'} / 已确认 ${status.confirmed??'待同步'} · ${status.halted||status.indexError||'本地索引可用'}`;
 const [policies,notices,incidents,drafts,reviews,transactions]=await Promise.all(['/views/policy','/notices','/views/incident','/drafts','/reviews','/transactions'].map(p=>api(p)));
 clear('policyList',policies);for(const r of policies){const p=r.payload;card('policyList',r.id,[`保费 ${money(p.quote.premium)} / 年度保额 ${money(p.quote.annualLimit)}`,`历史实付 ${money(p.paidTotal)} / 待付 ${money(p.dueTotal)}`],p);}
 clear('noticeList',notices);for(const n of notices){const chain=n.chain?JSON.parse(n.chain):null;card('noticeList',n.id,[n.payload.summary,`事故声明 ${n.payload.declaredIncidentAt} / 本地受理 ${n.received_at}`,`通知上链 ${chain?.anchoredAt??'未确认'} / ${chain?'confirmed':n.state}`,n.evidenceStatus?.originals==='missing'?'原件缺失，待补充':`已保存原件 ${n.evidenceStatus?.originalCount??'未知'} 份，尚未核验`,'通知上链不代表原件、签名或证据锚定已核验；材料缺口不自动形成拒赔。'],n);}
 clear('incidentList',incidents);for(const r of incidents){const i=r.payload;card('incidentList',r.id,[`决定 v${i.version} · ${i.frozen?'已冻结':'可执行'} · ${i.manualHold?'人工接管':Number(i.decision?.channel)===1?'程序通道':Number(i.decision?.channel)===2?'Agent通道':'人工通道'}`,['P','R','N','D','Q'].map(k=>`${k} ${money(i[k])}`).join(' / ')],i);}
 renderDrafts(drafts,transactions);
 clear('reviewList',reviews);for(const r of reviews)card('reviewList',`${r.role} · ${r.created_at}`,[r.reason,r.actor],r);
 clear('transactionList',transactions);for(const r of transactions)card('transactionList',`${r.action} · ${r.state}`,[r.id,r.tx_hash||'尚未签署广播',r.error||''],r);
 if(['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(me.role))renderNoticeGroups(await api('/notice-groups'));
 await refreshAutomation();
 await refreshSupplement();
 if(me.role!=='insured'){renderPools(await api('/views/pool'));}else{$('poolList').textContent='企业身份无金库运营权限。';}}
function renderDrafts(drafts,transactions){
 const jobs=new Map(transactions.filter(t=>t.action==='registerDecision').map(t=>[t.id,t]));
 const confirmed=r=>jobs.get(r.id)?.state==='confirmed';
 clear('draftList',drafts.filter(r=>!confirmed(r)));clear('submittedDraftList',drafts.filter(confirmed));
 const labels={confirmed:'决定已上链确认，保留签署记录',queued:'已提交，等待签署广播',signed:'已签署交易，等待广播',submitted:'已广播，等待链上确认',mined:'已入块，等待足够确认',unknown:'交易结果未知，请核对原交易，勿重复提交',reorg_pending:'链上确认已撤回，等待重组对账，勿重复提交',failed:'上次交易失败，请核对账本及失败原因后重试'};
 for(const r of drafts){const d=r.payload,job=jobs.get(r.id),state=job?.state;
  const c=card(confirmed(r)?'submittedDraftList':'draftList',r.id,[state?(labels[state]||'交易状态待核对，请勿重复提交'):'待复核签署',`累计批准 ${money(d.d.netApproved)} / 审阅金额 ${money(d.d.reviewAmount)}`,d.reason,`核损 ${r.signatures.assessment?'已签':'待签'} · 核赔 ${r.signatures.decision?'已签':'待签'} · 主管 ${BigInt(d.d.reviewAmount)>50000000000n?(r.signatures.supervisorSignature?'已签':'待签'):'无需'}`],d);
  if(job&&state!=='failed')continue;
  for(const [label,action] of [['以当前审核身份签署','sign'],['提交已共同签署决定','submit']]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>run(async()=>{await api(`/drafts/${r.id}/${action}`,{});message('操作已保存；链上状态以确认记录为准');await refresh();});c.append(b);}
 }
}
function renderNoticeGroups(data){for(const g of data.groups.filter(g=>g.requiresAggregation))card('noticeList','待人工归集的报案组',[`保单 ${g.policyId??'未绑定'} / 事故承诺 ${g.commitment??'未知'}`,`去重通知 ${g.notices.length} / 尚未确认 ${g.localOnly}`,`通知编号：${g.notices.map(n=>n.id).join('、')}`,g.claimedTotal==null?'累计申请额未知：仍有缺少金额的通知，不能按零或单份金额自动批准。':`累计声明申请 ${money(g.claimedTotal)}（未核损，仍需核验重复费用）`,'相同事故承诺仅是归集线索，需人工核验；本地待补链通知尚不能被链上自动授权检查发现。',data.chainState==='confirmed'?'已核验索引检查点':'链上状态不可核验，仅展示本地受理'],g);}
function renderPools(pools){clear('poolList',pools);for(const r of pools){const p=r.payload;card('poolList',r.id,[`A ${money(p.balances[0])} / H ${money(p.H)} / K ${money(p.K)}`,`B ${money(p.B)} / U ${money(p.balances[1])} / W ${money(p.balances[2])}`,BigInt(p.balances[1])>0n?'存在待对账的意外转入；该金额受限，不增加可提款额度，不代表保费或投保成功。':'没有已确认的意外转入余额。'],p);}}
bind('challenge',async()=>{challenge=await api('/auth/challenge',{address:$('address').value.trim()});$('challengeText').value=challenge.message;message('请使用该地址的钱包签署挑战');});
bind('loginButton',async()=>{if(!challenge)throw Error('请先获取挑战');const r=await api('/auth/login',{id:challenge.id,signature:$('signature').value.trim()});token=r.token;sessionStorage.setItem('fde-session',token);$('signature').value='';await refresh();message('认证成功');});
bind('wallet',async()=>{if(!window.ethereum)throw Error('未检测到钱包扩展，可使用签名粘贴登录');const [address]=await window.ethereum.request({method:'eth_requestAccounts'});$('address').value=address;challenge=await api('/auth/challenge',{address});$('challengeText').value=challenge.message;$('signature').value=await window.ethereum.request({method:'personal_sign',params:['0x'+Array.from(new TextEncoder().encode(challenge.message),x=>x.toString(16).padStart(2,'0')).join(''),address]});$('loginButton').click();});
bind('logout',async()=>{await api('/logout',{});token='';me=undefined;challenge=undefined;sessionStorage.removeItem('fde-session');for(const id of ['policyList','noticeList','incidentList','draftList','submittedDraftList','reviewList','transactionList','poolList','channelList','grantList','budgetList','reservationList','automaticPaymentList','qualityList','qualityCases','supplementList','metricsList','measurementList','samplingList','modelCostList','workloadList','intakeCostList','intakeCostHistory','intakeQualityChoices','intakeQualityHistory','intakeFollowupList'])$(id).replaceChildren();for(const id of ['identity','chainStatus','automationStatus','supplementStatus','metricsStatus','samplingStatus'])$(id).textContent='';$('challengeText').value='';$('signature').value='';for(const field of document.querySelectorAll('#workspace input,#workspace textarea,#workspace select'))field.value=field.tagName==='SELECT'?(field.options[0]?.value??''):field.defaultValue; $('intakeCostForm').hidden=true;$('intakeQualityForm').hidden=true;$('intakeResolveForm').hidden=true;$('qualityPanel').hidden=true;$('measurementForm').hidden=true;$('metricsStatus').textContent='';$('samplingStatus').textContent='';$('measurementForm').hidden=true;$('supplementForm').hidden=true;$('login').hidden=false;$('workspace').hidden=true;message('已退出');});bind('refresh',async()=>{await refresh();message('已刷新，以已确认账本与交易状态为准');});
for(const b of document.querySelectorAll('[data-tab]'))b.onclick=()=>{for(const s of document.querySelectorAll('.tab'))s.hidden=s.id!==b.dataset.tab;for(const n of document.querySelectorAll('[data-tab]'))n.classList.toggle('active',n===b);};
for(let i=0;i<2;i++)for(const [key,label] of [['gross','毛费用'],['duplicate','去重扣减'],['compensation','其他补偿'],['recovery','业务追回']]){const l=document.createElement('label');l.textContent=`${i?'应急':'恢复'} · ${label}`;const input=document.createElement('input');input.id=`expense-${i}-${key}`;input.defaultValue='0.000000';input.inputMode='decimal';l.append(input);$('expenseInputs').append(l);}
bind('draftCreate',async()=>{const expenses=[0,1].map(i=>Object.fromEntries(['gross','duplicate','compensation','recovery'].map(k=>[k,units($(`expense-${i}-${k}`).value)]))),noticeIds=$('reviewNotices').value.split(',').map(v=>v.trim());const aggregation=noticeIds.length>1?{confirmed:$('reviewAggregation').value==='confirmed',reason:$('reviewAggregationReason').value,claimedTotal:units($('reviewClaimedTotal').value)}:undefined;const r=await api('/drafts',{policyId:$('reviewPolicy').value.trim(),incidentId:$('reviewIncident').value.trim()||randomId(),noticeIds,approver:$('reviewApprover').value.trim(),expenses,reason:$('reviewReason').value,...($('reviewTemplate').value.trim()?{templateId:$('reviewTemplate').value.trim()}:{}),...(aggregation?{aggregation}:{})});message(`核损草稿已保存 ${r.id}，等待独立核赔签署`);await refresh();});
for(const b of document.querySelectorAll('[data-action]'))b.onclick=()=>run(async()=>{const result=await api('/manual/'+b.dataset.action,{incidentId:$('actionIncident').value.trim(),reason:$('actionReason').value,...(b.dataset.action==='payment'?{amount:units($('paymentAmount').value)}:{})});message(`交易 ${result.id} 已排队，尚未确认`);await refresh();});
bind('intakeSubmit',async()=>{const r=await api('/notices',JSON.parse($('intake').value));message(`已持久化受理 ${r.noticeId} / ${r.receivedAt}`);await refresh();});bind('bindSubmit',async()=>{await api(`/notices/${$('bindNotice').value.trim()}/bind`,JSON.parse($('bindPayload').value));message('已保存绑定并排队，等待链上确认');await refresh();});
bind('evidenceSubmit',async()=>{const file=$('evidenceFile').files[0];if(!file||file.size>1048576)throw Error('请选择不超过 1 MiB 的文件');const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(const b of bytes)raw+=String.fromCharCode(b);const r=await api(`/notices/${$('evidenceNotice').value.trim()}/evidence`,{contentBase64:btoa(raw),mediaType:file.type||'application/octet-stream'});message(`原件已保存 ${r.id} / SHA256 ${r.digest}`);await refresh();});
bind('export',async()=>{const data=await api('/exports',{}),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='fde-tenant-review.json';a.click();URL.revokeObjectURL(url);message('已导出当前企业审阅包');});if(token)run(refresh);

async function refreshAutomation(){
 $('intakeCostForm').hidden=true;$('intakeQualityForm').hidden=true;$('intakeResolveForm').hidden=true;$('qualityPanel').hidden=true;$('measurementForm').hidden=true;$('metricsStatus').textContent='';$('samplingStatus').textContent='';
 for(const id of ['channelList','grantList','budgetList','reservationList','automaticPaymentList','qualityList','qualityCases','metricsList','measurementList','samplingList','modelCostList','workloadList','intakeCostList','intakeCostHistory','intakeQualityChoices','intakeQualityHistory','intakeFollowupList'])$(id).replaceChildren();
 if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(me.role)){$('automationStatus').textContent='当前企业身份无自动运营权限；请在报案与审核记录中查看自身案件。';return;}
 try{
  const data=await api('/automation');$('automationStatus').textContent=`本地合成测试 · ${data.model.label} · 预算服务 ${data.budget.state==='available'?(data.budget.ready?'对账完成':'已暂停，等待对账'):'未连接或不可用'}`;
  renderModelCosts(data.modelCosts);
  if(data.chain.state==='available'){
   for(const c of data.chain.channels)card('channelList',c.channel===1?'L1 程序':'L2 Agent',[`自动核赔：${c.approve?'开启':'关闭'} / 自动付款：${c.pay?'开启':'关闭'}`,`链头 ${data.chain.block}（尚非最终确认）`]);
   clear('grantList',data.chain.grants);for(const g of data.chain.grants)card('grantList',g.id,[`Grant ${g.enabled?'启用':'撤销'} · epoch ${g.epoch} · 预算版本 ${g.budgetVersion}`,`单案审核上限 ${money(g.reviewLimit)} / 原币 ${g.token}`,`模板 ${g.templatePaused?'暂停':'可用'} / 规则 ${g.rulePaused?'暂停':'可用'} / 模型 ${g.modelPaused?'暂停':'可用'}`,`授权截止 ${new Date(Number(g.validUntil)*1000).toISOString()}`]);
  }else card('channelList','无法核验开关',[data.chain.reason]);
  if(data.budget.state==='available'){
   for(const scope of data.budget.usage)for(const u of scope.dimensions)card('budgetList',`${u.dimension} · ${scope.token}`,[`金额 ${money(u.used)} / ${money(u.limit)} · 笔数 ${u.count} / ${u.countLimit}`,`窗口 ${u.window} 秒 · 版本 ${u.version} · ${u.exceeded?'预算超限：保留既有欠款，禁止新增自动授权':'当前占用未超限'}`]);
   clear('reservationList',data.budget.reservations);for(const r of data.budget.reservations)card('reservationList',r.id,[`预留待付 ${money(r.remaining)} · ${r.state}`,`事故 ${r.incident}`]);
   clear('automaticPaymentList',data.budget.payments);for(const p of data.budget.payments)card('automaticPaymentList',p.id,[`${money(p.amount)} · ${p.state}`]);
  }else card('budgetList','预算读数不可用',[data.budget.reason??'尚未配置只读预算连接，不能据此判断额度充足。']);
 const reviews=await api('/quality');const cases=await api('/quality/cases');$('qualityPanel').hidden=false;clear('qualityCases',cases);for(const c of cases)card('qualityCases',c.incident,[`决定 v${c.decision_version} · ${c.payload.channel===0?'人工决定异常':c.payload.sameVersion?'同规则及模型版本':'同模板其他版本'}`,`排查状态 ${{pending:'待复核',resolved:'已解决，自动权限仍须单独治理',reviewed:'已复核，未自动解除',recheck_required:'区块已重组，须重新复核',unavailable:'链不可用'}[c.state]??c.state}`,`关联反馈 ${c.trigger_id}`,c.review_id?`复核记录 ${c.review_id}`:'尚无后续复核记录',...(c.resolution?[`解决记录 ${c.resolution.id}`,`主管 ${c.resolution.actor}`,c.resolution.payload.reason]:[])]);clear('qualityList',reviews);for(const r of reviews)card('qualityList',r.id,[`${r.payload.outcome} · 决定 v${r.payload.decisionVersion}`,r.payload.reason,`区块证明 ${r.proof_state==='canonical'?'当前规范链':r.proof_state==='recheck_required'?'已重组：必须重新复核':'未验证或链不可用'}`,`模板 ${r.payload.templateId??'人工决定未记录'}`,r.pause_job?`暂停交易 ${r.pause_state} · ${r.pause_job}`:'未要求暂停'],r.payload);
 renderResolutionForm(cases,reviews);
 await refreshMetrics(reviews);await refreshSamples();await refreshWorkload();await refreshIntakeCosts();await refreshIntakeQuality();
 }catch(e){if(e.message==='STALE_SESSION')throw e;$('automationStatus').textContent='自动运营查询失败；未取得可验证读数。';}
}

const supplementLabels={checking:'核验中',awaiting_evidence:'待集中补证',awaiting_proposal:'材料已齐，等待审核',ready:'审核完成，等待独立授权',manual:'人工接管'};
async function refreshSupplement(){
 $('supplementList').replaceChildren();$('supplementForm').hidden=true;
 if(!['insured','ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(me.role)){$('supplementStatus').textContent='当前身份无补证查看权限。';return;}
 try{
  const data=await api('/semantic-intake');
  if(data.state==='not_configured'){$('supplementStatus').textContent='补证服务尚未连接。';return;}
  $('supplementStatus').textContent='仅显示本企业案件；材料状态不代表赔付批准。';clear('supplementList',data.cases);
  for(const c of data.cases){
   const missing=(c.missingKinds??[]).map(x=>`${({release:'发布记录',monitor:'独立监控',replay:'复现记录',ticket:'工单原文',work:'费用工单',completion:'完成回执',payment:'支付凭据'})[x.kind]||x.kind} × ${x.count}`).join('、');
   const row=card('supplementList',supplementLabels[c.state]||c.state,[`案件 ${c.id}`,`报案 ${c.noticeId}`,`补证机会：${c.supplementUsed?'已使用':'未使用'} · 技术截止 ${new Date(c.deadline).toLocaleString()}`,missing?`缺项：${missing}`:'暂无已识别缺项',...(c.reasons.length?[`转人工或核验原因：${c.reasons.join('、')}`]:[])],{missing:c.missing,acceptedSource:c.acceptedSource,previousNoticeId:c.previousNoticeId});
   if(me.role==='insured'&&c.state==='awaiting_evidence'&&!c.supplementUsed){const b=document.createElement('button');b.textContent='准备本案补证';b.onclick=()=>{$('supplementForm').hidden=false;$('supplementCase').value=c.id;$('supplementNotice').value=c.noticeId;$('supplementRefs').value='';};row.append(b);}
  }
 }catch(e){if(e.message==='STALE_SESSION')throw e;$('supplementStatus').textContent='补证服务暂不可用，原受理记录保留；请稍后刷新。';}
}
bind('supplementImport',async()=>{
 const session=token,file=$('supplementFile').files[0];if(!file||file.size>100000)throw Error('请选择不超过100 KB的签名JSON原件');
 const document=await file.text();if(session!==token)throw Error('STALE_SESSION');
 const result=await api('/semantic-originals',{noticeId:$('supplementNotice').value.trim(),document});message(`签名原件已保存：${result.ref}。尚未提交补证。`);
});
bind('supplementSubmit',async()=>{
 const refs=JSON.parse($('supplementRefs').value);await api('/semantic-supplement',{caseId:$('supplementCase').value,noticeId:$('supplementNotice').value.trim(),refs});
 $('supplementForm').hidden=true;message('补证提交已记录；重复点击使用同一清单，不会新增机会。');await refreshSupplement();
});

bind('qualitySubmit',async()=>{const id=$('qualityId').value.trim()||randomId();$('qualityId').value=id;const r=await api('/quality',{id,incidentId:$('qualityIncident').value.trim(),decisionVersion:$('qualityVersion').value.trim(),outcome:$('qualityOutcome').value,reason:$('qualityReason').value});message(r.pauseJob?'抽检已保存，模板暂停交易已排队；尚未确认':'抽检已保存');await refresh();});

function selectIntakeCost(noticeId,previousId){
 for(const id of ['icHumanMs','icCurrency','icReference','icReason','ic-human','ic-model','ic-chain','ic-infrastructure','ic-other'])$(id).value='';
 $('icBasis').value='estimate';$('icNotice').value=noticeId;$('icPrevious').value=previousId??'';$('icId').value=randomId();$('intakeCostForm').hidden=false;$('intakeCostForm').open=true;
}
async function refreshIntakeCosts(){
 $('intakeCostForm').hidden=true;$('intakeCostList').replaceChildren();$('intakeCostHistory').replaceChildren();
 try{
  const [notices,history]=await Promise.all([api('/notices'),api('/quality/intake-measurements')]);
  const latest=new Map();for(const m of history){if(!latest.has(m.notice_id))latest.set(m.notice_id,m.id);card('intakeCostHistory',`受理费用历史 · ${m.notice_id}`,[m.payload.reason,`${m.actor} · ${m.created_at}`],m.payload);}
  const pending=notices.filter(n=>!n.chain||JSON.parse(n.chain).incidentId==='0x'+'0'.repeat(64));clear('intakeCostList',pending);
  for(const n of pending){const c=card('intakeCostList',n.id,[n.payload.summary,latest.has(n.id)?'已有记录；新增须填写更新后的累计值，未填写不继承':'尚未采集受理成本']);const b=document.createElement('button');b.textContent='采集此报案受理成本';b.onclick=()=>selectIntakeCost(n.id,latest.get(n.id));c.append(b);}
 }catch(e){if(e.message==='STALE_SESSION')throw e;card('intakeCostList','受理成本记录不可用',['请刷新后重试；未获得记录不表示费用为零。']);}
}
bind('intakeCostSubmit',async()=>{
 const currency=$('icCurrency').value.trim().toUpperCase();if(!/^[A-Z]{3}$/.test(currency))throw Error('请填写三位费用币种');
 const components=Object.fromEntries(['human','model','chain','infrastructure','other'].map(k=>[k,measuredMoney('ic-'+k)]));
 const total=Object.values(components).every(v=>v!==null)?Object.values(components).reduce((sum,v)=>sum+BigInt(v),0n).toString():null;
 await api('/quality/intake-measurements',{id:$('icId').value,noticeId:$('icNotice').value,previousId:$('icPrevious').value||null,humanMs:measuredInteger('icHumanMs'),costCurrency:total===null?null:currency,costMicros:total,costBreakdown:{currency,basis:$('icBasis').value,components,reference:$('icReference').value},reason:$('icReason').value});
 message('累计受理成本已保存，历史记录保留；未形成质量裁定。');await refreshIntakeCosts();await refreshIntakeQuality();await refreshWorkload();
});
const intakeOutcomeLabels={unverifiable:'目前无法核验',no_issue_observed:'本次未发现异常',missed_escalation:'漏转人工',unpaid_obligation:'应赔未赔'};
function renderIntakeFollowups(data){
 clear('intakeFollowupList',data.cases);
 for(const c of data.cases){const cardNode=card('intakeFollowupList',`${c.incident} · 决定 v${c.decision_version}`,[`模板 ${c.payload.templateId} · ${c.payload.sameVersion?'同规则及模型版本':'同模板其他版本'}`,`状态 ${{pending:'待独立复核',reviewed:'已复核，权限未恢复',anomaly_requires_resolution:'复核发现异常，需决定质量处置',recheck_required:'证据变化，须重新核验'}[c.state]??c.state}`],c);const b=document.createElement('button');b.textContent='填写该决定的独立复核';b.onclick=()=>{$('qualityIncident').value=c.incident;$('qualityVersion').value=c.decision_version;$('qualityId').value='';$('qualityReason').value='';message('已填入决定编号与版本，请核验材料后填写独立复核结论。');};cardNode.append(b);}
}
function renderIntakeResolution(rows,reviews,notices){
 $('intakeResolveForm').hidden=true;$('irTrigger').replaceChildren();$('irReview').replaceChildren();
 if(me.role!=='SUPERVISOR')return;
 const cases=rows.filter(r=>r.payload.disposition==='pending_independent_resolution'&&r.resolution?.state!=='current'&&r.actor!==me.address);
 if(!cases.length)return;
 const option=(target,value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;$(target).append(o);};
 option('irTrigger','','请选择原异常');for(const c of cases)option('irTrigger',c.id,`${c.notice_id} · ${intakeOutcomeLabels[c.payload.outcome]}`);
 const populate=()=>{
  $('irReview').replaceChildren();$('irId').value='';$('irReason').value='';option('irReview','','请选择后续独立意见');
  const c=cases.find(r=>r.id===$('irTrigger').value);if(!c)return;
  const notice=notices.find(n=>n.id===c.notice_id),incident=notice?.chain?JSON.parse(notice.chain).incidentId:null;
  const candidates=$('irType').value==='false_alarm'?rows.filter((r,index)=>index<rows.indexOf(c)&&r.notice_id===c.notice_id&&r.payload.outcome==='no_issue_observed'&&r.payload.sourceHash===c.payload.sourceHash):$('irType').value==='corrected'?reviews.filter(r=>r.incident===incident&&r.payload.outcome==='correct'):[];
  for(const r of candidates.filter(r=>r.proof_state==='canonical'&&r.actor!==me.address&&r.actor!==c.actor))option('irReview',r.id,`${r.actor} · ${r.payload.reason}`);
 };
 $('irTrigger').onchange=()=>{$('irType').value='';populate();};$('irType').onchange=populate;$('intakeResolveForm').hidden=false;
}
async function refreshIntakeQuality(){
 $('intakeQualityForm').hidden=true;$('intakeResolveForm').hidden=true;$('intakeQualityChoices').replaceChildren();$('intakeQualityHistory').replaceChildren();$('intakeFollowupList').replaceChildren();
 try{
  const [rows,reviews,notices,followups]=await Promise.all([api('/quality/intake-reviews'),api('/quality'),api('/notices'),api('/quality/intake-followups')]);
  const pending=notices.filter(n=>n.chain&&JSON.parse(n.chain).incidentId==='0x'+'0'.repeat(64));clear('intakeQualityChoices',pending);
  for(const n of pending){const c=card('intakeQualityChoices',n.id,[n.payload.summary,'最终独立性与身份由服务端复验']);const b=document.createElement('button');b.textContent='独立复核此报案';b.onclick=()=>{$('iqNotice').value=n.id;$('iqId').value=randomId();$('iqReason').value='';$('iqOutcome').value='unverifiable';$('intakeQualityForm').hidden=false;$('intakeQualityForm').open=true;};c.append(b);}
  clear('intakeQualityHistory',rows);for(const r of rows)card('intakeQualityHistory',`${intakeOutcomeLabels[r.payload.outcome]} · ${r.notice_id}`,[r.payload.reason,`复核者 ${r.actor} · 证据状态 ${{canonical:'可核验',source_changed:'材料或签名变化，须重验',recheck_required:'链已重组，须重验',unavailable:'暂不可核验'}[r.proof_state]}`,r.payload.disposition==='pending_independent_resolution'?(r.resolution?.state==='current'?'已有有效独立解决记录；权限未恢复':'异常仍待独立处置'):'观察记录，不自动解决既有异常'],r);
  renderIntakeFollowups(followups);for(const r of rows)for(const p of r.pauseStates??[])card('intakeQualityHistory','模板暂停状态',[`模板 ${p.templateId}`,`交易 ${p.id} · ${p.state}`,'只有已确认交易代表暂停已上链；异常解决不恢复权限。']);renderIntakeResolution(rows,reviews,notices);
 }catch(e){if(e.message==='STALE_SESSION')throw e;card('intakeQualityHistory','受理复核查询失败',['请重新核验；不代表没有异常。']);}
}
bind('intakeQualitySubmit',async()=>{
 await api('/quality/intake-reviews',{id:$('iqId').value,noticeId:$('iqNotice').value,outcome:$('iqOutcome').value,reason:$('iqReason').value});
 message('受理复核已保存；异常仍需独立处置。');await refreshIntakeQuality();await refreshWorkload();
});
bind('intakeResolveSubmit',async()=>{
 if(!$('irTrigger').value||!['false_alarm','corrected'].includes($('irType').value)||!$('irReview').value||!$('irReason').value.trim())throw Error('请选择异常、解决类型、独立意见并填写主管依据');
 if(!$('irId').value)$('irId').value=randomId();
 await api('/quality/intake-resolutions',{id:$('irId').value,triggerId:$('irTrigger').value,type:$('irType').value,reviewId:$('irReview').value,reason:$('irReason').value});
 message('独立解决记录已保存；资金及自动权限未改变。');await refreshIntakeQuality();await refreshWorkload();
});
function measuredInteger(id){const v=$(id).value.trim();if(!v)return null;if(!/^(0|[1-9]\d*)$/.test(v))throw Error('耗时和笔数须为非负整数；未知请留空');return v;}
function measuredMoney(id){const v=$(id).value.trim();return v?units(v):null;}
function measuredBool(id){const v=$(id).value;return v===''?null:v==='true';}
function meanLabel(d,scale=1n){if(!d.mean)return '未知';const n=BigInt(d.mean.numerator),den=BigInt(d.mean.denominator)*scale;if(n%den===0n)return (n/den).toString();const digits=scale===1000000n?6:3,factor=10n**BigInt(digits),rounded=(n*factor+den/2n)/den;return `约 ${rounded/factor}.${(rounded%factor).toString().padStart(digits,'0')}`;}
function countLabel(d){return d.observations?`${d.sum} / ${d.observations} 个已核实样本`:'未知（无已核实样本）';}
function selectMeasurement(reviewId){for(const id of ['measurementId','measurementProcessing','measurementHuman','measurementCurrency','measurementCost','measurementWrong','measurementUnder','measurementDuplicate','measurementManual','measurementAppeal','measurementReason','measurementCostBasis','measurementCostReference','cost-human','cost-model','cost-chain','cost-infrastructure','cost-other'])$(id).value='';$('measurementReview').value=reviewId;$('measurementForm').hidden=false;$('measurementForm').open=true;}
async function refreshMetrics(reviews){
 $('metricsList').replaceChildren();$('measurementList').replaceChildren();$('measurementForm').hidden=true;
 try{
  const [metrics,measurements]=await Promise.all([api('/quality/metrics'),api('/quality/measurements')]);
  $('metricsStatus').textContent=`采集指标为抽样口径 · 确认决定版本覆盖${metrics.population?.state==='available'?'可用':'不可用'} · 排除 ${metrics.excludedUnverifiedReviews} 条未核验或重组记录`;
  clear('metricsList',metrics.groups);
  for(const g of metrics.population?.groups??[]){
   const rates=Object.entries(g.outcomeRates).filter(([k])=>k!=='correct').map(([k,v])=>`${({wrong_payment:'误付',underpayment:'少付',missed_escalation:'漏转人工',wrong_denial:'应赔未赔'})[k]}：${v?`${v.numerator}/${v.denominator}`:'未知（复核未覆盖全部版本）'}`);
   card('metricsList',`全量决定版本 · ${g.channel===0?'L3 人工':`L${g.channel}`} · 模板 ${g.templateId??'未记录'}`,[`事故 ${g.incidents} / 决定版本 ${g.decisionVersions}（包含历史修订）`,`已复核 ${g.reviewedDecisionVersions} / 未复核 ${g.unreviewedDecisionVersions}`,...rates,'分母为已确认的决定版本，不是通知数或事故错误率']);
   if(g.costCoverage){const c=g.costCoverage;card('metricsList','决定版本成本覆盖',[`完整分项 ${c.complete} / 部分分项 ${c.partial} / 仅旧总额 ${c.legacyTotal} / 未采集 ${c.missing} / 分母 ${c.denominator}`,'完整分项包含估算，不代表账单实耗；未出决定的通知另计，不能当零成本',...c.series.map(v=>`${v.currency} / ${v.basis==='actual'?'实耗':'估算'}：覆盖 ${v.coverage.numerator}/${v.coverage.denominator}，全量合计 ${v.populationTotalMicros===null?'未知':money(v.populationTotalMicros)}`)]);}
  }
  for(const g of metrics.groups){
   const lines=[`复核 ${g.reviewedDecisions} 个决定版本 / 已采集 ${g.measuredDecisions} 个`,
    `处理耗时：均值 ${meanLabel(g.processingMs)} 毫秒 / P95 ${g.processingMs.p95??'未知'} 毫秒 / 样本 ${g.processingMs.observations}`,
    `人工耗时：均值 ${meanLabel(g.humanMs)} 毫秒 / P95 ${g.humanMs.p95??'未知'} 毫秒 / 样本 ${g.humanMs.observations}`,
    `人工推翻：${countLabel(g.manualOverturned)}`,`申诉推翻：${countLabel(g.appealOverturned)}`,
    `重复付款：${g.duplicatePayments.sum??'未知'} 笔 / 已核实样本 ${g.duplicatePayments.observations}`];
   const outcomes={correct:'未发现异常',wrong_payment:'误付',underpayment:'少付',missed_escalation:'漏转人工',wrong_denial:'应赔未赔'};
   lines.push('复核结论：'+Object.entries(g.outcomes).map(([key,value])=>`${outcomes[key]??key} ${value}`).join('、'));
   for(const c of g.costs)lines.push(`未分项费用 ${c.currency}：合计 ${money(c.sum)} / 均值 ${meanLabel(c,1000000n)} / 样本 ${c.observations}（不与分项成本相加）`);
   if(!g.costs.length&&!g.costBreakdown?.groups.length)lines.push('费用：未知（未采集）');
   for(const c of g.costBreakdown?.groups??[]){lines.push(`分项成本 ${c.currency} / ${c.basis==='actual'?'实耗':'估算'}：完整 ${c.completeMeasurements}/${c.measurements}，合计 ${c.totalMicros===null?'未知（有缺项）':money(c.totalMicros)}`);for(const [key,v] of Object.entries(c.components))lines.push(`${({human:'人工',model:'模型',chain:'链上',infrastructure:'基础设施',other:'其他'})[key]}：已知小计 ${v.sumMicros===null?'未知':money(v.sumMicros)} / 已知 ${v.known} / 未知 ${v.unknown}`);}
   for(const m of g.money)lines.push(`保单代币 ${m.token}：误付 ${m.wrongPaid.sum===null?'未知':money(m.wrongPaid.sum)}（样本 ${m.wrongPaid.observations}）/ 少付 ${m.underpaid.sum===null?'未知':money(m.underpaid.sum)}（样本 ${m.underpaid.observations}）`);
   card('metricsList',`${g.channel===0?'L3 人工':`L${g.channel}`} · 模板 ${g.templateId??'未记录'}`,lines);
  }
  clear('measurementList',measurements);
  for(const m of measurements)card('measurementList',m.review_id,[m.payload.reason,`采集者 ${m.actor} · ${m.created_at}`],m.payload);
  const measured=new Set(measurements.map(m=>m.review_id));
  for(const r of reviews)if(r.actor.toLowerCase()===me.address.toLowerCase()&&r.proof_state==='canonical'&&!measured.has(r.id)){
   const c=card('measurementList','可补录本人的复核',[r.id,r.payload.reason]);const b=document.createElement('button');b.textContent='补录此复核指标';b.onclick=()=>selectMeasurement(r.id);c.append(b);
  }
 }catch(e){if(e.message==='STALE_SESSION')throw e;$('metricsList').replaceChildren();$('measurementList').replaceChildren();$('metricsStatus').textContent='指标暂不可用；不能据此视为零错误或零费用。';}
}
bind('measurementSubmit',async()=>{
 const id=$('measurementId').value.trim()||randomId();$('measurementId').value=id;
 let costMicros=measuredMoney('measurementCost'),costCurrency=$('measurementCurrency').value.trim().toUpperCase()||null;let costBreakdown;
 const basis=$('measurementCostBasis').value;
 if(basis){if(costMicros!==null)throw Error('启用分项时总额自动计算，请清空上方核实费用');if(!costCurrency)throw Error('请填写分项费用币种');const components=Object.fromEntries(['human','model','chain','infrastructure','other'].map(k=>[k,measuredMoney('cost-'+k)]));costBreakdown={currency:costCurrency,basis,components,reference:$('measurementCostReference').value};if(Object.values(components).every(v=>v!==null))costMicros=Object.values(components).reduce((sum,v)=>sum+BigInt(v),0n).toString();else costCurrency=null;}
 if((costMicros===null)!==(costCurrency===null))throw Error('费用与币种须同时填写，未知时均留空');
 await api('/quality/measurements',{id,reviewId:$('measurementReview').value,processingMs:measuredInteger('measurementProcessing'),humanMs:measuredInteger('measurementHuman'),costCurrency,costMicros,...(costBreakdown?{costBreakdown}:{}),wrongPaid:measuredMoney('measurementWrong'),underpaid:measuredMoney('measurementUnder'),duplicatePayments:measuredInteger('measurementDuplicate'),manualOverturned:measuredBool('measurementManual'),appealOverturned:measuredBool('measurementAppeal'),reason:$('measurementReason').value});
 $('measurementForm').hidden=true;message('样本指标已保存；不代表全量理赔指标。');await refreshAutomation();
});

async function refreshSamples(){
 $('samplingList').replaceChildren();
 try{
  const data=await api('/quality/samples');
  if(data.state!=='available'){$('samplingStatus').textContent=data.state==='not_ready'?'复核队列尚未完成索引准备。':'复核队列暂不可核验；保留原记录，不能视为已完成复核。';return;}
  $('samplingStatus').textContent=`首批 ${data.policy.percent}% · 已确认范围 ${data.checkpoint.indexConfig.startBlock}—${data.checkpoint.height} · 纳入 ${data.counts.selected} / 待复核 ${data.counts.pending} / 已复核 ${data.counts.reviewed} / 重组待重查 ${data.counts.recheckRequired}`;
  clear('samplingList',data.cases);
  for(const c of data.cases){
   const row=card('samplingList',`L${c.payload.channel} · 决定 v${c.decision_version}`,[`事故 ${c.incident}`,`状态 ${{pending:'待独立复核',reviewed:'已独立复核',recheck_required:'原区块已重组，保留历史',unavailable:'链不可核验'}[c.state]??c.state}`,`模板 ${c.payload.templateId}`,c.reviewId?`复核记录 ${c.reviewId}`:'尚无匹配当前来源区块的有效复核']);
   if(c.state==='pending'){const b=document.createElement('button');b.textContent='准备独立复核';b.onclick=()=>{$('qualityId').value='';$('qualityIncident').value=c.incident;$('qualityVersion').value=c.decision_version;$('qualityReason').value='';$('qualityIncident').focus();};row.append(b);}
  }
 }catch(e){if(e.message==='STALE_SESSION')throw e;$('samplingStatus').textContent='复核队列查询失败；请稍后重新核验。';}
}

function renderModelCosts(data){
 $('modelCostList').replaceChildren();
 if(data?.state!=='available'){card('modelCostList','模型费用不可用',[data?.state==='not_configured'?'尚未配置费用读取；不能视为零费用。':'费用服务未返回可核验结果；不能视为零费用。']);return;}
 card('modelCostList',`${data.price.model} · ${data.price.version}`,[
  `已关联任务 ${data.jobs} / 已预留调用 ${data.calls} / 已结算 ${data.settledCalls}`,
  `已结算估算 ${money(data.settledEstimatedMicroUSD)} USD`,
  `未决预留 ${money(data.unresolvedReservedMicroUSD)} USD / 总占额 ${money(data.budgetOccupiedMicroUSD)} USD`,
  `待完成 ${data.reservedCalls} / 用量未知 ${data.unknownCalls} · ${data.complete?'已记录调用用量齐全':'用量不完整，不能据此判断实际总费用'}`,
  `已知用量调用 ${data.tokens.knownCalls} · 输入 ${data.tokens.input??'未知'} / 缓存输入 ${data.tokens.cachedInput??'未知'} / 输出 ${data.tokens.output??'未知'}`,
  '输入含缓存输入；缓存量不再次加总。未关联任务及供应商账单未包含。'
 ]);
}
async function refreshWorkload(){
 $('workloadList').replaceChildren();
 try{
  const data=await api('/quality/workload');
  if(data.state!=='available'){card('workloadList','总体链上统计不可用',[`本库已持久受理 ${data.localAccepted} 份通知`,'索引或链尚不可核验；不沿用旧统计。']);return;}
  const c=data.counts;
  card('workloadList',`已确认范围 ${data.checkpoint.startBlock}—${data.checkpoint.height}`,[`通知去重总数 ${c.noticeIds} / 本地受理 ${data.localAccepted} / 链上确认 ${c.confirmedNotices}`,`仅本地 ${c.localOnlyNotices} / 已确认未归并 ${c.unboundConfirmedNotices} / 已绑定通知 ${c.boundNotices}`,`已出决定事故 ${c.decidedIncidents} / 事故分母 ${data.incidentDenominator??'未知，仍有未归并通知'}`]);
  card('workloadList','按确认清偿结案',[`当前结案 ${data.closure.closed} / 自动结案 ${data.closure.automaticClosed} / 自动归类未知 ${data.closure.automaticUnknown}`,data.automaticClosureRate?`自动结案率 ${(100*data.automaticClosureRate.numerator/data.automaticClosureRate.denominator).toFixed(1)}%（${data.automaticClosureRate.numerator}/${data.automaticClosureRate.denominator}）`:'自动结案率未知：分母未确定、无事故或历史不完整','D/Q 为零且无冻结或活动申诉；全程自动且未人工接管才计自动结案。后续状态变化会撤销旧结案，不释放容量。']);
  const closureLines=g=>[`结案 ${g.closed} / 当前事故 ${g.incidents??c.decidedIncidents}`,`自动结案 ${g.automaticClosed} / 自动归类未知 ${g.automaticUnknown}`,g.automaticClosureRate?`自动结案率 ${(100*g.automaticClosureRate.numerator/g.automaticClosureRate.denominator).toFixed(1)}%（${g.automaticClosureRate.numerator}/${g.automaticClosureRate.denominator}）`:'自动结案率未知',`受理至结案确认观察：均值 ${meanLabel(g.closureObservedMs)} 毫秒 / P95 ${g.closureObservedMs.p95??'未知'} 毫秒`,`有计时 ${g.closureObservedMs.observations} / 未知 ${g.closureObservedMs.unknown}；未结案不参与耗时`];
  if(data.pending)card('workloadList','尚无确认决定的通知',[`待处理通知 ${data.pending.noticeIds} / 仅本地 ${data.pending.localOnlyNotices} / 已确认未归并 ${data.pending.unboundConfirmedNotices}`,`本地受理至查询等待：均值 ${meanLabel(data.pending.waitingMs)} 毫秒 / P95 ${data.pending.waitingMs.p95??'未知'} 毫秒`,`有计时 ${data.pending.waitingMs.observations} / 未知 ${data.pending.waitingMs.unknown}`,'通知可能归并，不推断事故数、通道、模板或质量结论；等待包含停机时间，不等于已完成处理时长。']);
  if(data.pending?.intakeCosts){const p=data.pending.intakeCosts;card('workloadList','待处理报案的受理成本',[`已采集 ${p.measuredNotices}/${p.noticeIds} / 未采集 ${p.unmeasuredNotices} / 完整费用 ${p.completeCosts} / 部分费用 ${p.partialCosts}`,`人工时间已知合计 ${p.humanMs.sum??'未知'} 毫秒 / 未知 ${p.humanMs.unknown}`,'按报案 ID 保存累计受理费用，尚不归入事故或决定成本；不是独立质量判定。',...p.costs.groups.map(g=>`${g.currency} ${g.basis==='actual'?'实耗':'估算'}：待处理全量费用 ${g.pendingPopulationTotalMicros===null?'未知':money(g.pendingPopulationTotalMicros)} / 已完整采集部分 ${g.knownCompleteTotalMicros===null?'未知':money(g.knownCompleteTotalMicros)}`)],p);}
  for(const g of data.channels)card('workloadList',`${g.channel===0?'L3':`L${g.channel}`} 结案`,closureLines(g));
  for(const g of data.templates)card('workloadList',`${g.channel===0?'L3':`L${g.channel}`} 结案 · ${g.templateId??'模板未记录'}`,closureLines(g));
  for(const g of data.channels)card('workloadList',g.channel===0?'L3 人工':`L${g.channel}`,[`事故 ${g.incidents} / 有待付 ${g.withDue} / 有待追回 ${g.withRecoveryDue}`,`冻结 ${g.frozen} / 人工接管 ${g.manualHold} / 活动申诉 ${g.activeDispute}`,`受理至当前决定确认观察：均值 ${meanLabel(g.decisionObservedMs)} 毫秒 / P95 ${g.decisionObservedMs.p95??'未知'} 毫秒`,`有计时 ${g.decisionObservedMs.observations} / 未知 ${g.decisionObservedMs.unknown}`]);
  for(const g of data.templates)card('workloadList',`${g.channel===0?'L3 人工':`L${g.channel}`} · 模板 ${g.templateId??'未记录'}`,[`当前决定事故 ${g.incidents}`,g.templateId?'按决定生效时的历史授权归属':'人工决定尚未记录模板，不推断归属',`决定确认观察：均值 ${meanLabel(g.decisionObservedMs)} 毫秒 / P95 ${g.decisionObservedMs.p95??'未知'} 毫秒`,`有计时 ${g.decisionObservedMs.observations} / 未知 ${g.decisionObservedMs.unknown}`]);
 }catch(e){if(e.message==='STALE_SESSION')throw e;card('workloadList','总体统计查询失败',['请重新核验；失败不表示零报案。']);}
}

function renderResolutionForm(cases,reviews){
 $('resolutionForm').hidden=true;$('resolutionCase').replaceChildren();$('resolutionReview').replaceChildren();
 if(me.role!=='SUPERVISOR')return;
 const choices=cases.filter(c=>c.state!=='resolved'&&c.state!=='unavailable');
 if(!choices.length)return;
 const option=(target,value,text)=>{const o=document.createElement('option');o.value=value;o.textContent=text;$(target).append(o);};
 option('resolutionCase','','请选择排查案件');
 for(const c of choices)option('resolutionCase',c.id,`${c.incident} · 原决定 v${c.decision_version} · ${c.state}`);
 $('resolutionCase').onchange=()=>{
  $('resolutionReview').replaceChildren();$('resolutionId').value='';$('resolutionReason').value='';$('resolutionType').value='';
  option('resolutionReview','','请选择独立复核意见');
  const c=choices.find(c=>c.id===$('resolutionCase').value);if(!c)return;
  // Server rechecks current version, chronology, all signer exclusions and supersession at submission time.
  for(const r of reviews.filter(r=>r.incident===c.incident&&r.id!==c.trigger_id&&r.proof_state==='canonical'&&r.payload.outcome==='correct'&&r.actor!==me.address))option('resolutionReview',r.id,`v${r.payload.decisionVersion} · ${r.actor} · ${r.payload.reason}`);
 };
 $('resolutionForm').hidden=false;
}
bind('resolutionSubmit',async()=>{
 if(!['corrected','false_alarm'].includes($('resolutionType').value)||!$('resolutionCase').value||!$('resolutionReview').value||!$('resolutionReason').value.trim())throw Error('请选择案件、独立意见、解决类型并填写依据');
 if(!$('resolutionId').value)$('resolutionId').value=randomId();
 await api('/quality/resolutions',{id:$('resolutionId').value,caseId:$('resolutionCase').value,reviewId:$('resolutionReview').value,type:$('resolutionType').value,reason:$('resolutionReason').value});
 message('异常解决记录已保存；自动权限未恢复。');await refreshAutomation();
});





