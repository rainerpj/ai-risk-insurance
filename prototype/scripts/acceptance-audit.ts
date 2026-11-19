import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve('..'),matrix=JSON.parse(readFileSync('acceptance/matrix.json','utf8'));
const source=readFileSync(resolve(root,matrix.source),'utf8');
const requirements=source.split(/\r?\n/).filter(line=>line.startsWith('| AC')).map(line=>line.split('|').slice(1,-1).map(part=>part.trim()));
if(requirements.length!==46||matrix.items.length!==46)throw new Error('AC_SCOPE_MUST_INCLUDE_ALL_46');
const seen=new Set<string>(),issues:string[]=[];
for(const item of matrix.items){
  if(seen.has(item.id))throw new Error('DUPLICATE_ACCEPTANCE_ID');seen.add(item.id);
  const canonical=requirements.find(row=>row[0]===item.id);
  if(!canonical||[item.requirements,item.scenario,item.expected].some((v,index)=>v!==canonical[index+1]))throw new Error('REQUIREMENT_SCOPE_CHANGED:'+item.id);
  if(!['incomplete','needs_scope_audit','verified'].includes(item.status))throw new Error('INVALID_ACCEPTANCE_STATUS');
  for(const path of [...item.candidateEvidence,...item.verifiedEvidence]){
    const absolute=resolve(root,path);if(!absolute.startsWith(root+'\\')&&!absolute.startsWith(root+'/'))throw new Error('EVIDENCE_OUTSIDE_PROJECT');
    if(!existsSync(absolute))throw new Error('EVIDENCE_MISSING:'+path);
  }
  if(item.status!=='verified'||item.verifiedEvidence.length===0||item.remaining)issues.push(item.id+': '+item.remaining);
}
const runId=randomUUID(),report={runId,kind:'requirement-scope-audit',scope:matrix.scope,achieved:issues.length===0,reviewRequired:issues.length,issues,
  note:'File existence is not proof of behavior. Verified entries still require requirement-by-requirement review of the referenced execution evidence.'};
mkdirSync('reports',{recursive:true});const path=`reports/acceptance-audit-${runId}.json`;writeFileSync(path,JSON.stringify(report,null,2));
console.log(`${issues.length} / 46 requirements need completion or scope review; ${path}`);
if(issues.length)process.exitCode=2;
