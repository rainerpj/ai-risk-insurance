import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertNoCredentials,exportSyntheticRun,exportKinds} from '../packages/service/run-export.ts';
test('review export refuses credentials and failed runs and only emits declared synthetic evidence',()=>{
 mkdirSync('.local',{recursive:true});const root=mkdtempSync(resolve('.local','export-test-')),run=join(root,'.local','cold-'+randomUUID());mkdirSync(join(run,'reports'),{recursive:true});mkdirSync(join(run,'deployments'));
 const manifest={kind:'fresh-directory-local-verification',runId:randomUUID(),status:'failed',inheritedState:false,steps:[{name:'install',exitCode:0},{name:'verify',exitCode:0}],sources:[],limits:['synthetic fixture']};
 const save=()=>writeFileSync(join(run,'cold-run.json'),JSON.stringify(manifest));save();assert.throws(()=>exportSyntheticRun(root,run),/SUCCESSFUL/);
 const names:string[]=[];for(const kind of exportKinds){const runId=randomUUID(),name=kind+'-'+runId+'.json';names.push(name);writeFileSync(join(run,'reports',name),JSON.stringify(kind==='m2a'?{runId,database:'private-machine-path',outcomes:[{status:'passed'}],blocks:[],events:[],transactions:[],views:[]}:{runId,chainId:31337,kind:kind==='m0'?'M0 encoding probe only':kind}));if(kind!=='m0'&&kind!=='m2a')writeFileSync(join(run,'deployments',name),JSON.stringify({runId,chainId:31337}));}
 manifest.status='passed';save();writeFileSync(join(run,'reports','private-config.json'),JSON.stringify({privateKey:'not-for-export'}));
 const result=exportSyntheticRun(root,run);assert.equal(result.files,36);assert.equal(readdirSync(result.directory).includes('private-config.json'),false);assert.equal(JSON.parse(readFileSync(join(result.directory,'contents.json'),'utf8')).files.length,35);
 for(const kind of ['quality-population','quality-metrics','manual-aggregation','intake-recovery'])assert.equal(readdirSync(result.directory).filter(n=>n.startsWith(kind+'-')).length,1);
 assert.equal(JSON.parse(readFileSync(join(result.directory,names.at(-1)!),'utf8')).database,undefined);
 for(const bad of [{privateKey:'x'},{nested:{api_key:'x'}},{raw:'0x00'},['sk-proj-'+'x'.repeat(30)],{text:'-----BEGIN PRIVATE KEY-----'}])assert.throws(()=>assertNoCredentials(bad));
 const original=JSON.parse(readFileSync(join(run,'reports',names[0]!),'utf8'));writeFileSync(join(run,'reports',names[0]!),JSON.stringify({...original,extra:{privateKey:'hidden'}}));assert.throws(()=>exportSyntheticRun(root,run),/PRIVATE_FIELD/);
 assert.equal(readdirSync(join(root,'exports')).length,1,'reject before writing any partial export');
 writeFileSync(join(run,'reports',names[0]!),JSON.stringify(original));
 const budgetName=names.find(n=>n.startsWith('budget-upgrade-'))!;const budgetPath=join(run,'reports',budgetName),budget=JSON.parse(readFileSync(budgetPath,'utf8'));
 writeFileSync(budgetPath,JSON.stringify({...budget,runId:randomUUID()}));assert.throws(()=>exportSyntheticRun(root,run),/REPORT_ID_MISMATCH/);
 writeFileSync(budgetPath,JSON.stringify(budget));writeFileSync(join(run,'reports','budget-upgrade-'+randomUUID()+'.json'),JSON.stringify(budget));assert.throws(()=>exportSyntheticRun(root,run),/ONE_REPORT/);
 assert.equal(readdirSync(join(root,'exports')).length,1);
});

