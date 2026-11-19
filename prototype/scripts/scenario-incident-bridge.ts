import {runBridgeScenario} from '../tests/incident-bridge-scenario.ts';
console.log(await runBridgeScenario(async(name,fn)=>{await fn();console.log(`PASS ${name}`);}));
