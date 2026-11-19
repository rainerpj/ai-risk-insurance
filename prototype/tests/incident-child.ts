import { IncidentStore } from '../packages/service/incident-store.ts';
const [file,token,payload] = process.argv.slice(2);
const store = new IncidentStore(file!);
try {
  const actor = store.authenticate(token!);
  const result = store.create(actor,'workflow',JSON.parse(payload!),'concurrent-key');
  process.stdout.write(JSON.stringify(result));
} finally { store.close(); }
