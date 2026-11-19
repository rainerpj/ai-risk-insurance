import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInvestigationCase,type FixedCase } from '../tests/incident-investigation-fixture.ts';
const corpus=JSON.parse(readFileSync(new URL('../tests/fixtures/incident-investigation-cases.json',import.meta.url),'utf8')),rows=[];
for(const c of corpus.cases as FixedCase[]){try{rows.push(await runInvestigationCase(c));}catch(e){rows.push({caseId:c.id,expected:c.expected,passed:false,error:e instanceof Error?e.message:'error'});}}
mkdirSync('reports',{recursive:true});const path=`reports/incident-n07-evaluation-${randomUUID()}.json`;writeFileSync(path,JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),corpusVersion:corpus.version,basis:corpus.basis,realModelEvaluated:false,independentHumanBaseline:false,rows},null,2));console.log(path);if(rows.some(r=>!r.passed))process.exitCode=1;
