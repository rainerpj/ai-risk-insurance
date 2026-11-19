import { readFileSync } from 'node:fs';
import { loadImportDirectory } from '../packages/service/incident-import-directory.ts';
import { exactObject, identifier, requireIncident as need } from '../packages/domain/incident-schema.ts';
import { parseStrictJSON } from '../packages/domain/evidence.ts';
const [base,directory,sessionFile,key]=process.argv.slice(2);
try {
  need(base && directory && sessionFile && identifier(key),'Usage: import:incidents <http://127.0.0.1:port> <package-directory> <private-session.json> <idempotency-key>');
  const url=new URL(base);need(url.protocol==='http:' && url.hostname==='127.0.0.1' && url.pathname==='/' && !url.username && !url.password && !url.search && !url.hash,'LOCAL_ORIGIN_REQUIRED');
  const session=parseStrictJSON(readFileSync(sessionFile,'utf8'));exactObject(session,['token']);need(typeof session.token==='string' && /^[0-9a-f]{64}$/.test(session.token),'INVALID_SESSION_FILE');
  const bundle=loadImportDirectory(directory);
  const response=await fetch(new URL('/api/incidents-v1/runs/imports',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',authorization:`Bearer ${session.token}`,'idempotency-key':key},body:JSON.stringify(bundle)});
  const result=await response.json() as any;
  if(!response.ok) {console.error(`Import refused: HTTP ${response.status} ${result.error ?? 'REQUEST_FAILED'}`);process.exitCode=1;}
  else console.log(JSON.stringify({importId:result.receipt.importId,status:result.receipt.status,missingPaths:result.receipt.missingPaths,replayed:result.replayed}));
}catch(error){console.error(error instanceof Error && 'statusCode' in error ? error.message : 'IMPORT_FAILED: verify local directory, session and service');process.exitCode=1;}
