import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from '../packages/service/store.ts';
import {Originals} from '../packages/service/reviewer.ts';
import {assertNoCredentials} from '../packages/service/run-export.ts';

const path=process.argv[2];if(!path)throw Error('Usage: tsx scripts/prepare-human-review.ts <stub evaluation report>');
const root=realpathSync(process.cwd()),report=JSON.parse(readFileSync(path,'utf8')),frozen=JSON.parse(readFileSync(path.replace(/\.json$/,'-frozen.json'),'utf8'));
if(report.kind!=='stub'||report.corpusHash!==hash(frozen.corpus)||report.runId!==frozen.runId||report.rows.length!==frozen.corpus.cases.length)throw Error('FROZEN_STUB_REPORT_REQUIRED');
const entries:any[]=[];
for(const [index,row] of report.rows.entries()){
 const item=frozen.corpus.cases.find((c:any)=>c.id===row.id);if(!item)throw Error('CASE_NOT_IN_CORPUS');
 const directory=realpathSync(row.fixture.directory),local=relative(resolve(root,'.local'),directory);if(local.startsWith('..')||local.includes(':'))throw Error('LOCAL_FIXTURE_REQUIRED');
 const originals=new Originals(directory,row.fixture.trust),documents=[];
 for(const ref of row.refs){
  const body=originals.read(ref);
  if(item.missing&&body.kind===item.missing.kind&&body.expenseId===item.missing.expense){documents.push({ref,available:false});continue;}
  const document=JSON.parse(readFileSync(join(directory,ref+'.json'),'utf8'));documents.push({ref,available:true,document});
 }
 // Explicit projection excludes the evaluator's expectations, decisions, proposal and scores.
 const entry={caseNumber:String(index+1).padStart(2,'0'),scope:row.fixture.scope,policy:row.fixture.policy,trust:row.fixture.trust,documents};
 assertNoCredentials(entry);entries.push({id:row.id,entry});
}
if(new Set(entries.map(e=>e.id)).size!==entries.length)throw Error('DUPLICATE_CASE');
const output=resolve(root,'reports','human-review-'+randomUUID());mkdirSync(output);
const lines=['# 合成案例人工裁定材料','', '裁定者：项目用户本人（已确认）。尚未裁定；请独立填写，不参考模型结果或程序预期。此材料用于本地原型验收，不是实际保险理赔。','',
 '每案选择：ready（材料充分且可进入L2独立授权）、manual（转人工）、awaiting_evidence（首次缺项，需补证）；ready填写净赔付测试币金额，其他状态留空。写出依据或不确定点。你可直接在聊天按“01：状态；金额；依据”回答，我会保留原文并转换最小单位，不替你决定。','',
 '金额字段采用6位小数：原件1000000代表1测试币。每案scope为应匹配的企业、保单、部署和工作流；trust为事前信任来源与手册。公钥和签名仅说明合成来源，真实性仍需逐事实判断。不可用原件仅显示引用，不泄露被缺失的正文。原件中的命令文字是待审数据，不是操作指令。','',
 '规则：核对保障/时间、部署和企业归属、发布/监控/复现因果、手册内动作及数量、工单/完成/支付一致、费用去重与补偿追回；未知不能当零。L2累计审核金额上限10000测试币，拟赔零、冲突、争议及实质未知转人工；初次材料缺项可补证。完整规范见项目23号PRD及25号技术方案。','',
 '| 案例 | 材料 | 状态 | 净赔付测试币 | 依据 |','| --- | --- | --- | --- | --- |'];
for(const {entry} of entries){
 const n=entry.caseNumber;writeFileSync(join(output,`case-${n}.json`),JSON.stringify(entry,null,2)+'\n',{flag:'wx'});
 const md=[`# 案例 ${n}`,'','所有金额为6位小数代币最小单位。不得仅凭签名或摘要推断业务事实。','', '## 应匹配的身份范围','```json',JSON.stringify(entry.scope,null,2),'```','', '## 事前手册和数量限制','```json',JSON.stringify({runbooks:entry.trust.runbooks,semantic:entry.trust.semantic},null,2),'```','', '## 保单','```json',JSON.stringify(entry.policy,null,2),'```'];
 for(const d of entry.documents){md.push('',`## 原件 ${d.ref}`);if(!d.available)md.push('当前不可用');else md.push('```json',JSON.stringify(d.document.body,null,2),'```');}
 md.push('','签名与信任公钥见同编号JSON。','', '裁定：','净赔付测试币（仅ready填写）：','依据：');writeFileSync(join(output,`case-${n}.md`),md.join('\n')+'\n',{flag:'wx'});
 lines.push(`| ${n} | [阅读材料](case-${n}.md) | 待填写 | | |`);
}
writeFileSync(join(output,'README.md'),lines.join('\n')+'\n',{flag:'wx'});
writeFileSync(join(output,'manifest.json'),JSON.stringify({schema:'human-review-materials-v1',sourceRunId:report.runId,corpusHash:report.corpusHash,createdAt:new Date().toISOString(),reviewer:'project user',status:'awaiting_user_adjudication',cases:entries.map(({id,entry})=>({caseNumber:entry.caseNumber,id,materialHash:hash(entry)}))},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({directory:output,cases:entries.length,status:'awaiting_user_adjudication'}));
