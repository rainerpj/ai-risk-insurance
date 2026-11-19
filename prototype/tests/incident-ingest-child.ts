import { IncidentStore } from '../packages/service/incident-store.ts';
import { IncidentIngest } from '../packages/service/incident-ingest.ts';
const [file,token,bundle]=process.argv.slice(2);const store=new IncidentStore(file!);
try{process.stdout.write(JSON.stringify(new IncidentIngest(store).import(store.authenticate(token!),JSON.parse(bundle!),'concurrent-import')));}finally{store.close();}
