import {readFileSync} from 'node:fs';
import {localIntakeGate} from '../packages/service/intake-gate.ts';
const input=JSON.parse(readFileSync(process.argv[2]!,'utf8'));
await localIntakeGate(input.path,input.scope)(input.request,input.quote,input.decision,input.commitment,async()=>{
 process.send?.({state:'locked'});
 await new Promise<void>(()=>{setInterval(()=>{},1000);});
});
