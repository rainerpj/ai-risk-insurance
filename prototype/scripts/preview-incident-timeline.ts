import { join } from 'node:path';
import { runCodingExperiment } from '../packages/service/coding-experiment.ts';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { createIncidentApp } from '../packages/service/incident-api.ts';
// Disposable synthetic-only preview. Never modifies an earlier experiment or a customer store.
const report=await runCodingExperiment();
const store=new IncidentStore(join(report.directory,'incidents.sqlite'));
store.provision('n05-viewer','experiment-tenant','n05-synthetic-preview-password',[{projectId:'experiment-project',role:'viewer'}]);
const port=Number(process.argv[2]??3215);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('INVALID_PORT');
const origin=`http://127.0.0.1:${port}`,app=createIncidentApp(store,origin);
await app.listen({host:'127.0.0.1',port});
console.log(`${origin}/incidents ; synthetic account n05-viewer ; project experiment-project`);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await app.close();store.close();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
