import {readdirSync} from 'node:fs';
import {spawn} from 'node:child_process';
const domain=['domain.test.ts','evidence.test.ts'];
const contracts=['contracts.test.ts','invariants.test.ts','m1b.test.ts','amount-boundaries.test.ts','claim-signature.test.ts','claim-independence.test.ts','withdrawal-recovery.test.ts','settlement-continuity.test.ts','supervisor-boundary.test.ts'];
const all=readdirSync('tests').filter(n=>n.endsWith('.test.ts')).sort(),groups={domain,contracts,integration:all.filter(n=>!domain.includes(n)&&!contracts.includes(n))};
const key=process.argv[2] as keyof typeof groups;if(!Object.hasOwn(groups,key))throw Error('TEST_GROUP_REQUIRED');
const selected=groups[key];if(selected.some(n=>!all.includes(n)))throw Error('TEST_FILE_MISSING');
console.log(JSON.stringify({group:key,files:selected},null,2));
if(!process.argv.includes('--list')){
 const child=spawn(process.execPath,['--import','tsx','--test',...selected.map(n=>'tests/'+n)],{stdio:'inherit',windowsHide:true});
 child.on('error',()=>{process.exitCode=1;});await new Promise<void>(r=>child.on('close',code=>{process.exitCode=code??1;r();}));
}
