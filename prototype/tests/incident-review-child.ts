import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
const [file,id,digest,actorId]=process.argv.slice(2),store=new IncidentStore(file!);
try{new IncidentReport(store).review({actorId:actorId!,tenantId:'tenant'},id!,{projectId:'project',expectedVersion:1,manifestDigest:digest,expectedReviewId:null,decision:'accepted',reason:'Synthetic concurrent reviewer'},'child');console.log('accepted');}catch(e){console.log(e instanceof Error?e.message:'error');process.exitCode=2;}finally{store.close();}
