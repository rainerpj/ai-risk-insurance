// Explicit local synthetic browser fixture. No public network or automatic payout.
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {semanticFixture} from '../tests/m2c-fixture.ts';
import {SemanticIntake} from '../packages/service/supplement.ts';
import {reviewerApp} from '../packages/service/automatic-api.ts';
import {createApp} from '../packages/service/api.ts';
import {remoteIntakePortal} from '../packages/service/intake-portal.ts';
import {H} from '../packages/service/reviewer.ts';
import {json} from '../packages/service/store.ts';
const keys:Record<string,string>={},f=await semanticFixture(undefined,{network:'localhost',captureKey:(name,key)=>{keys[name]=key;}});
const tenant=f.q.enterpriseId,caps={[tenant]:randomBytes(32).toString('hex')},intake=new SemanticIntake(f.store,f.reviewer);
const initial=await f.c.notice(f.q,{incidentCommitment:f.scope.commitment,evidenceHash:H([])});
const pending=await intake.run({...f.request,noticeId:initial.n.noticeId,refs:[]},null);
const reviewer=reviewerApp(f.reviewer,randomBytes(32).toString('hex'),f.store,caps);await reviewer.listen({host:'127.0.0.1',port:0});
const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as any).port;await new Promise<void>(r=>socket.close(()=>r()));
const origin='http://127.0.0.1:'+port,portal=remoteIntakePortal('http://127.0.0.1:'+(reviewer.server.address() as any).port,caps,f.store.getMeta('scope')!);
f.store.run('INSERT INTO identities(address,tenant,role) VALUES(?,?,?)',f.c.accounts.insured.address.toLowerCase(),tenant,'insured');
const app=createApp(f.store,f.makeChain('executor'),origin,{intakePortal:portal});await app.listen({host:'127.0.0.1',port});
const metadata={origin,insured:f.c.accounts.insured.address,caseId:pending.id,noticeId:f.request.noticeId,refs:f.refs};
writeFileSync(resolve(f.dir,'preview-private.json'),json({privateKey:keys.insured}));writeFileSync(resolve(f.dir,'preview-public.json'),json(metadata));console.log(json({...metadata,directory:f.dir}));
async function stop(){await app.close();await reviewer.close();f.close();await f.c.connection.close();process.exit(0);}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
