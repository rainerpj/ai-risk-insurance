import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentIngest,byteDigest,type ImportBundle } from '../packages/service/incident-ingest.ts';
import type { Workflow,AgentRun,Incident } from '../packages/domain/incident-schema.ts';
export function fixture(){
 const file=join(mkdtempSync(join(tmpdir(),'incident-finance-')),'store.sqlite'),store=new IncidentStore(file),password='synthetic-finance-password';
 for(const [id,tenant,role] of [['admin','tenant','enterprise_admin'],['viewer','tenant','viewer'],['foreign','other','enterprise_admin'],['investigator','tenant','investigator']] as const)store.provision(id,tenant,password,[{projectId:'project',role}]);
 const token=store.login('admin',password).token,actor=store.authenticate(token),ingest=new IncidentIngest(store);
 const workflow=store.create(actor,'workflow',{schemaVersion:1,projectId:'project',enterpriseId:'enterprise',fdePartyId:null,repoRef:'test',allowedActions:['deploy'],approvalPolicyVersion:'v1',dataAuthorizationRef:'auth'},'w').record as Workflow;
 const run=store.create(actor,'run',{schemaVersion:1,projectId:'project',workflowId:workflow.workflowId,taskRef:'test',agentProvider:null,modelVersion:null,toolVersions:{},baseRevision:null,resultRevision:null,startedAt:null,endedAt:null,captureCoverage:{collected:[],missing:[]},environment:'synthetic'},'r').record as AgentRun;
 const incident=store.create(actor,'incident',{schemaVersion:1,projectId:'project',workflowId:workflow.workflowId,runIds:[run.runId],detectedAt:null,severity:'low',affectedAssets:[],statement:'synthetic',groupingReason:null,linkedIncidentIds:[]},'i').record as Incident;
 ingest.registerSource(actor,{schemaVersion:1,projectId:'project',sourceId:'source',controllerPartyId:'controller',kind:'synthetic',allowedWorkflowIds:[workflow.workflowId],captureMethod:'synthetic',keyId:null,publicKey:null,validFrom:'2020-01-01T00:00:00.000Z',validUntil:null});
 let n=0;
 function add(content:string,extension='txt'){
  const id=`object-${++n}`,path=`${id}.${extension}`,bytes=Buffer.from(content);
  const bundle:ImportBundle={manifest:{schemaVersion:1,projectId:'project',packageId:`package-${n}`,runId:run.runId,dataAuthorizationRef:'auth',dataClass:'synthetic',supersedesImportId:null,objects:[{objectId:id,path,sourceId:'source',mediaType:extension==='json'?'application/json':'text/plain',byteLength:bytes.length,sha256:byteDigest(bytes),signature:null}]},objects:[{path,contentBase64:bytes.toString('base64')}]};
  const receipt=ingest.import(actor,bundle,`import-${n}`).receipt;return {importId:receipt.importId,objectId:id,digest:byteDigest(bytes)};
 }
 return {file,store,actor,token,ingest,run,incident,workflow,add,password};
}
