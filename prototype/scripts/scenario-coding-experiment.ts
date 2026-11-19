import { writeFileSync } from 'node:fs';
import { runCodingExperiment } from '../packages/service/coding-experiment.ts';
if(process.argv.length!==3 || process.argv[2]!=='--approve-isolated-experiment')throw new Error('Usage: scenario:coding --approve-isolated-experiment (trusted fault injection on NEW synthetic databases only)');
const result=await runCodingExperiment();
const report=`reports/coding-experiment-${result.experimentId}.json`;
writeFileSync(report,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,experimentId:result.experimentId,report,scenarios:result.scenarios,importCount:result.importCount,incidentCount:result.incidentCount}));
