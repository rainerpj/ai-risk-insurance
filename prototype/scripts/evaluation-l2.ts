import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {semanticFixture} from '../tests/m2c-fixture.ts';
import {Store,hash,json} from '../packages/service/store.ts';
import {H} from '../packages/service/reviewer.ts';
import {AgentEvidenceTools,runAgent,agentPromptVersion,type AgentAdapter} from '../packages/service/agent.ts';
import {SemanticIntake} from '../packages/service/supplement.ts';
import {OpenAIAdapter} from '../packages/service/openai-adapter.ts';
import {ModelSpend} from '../packages/service/model-spend.ts';
import {freezeHumanAdjudication,compareHumanDecision} from '../packages/service/human-adjudication.ts';
export type CorpusCase={id:string;description:string;prices?:{recovery:string;emergency:string};mutations?:{kind:string;expense?:string;fields?:Record<string,unknown>;appendNarrative?:string}[];missing?:{kind:string;expense:string};expected:{state:'ready'|'manual'|'awaiting_evidence';net?:string}};
export const corpus=JSON.parse(readFileSync(new URL('../acceptance/l2-corpus-v1.json',import.meta.url),'utf8')) as {version:string;basis:string;humanAdjudication:string;cases:CorpusCase[]};
export async function evaluateL2(options:{kind:'stub'|'real';model:string;humanAdjudication?:unknown;adapter?:(runId:string)=>AgentAdapter;cost?:(runId:string)=>unknown}){
 if(options.kind==='real'&&!options.adapter)throw Error('REAL_ADAPTER_REQUIRED');
 const runId=randomUUID(),prefix=resolve('reports','l2-eval-'+runId);mkdirSync('reports',{recursive:true});
 const frozen=structuredClone(corpus),corpusHash=hash(frozen),rows:any[]=[],startedAt=new Date().toISOString();
 const human=options.humanAdjudication===undefined?null:freezeHumanAdjudication(options.humanAdjudication,frozen,frozen.cases.map(row=>row.id),startedAt);
 // This immutable expectation snapshot precedes fixture creation and every model invocation.
 writeFileSync(prefix+'-frozen.json',json({runId,corpusHash,frozenAt:startedAt,corpus:frozen,human}),{flag:'wx'});
 for(const item of frozen.cases){
  const f=await semanticFixture(item.prices),store=new Store(resolve(f.dir,'evaluation.sqlite'),f.store.getMeta('scope')!);let missingFile:string|undefined;
  try{
   f.trust.modelVersion=H(options.model);f.g.modelVersion=f.trust.modelVersion;await f.c.send(f.registry,'configure',[f.request.grantId,f.g]);
   let refs=[...f.refs];const proposal=structuredClone(f.proposal);
   for(const mutation of item.mutations??[]){
    const old=refs.find(ref=>{const d=f.originals.read(ref);return d.kind===mutation.kind&&(!mutation.expense||d.expenseId===mutation.expense);});if(!old)throw Error('CORPUS_MUTATION_TARGET');
    const body=f.originals.read(old),updated={...body,...mutation.fields};if(mutation.appendNarrative)updated.narrative+=mutation.appendNarrative;
    const ref=f.put(mutation.kind,updated);refs=refs.map(r=>r===old?ref:r);
    for(const p of proposal.items)for(const field of ['ticketRef','workRef','completionRef','paymentRef'] as const)if(p[field]===old)p[field]=ref;
   }
   const notice=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H(refs)}),request={...f.request,noticeId:notice.n.noticeId,refs};
   if(item.missing){const ref=refs.find(r=>{const d=f.originals.read(r);return d.kind===item.missing!.kind&&d.expenseId===item.missing!.expense;});if(!ref)throw Error('CORPUS_MISSING_TARGET');missingFile=resolve(f.dir,ref+'.json');renameSync(missingFile,missingFile+'.offline');}
   const tools=new AgentEvidenceTools(f.originals,f.scope,refs);
   const startedAt=Date.now(),intake=new SemanticIntake(store,f.reviewer),preflight=options.kind==='real'?await intake.run(request,null):null;
   let agent:Awaited<ReturnType<typeof runAgent>>|null=null;
   if(!preflight||preflight.state==='awaiting_proposal'){
    // Adversarial stub always recommends the original claim; it does not read expected routes.
    const adapter=options.adapter?.(runId+':'+item.id)??{kind:'stub' as const,modelVersion:options.model,respond:async()=>({inputTokens:0,outputTokens:0,output:json(proposal)})};
    if(adapter.kind!==options.kind||adapter.modelVersion!==options.model)throw Error('EVALUATION_ADAPTER_IDENTITY');
    agent=await runAgent(adapter,tools,refs,{maxCalls:16,maxToolCalls:16,maxTokens:100000,timeoutMs:120000});
   }
   const result=agent?await intake.run(request,agent.proposal):preflight!,net=result.assessment?.report?.net??null;
   const passed=result.state===item.expected.state&&(item.expected.net===undefined||net===item.expected.net);
   const humanExpected=human?.declaration.cases.find(row=>row.id===item.id)?.expected;
   rows.push({id:item.id,humanExpected:humanExpected??null,humanMatched:humanExpected?compareHumanDecision(humanExpected,{state:result.state,net}):null,expected:item.expected,actual:{state:result.state,net,reasons:result.reasons,facts:result.assessment?.report?.sourceChecks??[]},passed,request,refs,fixture:{directory:f.dir,scope:f.scope,trust:f.trust,policy:f.q,grant:await f.reviewer.grant(request.grantId)},agent,modelSkipped:agent===null,elapsedMs:Date.now()-startedAt,cost:options.cost?.(runId+':'+item.id)??null});
  }finally{if(missingFile)renameSync(missingFile+'.offline',missingFile);store.close();f.close();await f.c.connection.close();}
  writeFileSync(prefix+'-partial.json',json({runId,corpusHash,kind:options.kind,model:options.model,rows}));
 }
 const report={runId,corpusVersion:frozen.version,corpusHash,promptVersion:agentPromptVersion,kind:options.kind,evaluationLane:options.kind==='stub'?'adversarial-proposal-controls':'pipeline-with-real-model',model:options.model,humanAdjudication:frozen.humanAdjudication,humanDeclaration:human,humanMatched:human?rows.filter(row=>row.humanMatched===true).length:null,semanticAccepted:false,passed:rows.every(r=>r.passed),cases:rows.length,matched:rows.filter(r=>r.passed).length,unsafeReady:rows.filter(r=>r.expected.state!=='ready'&&r.actual.state==='ready').map(r=>r.id),rows};
 writeFileSync(prefix+'.json',json(report),{flag:'wx'});return {path:prefix+'.json',report};
}
async function main(){
 const mode=process.argv[2];if(!['--stub','--real','--init-budget'].includes(mode??''))throw Error('Usage: evaluation-l2.ts --stub | --real <private config.json> | --init-budget <private config.json>');
 let ledger:ModelSpend|undefined;
 try{
  if(mode==='--stub'){const result=await evaluateL2({kind:'stub',model:'stub-semantic-v1'});console.log(json({path:result.path,matched:result.report.matched,cases:result.report.cases,unsafeReady:result.report.unsafeReady,semanticAccepted:false}));if(!result.report.passed)process.exitCode=2;return;}
  const file=process.argv[3];if(!file)throw Error('EVALUATION_CONFIG_REQUIRED');const cfg=JSON.parse(readFileSync(file,'utf8'));
  if(cfg.budget?.scope!=='l2-eval:'+corpus.version||cfg.budget?.price?.model!==cfg.model)throw Error('EVALUATION_BUDGET_SCOPE');
  if(mode==='--real'&&!process.env.OPENAI_API_KEY?.trim())throw Error('MODEL_CREDENTIAL_REQUIRED');
  ledger=new ModelSpend(resolve(dirname(resolve(file)),cfg.database),cfg.budget,mode==='--init-budget');
  if(mode==='--init-budget'){console.log('Evaluation budget initialized; no API calls.');return;}
  const result=await evaluateL2({kind:'real',model:cfg.model,humanAdjudication:cfg.humanAdjudication?JSON.parse(readFileSync(resolve(dirname(resolve(file)),cfg.humanAdjudication),'utf8')):undefined,cost:runId=>ledger!.usage(runId),adapter:runId=>new OpenAIAdapter({model:cfg.model,key:()=>process.env.OPENAI_API_KEY!,record:()=>{},spend:{ledger:ledger!,runId}})});
  console.log(json({path:result.path,matched:result.report.matched,cases:result.report.cases,semanticAccepted:false}));if(!result.report.passed)process.exitCode=2;
 }finally{ledger?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();

