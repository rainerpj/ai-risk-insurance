import {readFileSync,readdirSync,realpathSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export function assertNoCredentials(value:unknown):void {
 if(typeof value==='string'&&(/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_.-]{16,}/.test(value)))throw Error('CREDENTIAL_CONTENT_REJECTED');
 if(Array.isArray(value)){for(const entry of value)assertNoCredentials(entry);return;}
 if(value&&typeof value==='object')for(const [key,entry] of Object.entries(value)){
  if(/^(?:private[_-]?key|api[_-]?key|secret|mnemonic|password|access[_-]?token|refresh[_-]?token|raw)$/i.test(key))throw Error('PRIVATE_FIELD_REJECTED');
  assertNoCredentials(entry);
 }
}
export const exportKinds=['m0','manual','recovery','m2b','m2c-stub','budget-upgrade','configuration-recovery','payment-window','quality-review','quality-history','quality-resolution','recovery-readiness','closures','quality-population','quality-metrics','manual-aggregation','intake-recovery','m2a'] as const;
/** Fixed proof types from one completed cold run; no arbitrary directory or database export. */
export function exportSyntheticRun(projectRoot:string,runDirectory:string){
 const root=realpathSync(projectRoot),allowed=realpathSync(resolve(root,'.local')),run=realpathSync(runDirectory),rel=relative(allowed,run);
 if(!/^cold-[a-f0-9-]{36}$/.test(rel)||rel.includes(sep))throw Error('COLD_RUN_DIRECTORY_REQUIRED');
 const manifest=JSON.parse(readFileSync(resolve(run,'cold-run.json'),'utf8'));
 if(manifest.kind!=='fresh-directory-local-verification'||manifest.status!=='passed'||manifest.inheritedState!==false||!['install','verify'].every(name=>manifest.steps.some((s:any)=>s.name===name&&s.exitCode===0)))throw Error('SUCCESSFUL_COLD_RUN_REQUIRED');
 const files:{name:string;value:unknown}[]=[];
 for(const kind of exportKinds){
  const matches=readdirSync(resolve(run,'reports')).filter(name=>new RegExp('^'+kind+'-[a-f0-9-]{36}\\.json$').test(name));
  if(matches.length!==1)throw Error('ONE_REPORT_PER_SCENARIO_REQUIRED');
  const name=matches[0]!,path=realpathSync(resolve(run,'reports',name));if(relative(run,path).startsWith('..'))throw Error('REPORT_OUTSIDE_RUN');
  let value=JSON.parse(readFileSync(path,'utf8'));
  if(name!==kind+'-'+value.runId+'.json')throw Error('REPORT_ID_MISMATCH');
  if(kind==='m2a'){
   if(!Array.isArray(value.outcomes)||!value.outcomes.length||value.outcomes.some((r:any)=>r.status!=='passed')||!['blocks','events','transactions','views'].every(k=>Array.isArray(value[k])))throw Error('SUCCESSFUL_SERVICE_REPORT_REQUIRED');
   // Fixed projection removes the machine-local database path. No database or raw outbox is read.
   value={runId:value.runId,kind:'m2a-service-projection',outcomes:value.outcomes,blocks:value.blocks,events:value.events,transactions:value.transactions,views:value.views};
  }else if(value.chainId!==31337||value.kind!==(kind==='m0'?'M0 encoding probe only':kind))throw Error('LOCAL_SYNTHETIC_REPORT_REQUIRED');
  assertNoCredentials(value);files.push({name,value});
  if(kind!=='m0'&&kind!=='m2a'){
   const deploymentPath=realpathSync(resolve(run,'deployments',name));if(relative(run,deploymentPath).startsWith('..'))throw Error('MANIFEST_OUTSIDE_RUN');
   const deployment=JSON.parse(readFileSync(deploymentPath,'utf8'));if(deployment.chainId!==31337||deployment.runId!==value.runId||deployment.deploymentId!==value.deploymentId)throw Error('DEPLOYMENT_MISMATCH');
   assertNoCredentials(deployment);files.push({name:'deployment-'+name,value:deployment});
  }
 }
 const summary={kind:'synthetic-review-package-v4',runId:manifest.runId,status:manifest.status,steps:manifest.steps.map((s:any)=>({name:s.name,exitCode:s.exitCode})),sources:manifest.sources,limitations:manifest.limits,requiredProofKinds:exportKinds,contents:'Synthetic funds, L1/L2-stub, budget migration, index/service recovery, unknown payments, quality governance, closures, population/cost coverage, manual aggregation and independently resolved intake recovery. Excludes databases, keys, live state, raw transactions and diagnostic logs; not real-model or complete acceptance proof.'};
 assertNoCredentials(summary);files.push({name:'run.json',value:summary});
 const output=resolve(root,'exports','synthetic-'+randomUUID());mkdirSync(output,{recursive:true});
 const inventory=files.map(file=>{const content=JSON.stringify(file.value,null,2)+'\n';writeFileSync(resolve(output,file.name),content,{flag:'wx'});return {file:file.name,sha256:createHash('sha256').update(content).digest('hex')};});
 writeFileSync(resolve(output,'contents.json'),JSON.stringify({schema:1,files:inventory},null,2)+'\n',{flag:'wx'});
 return {directory:output,files:inventory.length+1,runId:manifest.runId};
}
