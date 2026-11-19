import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
const root=resolve('..'),matrix=JSON.parse(readFileSync('acceptance/incident-matrix.json','utf8'));
const canonical=readFileSync(resolve(root,'docs/MVP_ADJUSTMENT_PLAN.md'),'utf8').split(/\r?\n/).filter(line=>/^\| MVP\d{2} \|/.test(line)).map(line=>line.split('|').slice(1,-1).map(v=>v.trim()));
assert.equal(canonical.length,12);assert.equal(matrix.items.length,12);const seen=new Set<string>();
for(const item of matrix.items){assert.ok(!seen.has(item.id));seen.add(item.id);const source=canonical.find(row=>row[0]===item.id);assert.ok(source);assert.equal(item.requirement,source[1]);assert.ok(['local_verified','partial','blocked'].includes(item.status));assert.ok(item.evidence.length>0);assert.ok(item.scope);
 for(const file of item.evidence){const absolute=resolve(root,file),rel=relative(root,absolute);assert.ok(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../'));assert.ok(existsSync(absolute),file);}
 if(item.status!=='local_verified')assert.ok(item.remaining);
}
const report={kind:'new-mvp-evidence-index-audit',structurePassed:true,items:matrix.items.length,localVerified:matrix.items.filter((i:any)=>i.status==='local_verified').map((i:any)=>i.id),remaining:matrix.items.filter((i:any)=>i.status!=='local_verified').map((i:any)=>({id:i.id,remaining:i.remaining})),fullMvpAccepted:false,oldAC28Closed:false,oldAC44Closed:false,limitations:'Checks canonical scope and evidence file existence only; does not execute scenarios or certify semantic truth.'};
mkdirSync('reports',{recursive:true});writeFileSync('reports/incident-n12-acceptance-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
