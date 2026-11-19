import { assertBridge } from './incident-bridge-gate.ts';
import {resolveQuality,resolutionCases} from './quality-resolution.ts';
import {workloadMetrics} from './workload.ts';
import {recordIntakeMeasurement,intakeMeasurementHistory} from './intake-metrics.ts';
import {recordIntakeQuality,intakeQualityStatus,resolveIntakeQuality} from './intake-quality.ts';
import {intakeFollowups} from './intake-followups.ts';
import {noticeGroups} from './notice-groups.ts';
import Fastify from 'fastify';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifyMessage, verifyTypedData, keccak256, stringToHex, encodeAbiParameters, type Hex } from 'viem';
import { Store, Fault, hash, json } from './store.ts';
import { Chain } from './chain.ts';
import { domain, types, digest, decisionContentHash, zeroHash, type MessageType } from '../domain/typed-data.ts';
import {operations,type OperationsOptions} from './operations.ts';
import {recordQuality,qualityStatus,qualityCases} from './quality.ts';
import {recordMeasurement,qualityMetrics} from './metrics.ts';
import {manualReason} from './manual-template.ts';
import {samplingStatus} from './sampling.ts';
const hex32=/^0x[0-9a-fA-F]{64}$/;
const text=(x:any)=>typeof x==='string' && x.length>0 && x.length<=10000;
function requireValue(ok:unknown,message='INVALID_INPUT'): asserts ok {if(!ok)throw new Fault(400,message);}
export function typed(type:MessageType,message:Record<string,unknown>) {
  requireValue(message&&Object.keys(message).length===types[type].length);
  const result:Record<string,unknown>={...message};
  for(const field of types[type])if(field.type.startsWith('uint')){const v=message[field.name];requireValue(typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v),'DECIMAL_STRING_REQUIRED');result[field.name]=BigInt(v);}
  return result;
}
export const intakeMessage=(scope:string,payload:unknown)=>`FDE local intake v1\nDeployment: ${scope}\nPayload SHA256: ${hash(payload)}`;
const roles:Record<string,string[]>={submitNotice:['insured'],registerDecision:['CLAIM_APPROVER'],executePayment:['CLAIM_APPROVER'],setIncidentFreeze:['CLAIM_APPROVER'],appendDispute:['insured'],reopenIncident:['CLAIM_APPROVER']};
export function createApp(s:Store,chain:Chain, origin='http://127.0.0.1:3100',automation:OperationsOptions={}) {
  const app=Fastify({bodyLimit:2*1024*1024,logger:false});
  const scope=s.getMeta('scope')!;
  app.setErrorHandler((e:any,_,reply)=>{if([5,6].includes(e.errcode))return reply.header('retry-after','1').code(503).send({error:'INTAKE_BUSY_RETRY'});return reply.code(e.statusCode??400).send({error:e instanceof Fault?e.message:e.validation?'INVALID_INPUT':'REQUEST_FAILED'});});
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(req.headers.origin && req.headers.origin!==origin)throw new Fault(403,'ORIGIN_DENIED');
    if(req.url.startsWith('/api/') && !req.url.startsWith('/api/auth/')){
      const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const who=token?s.get('SELECT i.* FROM sessions s JOIN identities i ON s.address=i.address WHERE s.token=? AND s.expires>? AND i.enabled=1',hash(token),Date.now()):undefined;
      if(!who)throw new Fault(401,'AUTH_REQUIRED');(req as any).who=who;
    }
  });
  const who=(r:any)=>r.who;
  const owned=(actor:any,tenant:string)=>{if(actor.tenant!==tenant)throw new Fault(404,'NOT_FOUND');};
  const notice=(actor:any,id:string)=>{const n=s.get('SELECT * FROM notices WHERE id=?',id);if(!n)throw new Fault(404,'NOT_FOUND');owned(actor,n.tenant);return n;};
  const policy=async(actor:any,id:string)=>{const p=await chain.policy(id);owned(actor,p.quote.enterpriseId);return p;};
  const independent=(a:any,p:any)=>{if([p.quote.insured,p.fde].map((v:string)=>v.toLowerCase()).includes(a.address))throw new Fault(403,'SELF_REVIEW');};
  function enqueue(a:any,id:string,action:string,args:any[]) {
    const payload=json(args),ph=hash({action,args,actor:a.address});
    return s.tx(()=>{const old=s.get('SELECT * FROM outbox WHERE id=?',id);if(old){owned(a,old.tenant);if(hash({action:old.action,args:JSON.parse(old.payload),actor:old.actor})!==ph)throw new Fault(409,'ID_CONFLICT');return publicJob(old);}
      if(action==='executePayment')for(const pending of s.all("SELECT payload FROM outbox WHERE action='executePayment' AND state NOT IN ('confirmed','failed')"))if(JSON.parse(pending.payload)[0].incidentId===args[0].incidentId)throw new Fault(409,'PAYMENT_UNRESOLVED');
      s.run("INSERT INTO outbox(id,tenant,actor,action,payload,payload_hash,state) VALUES(?,?,?,?,?,?,'queued')",id,a.tenant,a.address,action,payload,ph);s.audit(a.address,action,id);return publicJob(s.get('SELECT * FROM outbox WHERE id=?',id));});
  }
  function publicJob(j:any){const {raw,payload,...rest}=j;return rest;}
  app.post('/api/auth/challenge',async(req:any)=>{
    const {address}=req.body??{};requireValue(typeof address==='string'&&/^0x[0-9a-fA-F]{40}$/.test(address));
    const addr=address.toLowerCase();if(!s.get('SELECT address FROM identities WHERE address=? AND enabled=1',addr))throw new Fault(403,'IDENTITY_NOT_REGISTERED');
    // Bound issuance prevents an untrusted client from filling the database indefinitely.
    s.run('DELETE FROM challenges WHERE expires<?',Date.now());
    if(s.get('SELECT count(*) AS n FROM challenges WHERE address=? AND used=0',addr).n>=5)throw new Fault(429,'TOO_MANY_CHALLENGES');
    const id=randomUUID(),expires=Date.now()+300000;
    const message=`FDE development login v1\nOrigin: ${origin}\nDeployment: ${scope}\nAddress: ${addr}\nNonce: ${randomBytes(32).toString('hex')}\nExpires: ${expires}`;
    s.run('INSERT INTO challenges(id,address,message,expires) VALUES(?,?,?,?)',id,addr,message,expires);return {id,message,expires};
  });
  app.post('/api/auth/login',async(req:any)=>{
    const {id,signature}=req.body??{};requireValue(text(id)&&typeof signature==='string');
    const c=s.get('SELECT * FROM challenges WHERE id=?',id);if(!c||c.used||c.expires<=Date.now())throw new Fault(401,'CHALLENGE_EXPIRED_OR_USED');
    if(!await verifyMessage({address:c.address,message:c.message,signature:signature as Hex}))throw new Fault(401,'INVALID_SIGNATURE');
    const token=randomBytes(32).toString('hex');
    s.tx(()=>{const changed=s.run('UPDATE challenges SET used=1 WHERE id=? AND used=0 AND expires>?',id,Date.now());if(!changed.changes)throw new Fault(401,'CHALLENGE_EXPIRED_OR_USED');s.run('INSERT INTO sessions VALUES(?,?,?)',hash(token),c.address,Date.now()+3600000);});
    return {token};
  });
  app.get('/api/me',async(req:any)=>who(req));
  app.post('/api/logout',async(req:any)=>{s.run('DELETE FROM sessions WHERE token=?',hash(req.headers.authorization.slice(7)));return {ok:true};});
  app.get('/api/status',async()=>({deployment:scope,head:s.getMeta('head')??null,confirmed:s.getMeta('confirmed')??null,halted:s.getMeta('halted')??'',indexError:s.getMeta('indexError')?'RPC_OR_INDEX_UNAVAILABLE':'',mode:'local synthetic; automation status is queried separately'}));
  app.get('/api/semantic-intake',async(req:any)=>{
    const a=who(req);if(!['insured','ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');
    if(!automation.intakePortal)return {state:'not_configured',cases:[]};
    try{return {state:'available',...await automation.intakePortal.status(a.tenant)};}catch{throw new Fault(503,'INTAKE_SERVICE_UNAVAILABLE');}
  });
  app.post('/api/semantic-originals',async(req:any)=>{
    const a=who(req);if(a.role!=='insured')throw new Fault(403,'ROLE_DENIED');
    if(!automation.intakePortal)throw new Fault(503,'INTAKE_SERVICE_UNAVAILABLE');
    const b=req.body;requireValue(b&&Object.keys(b).sort().join()==='document,noticeId'&&hex32.test(b.noticeId)&&typeof b.document==='string'&&Buffer.byteLength(b.document)<=100000);
    const n=await chain.read('getNotice',[b.noticeId]);await policy(a,n.data.policyId);
    const result=await automation.intakePortal.import(a.tenant,b);s.audit(a.address,'signed_original_submitted',result.ref);return result;
  });
  app.post('/api/semantic-supplement',async(req:any)=>{
    const a=who(req);if(a.role!=='insured')throw new Fault(403,'ROLE_DENIED');
    if(!automation.intakePortal)throw new Fault(503,'INTAKE_SERVICE_UNAVAILABLE');
    const result=await automation.intakePortal.submit(a.tenant,req.body);s.audit(a.address,'supplement_submitted',req.body.caseId);return result;
  });
  app.get('/api/quality/workload',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return workloadMetrics(s,chain,a.tenant);});
  app.post('/api/quality/intake-measurements',async(req:any)=>recordIntakeMeasurement(s,chain,who(req),req.body));
  app.post('/api/quality/intake-reviews',async(req:any)=>recordIntakeQuality(s,chain,who(req),req.body,automation));
  app.post('/api/quality/intake-resolutions',async(req:any)=>resolveIntakeQuality(s,chain,who(req),req.body));
  app.get('/api/quality/intake-followups',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return intakeFollowups(s,chain,a.tenant);});
  app.get('/api/quality/intake-reviews',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return intakeQualityStatus(s,chain,a.tenant);});
  app.get('/api/quality/intake-measurements',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return intakeMeasurementHistory(s,a.tenant);});
  app.get('/api/notice-groups',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return noticeGroups(s,chain,a.tenant);});
  app.get('/api/automation',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return operations(chain,a.tenant,automation);});
  app.post('/api/quality',async(req:any)=>recordQuality(s,chain,who(req),req.body,automation.safetyGovernor));
  app.post('/api/quality/resolutions',async(req:any)=>resolveQuality(s,chain,who(req),req.body));
  app.post('/api/quality/measurements',async(req:any)=>recordMeasurement(s,chain,who(req),req.body));
  app.get('/api/quality/measurements',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return s.all('SELECT id,review_id,actor,payload,created_at FROM quality_measurements WHERE tenant=? ORDER BY rowid DESC',a.tenant).map(r=>({...r,payload:JSON.parse(r.payload)}));});
  app.get('/api/quality/metrics',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return qualityMetrics(s,chain,a.tenant);});
  app.get('/api/quality/cases',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return resolutionCases(s,chain,a.tenant,await qualityCases(s,chain,a.tenant));});
  app.get('/api/quality/samples',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return samplingStatus(s,chain,a.tenant);});
  app.get('/api/quality',async(req:any)=>{const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');return qualityStatus(s,chain,a.tenant);});
  app.post('/api/notices',async(req:any,reply)=>{
    const a=who(req);if(a.role!=='insured')throw new Fault(403,'ROLE_DENIED');
    const {payload,signature}=req.body??{};
    requireValue(payload&&['declaredIncidentAt,evidenceHash,incidentCommitment,noticeId,policyId,summary','claimedAmount,declaredIncidentAt,evidenceHash,incidentCommitment,noticeId,policyId,summary'].includes(Object.keys(payload).sort().join(',')));
    if('claimedAmount' in payload)requireValue(typeof payload.claimedAmount==='string'&&/^(0|[1-9]\d*)$/.test(payload.claimedAmount)&&BigInt(payload.claimedAmount)<2n**256n);
    requireValue(hex32.test(payload.noticeId)&&hex32.test(payload.incidentCommitment)&&hex32.test(payload.evidenceHash));
    requireValue(payload.policyId===null||hex32.test(payload.policyId));requireValue(typeof payload.declaredIncidentAt==='string'&&/^(0|[1-9]\d*)$/.test(payload.declaredIncidentAt)&&BigInt(payload.declaredIncidentAt)<2n**64n);requireValue(text(payload.summary));
    if(!await verifyMessage({address:a.address,message:intakeMessage(scope,payload),signature}))throw new Fault(401,'INVALID_INTAKE_SIGNATURE');
    await assertBridge(s,'intake',payload);
    const accepted=s.tx(()=>{const old=s.get('SELECT * FROM notices WHERE id=?',payload.noticeId);
      if(old){owned(a,old.tenant);if(hash(JSON.parse(old.payload).payload)!==hash(payload))throw new Fault(409,'ID_CONFLICT');return old;}
      s.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',payload.noticeId,a.tenant,a.address,json({payload,signature}),hash(payload),new Date().toISOString(),'awaiting_binding');s.audit(a.address,'notice_received',payload.noticeId);return s.get('SELECT * FROM notices WHERE id=?',payload.noticeId);});
    reply.code(202);return {noticeId:accepted.id,receivedAt:accepted.received_at,state:accepted.state,anchoredAt:null};
  });
  app.get('/api/notices',async(req:any)=>s.all('SELECT id,received_at,state,payload,binding FROM notices WHERE tenant=? ORDER BY rowid DESC',who(req).tenant).map(n=>{
    const originalCount=s.get('SELECT count(*) n FROM evidence WHERE notice_id=? AND tenant=?',n.id,who(req).tenant).n;
    return {...n,payload:JSON.parse(n.payload).payload,binding:n.binding?JSON.parse(n.binding):null,chain:s.get("SELECT payload FROM views WHERE kind='notice' AND id=?",n.id)?.payload??null,evidenceStatus:{originalCount,originals:originalCount?'stored_unverified':'missing',verification:'not_evaluated'}};
  }));
  app.post('/api/notices/:id/bind',async(req:any)=>{
    const a=who(req),row=notice(a,req.params.id);if(a.role!=='insured'||row.owner!==a.address)throw new Fault(403,'ROLE_DENIED');
    const {authorization:n,signature}=req.body??{},p0=JSON.parse(row.payload).payload;requireValue(n&&n.noticeId===row.id&&n.declaredIncidentAt===p0.declaredIncidentAt&&n.incidentCommitment===p0.incidentCommitment&&n.evidenceHash===p0.evidenceHash&&n.submitter.toLowerCase()===a.address);
    if(p0.policyId && p0.policyId!==n.policyId)throw new Fault(409,'POLICY_CONFLICT');
    const p=await policy(a,n.policyId);requireValue(p.quote.insured.toLowerCase()===a.address);
    if(!await verifyTypedData({address:a.address as Hex,domain:domain(chain.core,chain.deploymentId),types,primaryType:'NoticeAuthorization',message:n,signature}))throw new Fault(401,'INVALID_NOTICE_SIGNATURE');
    digest('NoticeAuthorization',typed('NoticeAuthorization',n),domain(chain.core,chain.deploymentId)); // strict schema and integer bounds
    const binding=json({authorization:n,signature});if(row.binding && hash(JSON.parse(row.binding))!==hash({authorization:n,signature}))throw new Fault(409,'BINDING_CONFLICT');
    await assertBridge(s,'notice',n);const job=enqueue(a,n.noticeId,'submitNotice',[n,signature]);s.run("UPDATE notices SET binding=?,state='queued' WHERE id=?",binding,row.id);return job;
  });
  app.post('/api/notices/:id/evidence',async(req:any)=>{
    const a=who(req),n=notice(a,req.params.id);if(a.role!=='insured'||n.owner!==a.address)throw new Fault(403,'ROLE_DENIED');
    const {contentBase64,mediaType}=req.body??{};requireValue(typeof contentBase64==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)&&text(mediaType));
    const bytes=Buffer.from(contentBase64,'base64'),id=randomUUID(),d=createHash('sha256').update(bytes).digest('hex');requireValue(bytes.length<=1024*1024);
    s.tx(()=>{s.run('INSERT INTO evidence VALUES(?,?,?,?,?,?,?)',id,n.id,a.tenant,bytes,d,mediaType,new Date().toISOString());s.audit(a.address,'evidence_added',id);});return {id,digest:d};
  });
  app.get('/api/evidence/:id',async(req:any,reply)=>{const e=s.get('SELECT * FROM evidence WHERE id=?',req.params.id);if(!e)throw new Fault(404,'NOT_FOUND');owned(who(req),e.tenant);s.audit(who(req).address,'evidence_read',e.id);reply.header('Content-Disposition','attachment; filename="evidence.bin"').type('application/octet-stream');return Buffer.from(e.content);});
  app.get('/api/views/:kind',async(req:any)=>{requireValue(['policy','incident','notice','pool'].includes(req.params.kind));if(req.params.kind==='pool'&&who(req).role==='insured')throw new Fault(403,'ROLE_DENIED');return s.all('SELECT * FROM views WHERE kind=? AND tenant=?',req.params.kind,req.params.kind==='pool'?'staff':who(req).tenant).map(v=>({...v,payload:JSON.parse(v.payload)}));});
  app.get('/api/transactions',async(req:any)=>s.all('SELECT * FROM outbox WHERE tenant=? ORDER BY rowid DESC',who(req).tenant).map(publicJob));
  app.get('/api/reviews',async(req:any)=>s.all('SELECT * FROM reviews WHERE tenant=? ORDER BY rowid',who(req).tenant));
  app.get('/api/drafts',async(req:any)=>s.all('SELECT * FROM drafts WHERE tenant=? ORDER BY rowid DESC',who(req).tenant).map(d=>({...d,payload:JSON.parse(d.payload),signatures:JSON.parse(d.signatures)})));
  app.post('/api/drafts',async(req:any)=>{
    const a=who(req);if(a.role!=='ASSESSOR')throw new Fault(403,'ROLE_DENIED');
    const {policyId,incidentId,noticeIds,expenses,approver,aggregation,templateId}=req.body??{};let {reason}=req.body??{};
    requireValue(hex32.test(incidentId)&&Array.isArray(noticeIds)&&noticeIds.length>0&&noticeIds.every(n=>hex32.test(n))&&new Set(noticeIds).size===noticeIds.length&&text(reason));
    let claimed=0n;
    if(noticeIds.length>1){
      requireValue(aggregation&&Object.keys(aggregation).sort().join(',')==='claimedTotal,confirmed,reason'&&aggregation.confirmed===true&&text(aggregation.reason),'AGGREGATION_CONFIRMATION_REQUIRED');
      requireValue(typeof aggregation.claimedTotal==='string'&&/^(0|[1-9]\d*)$/.test(aggregation.claimedTotal)&&BigInt(aggregation.claimedTotal)<2n**256n);
      claimed=BigInt(aggregation.claimedTotal);reason+='\n归并核验：'+aggregation.reason+'；累计申请（最小单位）：'+claimed;
    }
    if(templateId!==undefined&&templateId!==null)requireValue(hex32.test(templateId)&&templateId!==zeroHash,'MANUAL_TEMPLATE_ID_INVALID');
    reason=manualReason(reason,templateId);
    let knownClaims=0n;
    for(const noticeId of noticeIds){const row=s.get('SELECT payload FROM notices WHERE id=? AND tenant=?',noticeId,a.tenant);if(row){const value=JSON.parse(row.payload).payload?.claimedAmount;if(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value))knownClaims+=BigInt(value);}}
    if(noticeIds.length>1)requireValue(claimed>=knownClaims,'CLAIM_TOTAL_BELOW_RECORDED');else claimed=knownClaims;
    requireValue(Array.isArray(expenses)&&expenses.length===2);let loss=0n;
    for(const e of expenses){requireValue(Object.keys(e).sort().join(',')==='compensation,duplicate,gross,recovery');for(const v of Object.values(e))requireValue(typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&BigInt(v)<2n**256n);const deduction=BigInt(e.duplicate)+BigInt(e.compensation)+BigInt(e.recovery);requireValue(deduction<=BigInt(e.gross));loss+=BigInt(e.gross)-deduction;}
    const p=await policy(a,policyId);independent(a,p);
    const reviewer=s.get("SELECT * FROM identities WHERE address=? AND tenant=? AND role='CLAIM_APPROVER' AND enabled=1",String(approver).toLowerCase(),a.tenant);if(!reviewer)throw new Fault(403,'APPROVER_NOT_REGISTERED');independent(reviewer,p);
    const i=await chain.read('getIncident',[incidentId]);if(i.version){requireValue(i.policyId===policyId);if(!i.frozen)throw new Fault(409,'FREEZE_AND_RECONCILE_FIRST');}
    for(const noticeId of noticeIds){const n=await chain.read('getNotice',[noticeId]);requireValue(n.data.policyId===policyId,'NOTICE_POLICY_MISMATCH');}
    const other=p.paidTotal+p.dueTotal-i.P-i.D,extra1=p.quote.incidentLimit-i.P,extra2=p.quote.annualLimit-other-i.P;
    requireValue(extra1>=0n&&extra2>=0n);const cap=i.P-i.R+(extra1<extra2?extra1:extra2),approved=loss<cap?loss:cap,reviewAmount=[claimed,loss,i.P+i.D,approved].reduce((x,y)=>x>y?x:y);requireValue(reviewAmount<2n**256n);
    const id=`0x${randomBytes(32).toString('hex')}`,expiry=(await chain.client.getBlock()).timestamp+3600n;
    const fields=['gross','duplicate','compensation','recovery'].map(name=>({name,type:'uint256'}));
    const d:any={decisionId:id,policyId,incidentId,noticeSetHash:keccak256(encodeAbiParameters([{type:'bytes32[]'}],[[...noticeIds].sort()])),version:i.version+1n,previousVersion:i.version,expectedLedgerHash:await chain.read('ledgerHash',[policyId,incidentId]),assessmentHash:zeroHash,amountsHash:keccak256(encodeAbiParameters([{type:'tuple[2]',components:fields}],[expenses as [Record<string,unknown>,Record<string,unknown>]])),netApproved:approved,beneficiary:p.quote.beneficiary,reasonHash:keccak256(stringToHex(reason)),reviewAmount,channel:0n,grantId:zeroHash,grantEpoch:0n,budgetVersion:0n,reservationId:zeroHash,approver:reviewer.address,signerEpoch:await chain.read('epochs',[reviewer.address]),expiresAt:expiry};
    const assessment={decisionContentHash:decisionContentHash(d),assessor:a.address,signerEpoch:await chain.read('epochs',[a.address]),expiresAt:expiry};d.assessmentHash=digest('Assessment',assessment,domain(chain.core,chain.deploymentId));
    if(!await chain.read('hasRole',[keccak256(stringToHex('ASSESSOR')),a.address]))throw new Fault(403,'CHAIN_ROLE_REVOKED');
    await assertBridge(s,'draft',{d,expenses,noticeIds:[...noticeIds].sort(),reason});
    const aSig=await chain.sign(a.address,'Assessment',assessment),draft={d,assessment,expenses,noticeIds:[...noticeIds].sort(),reason};
    s.tx(()=>{s.run('INSERT INTO drafts VALUES(?,?,?,?)',id,a.tenant,json(draft),json({assessment:aSig}));s.run('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)',randomUUID(),a.tenant,incidentId,a.address,a.role,reason,json(draft),new Date().toISOString());});return JSON.parse(json({id,draft}));
  });
  app.post('/api/drafts/:id/sign',async(req:any)=>{
    const a=who(req),row=s.get('SELECT * FROM drafts WHERE id=?',req.params.id);if(!row)throw new Fault(404,'NOT_FOUND');owned(a,row.tenant);
    const draft=JSON.parse(row.payload),d=typed('ClaimDecision',draft.d),p=await policy(a,d.policyId as string);independent(a,p);
    if(!['CLAIM_APPROVER','SUPERVISOR'].includes(a.role)||!await chain.read('hasRole',[keccak256(stringToHex(a.role)),a.address]))throw new Fault(403,'ROLE_DENIED');
    await assertBridge(s,'draft',draft);let patch:any;
    if(a.role==='CLAIM_APPROVER'){requireValue(a.address===String(d.approver).toLowerCase());patch={decision:await chain.sign(a.address,'ClaimDecision',d)};}
    else {requireValue((d.reviewAmount as bigint)>50000n*1000000n && ![draft.assessment.assessor,d.approver].map(x=>String(x).toLowerCase()).includes(a.address));const supervisor={decisionDigest:digest('ClaimDecision',d,domain(chain.core,chain.deploymentId)),supervisor:a.address,signerEpoch:await chain.read('epochs',[a.address]),expiresAt:d.expiresAt};patch={supervisor,supervisorSignature:await chain.sign(a.address,'SupervisorApproval',supervisor)};}
    s.tx(()=>{const sigs=JSON.parse(s.get('SELECT signatures FROM drafts WHERE id=?',row.id).signatures);s.run('UPDATE drafts SET signatures=? WHERE id=?',json({...sigs,...patch}),row.id);s.audit(a.address,'draft_signed',row.id);});return {ok:true};
  });
  app.post('/api/drafts/:id/submit',async(req:any)=>{
    const a=who(req),row=s.get('SELECT * FROM drafts WHERE id=?',req.params.id);if(!row)throw new Fault(404,'NOT_FOUND');owned(a,row.tenant);
    const d=JSON.parse(row.payload),sig=JSON.parse(row.signatures);if(a.role!=='CLAIM_APPROVER'||d.d.approver.toLowerCase()!==a.address)throw new Fault(403,'ROLE_DENIED');
    requireValue(sig.decision&&sig.assessment&& (BigInt(d.d.reviewAmount)<=50000000000n||sig.supervisorSignature),'SIGNATURES_INCOMPLETE');
    const args=[d.d,d.expenses,d.noticeIds,d.assessment,sig.assessment,sig.decision,sig.supervisor??{decisionDigest:zeroHash,supervisor:`0x${'00'.repeat(20)}`,signerEpoch:'0',expiresAt:'0'},sig.supervisorSignature??'0x'];
    const result=await app.inject({method:'POST',url:'/api/actions',headers:{authorization:req.headers.authorization},payload:{id:row.id,action:'registerDecision',args,reason:d.reason}});
    if(result.statusCode!==200)throw new Fault(result.statusCode,result.json().error);return result.json();
  });
  app.post('/api/manual/:action',async(req:any)=>{
    const a=who(req),{incidentId,reason,amount}=req.body??{};requireValue(hex32.test(incidentId)&&text(reason));const i=await chain.incident(incidentId);await policy(a,i.policyId);
    let action='',args:any[]=[],id=`0x${randomBytes(32).toString('hex')}`;
    if(req.params.action==='payment'){
      if(a.role!=='CLAIM_APPROVER')throw new Fault(403,'ROLE_DENIED');requireValue(typeof amount==='string'&&/^[1-9]\d*$/.test(amount));
      const p=await policy(a,i.policyId),payment={paymentId:id,policyId:i.policyId,incidentId,decisionVersion:i.version,decisionDigest:i.decisionDigest,token:p.quote.token,beneficiary:p.quote.beneficiary,amount:BigInt(amount),installmentIndex:i.installmentIndex+1n,grantId:zeroHash,grantEpoch:0n,budgetVersion:0n,reservationId:zeroHash,supersedesPaymentId:zeroHash,signerEpoch:await chain.read('epochs',[a.address]),expiresAt:(await chain.client.getBlock()).timestamp+900n};
      // A new ID must not overtake an unresolved installment, including unknown or orphaned transactions.
      for(const pending of s.all("SELECT payload FROM outbox WHERE action='executePayment' AND state NOT IN ('confirmed','failed')"))if(JSON.parse(pending.payload)[0].incidentId===incidentId)throw new Fault(409,'PAYMENT_UNRESOLVED');
      // Explain common refusals using the live ledger, before signing. Contract simulation
      // and execution still enforce all authorization and ledger checks below.
      if(i.frozen)throw new Fault(409,'PAYMENT_FROZEN');
      if(i.D===0n)throw new Fault(409,'PAYMENT_NOT_DUE');
      if(BigInt(amount)>i.D)throw new Fault(409,'PAYMENT_EXCEEDS_DUE');
      await assertBridge(s,'payment',payment);action='executePayment';args=[payment,await chain.sign(a.address,'PaymentAuthorization',payment)];
    }else if(['freeze','unfreeze'].includes(req.params.action)){action='setIncidentFreeze';args=[incidentId,req.params.action==='freeze',keccak256(stringToHex(reason))];}
    else if(req.params.action==='dispute'){action='appendDispute';args=[incidentId,id,i.version,keccak256(stringToHex(reason))];}
    else if(req.params.action==='reopen'){action='reopenIncident';args=[i.activeDispute,keccak256(stringToHex(reason))];}
    else throw new Fault(404,'NOT_FOUND');
    const result=await app.inject({method:'POST',url:'/api/actions',headers:{authorization:req.headers.authorization},payload:JSON.parse(json({id,action,args,reason}))});
    if(result.statusCode!==200)throw new Fault(result.statusCode,result.json().error);return result.json();
  });
  app.post('/api/incidents/:id/review',async(req:any)=>{
    const a=who(req);if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(a.role))throw new Fault(403,'ROLE_DENIED');
    const {policyId,reason,payload}=req.body??{};requireValue(hex32.test(policyId)&&text(reason));const p=await policy(a,policyId);independent(a,p);
    const current=await chain.read('getIncident',[req.params.id]);if(current.version&&current.policyId!==policyId)throw new Fault(409,'INCIDENT_POLICY_CONFLICT');
    const id=randomUUID();s.tx(()=>{s.run('INSERT INTO reviews VALUES(?,?,?,?,?,?,?,?)',id,a.tenant,req.params.id,a.address,a.role,reason,json({policyId,payload}),new Date().toISOString());s.audit(a.address,'review',id);});return {id};
  });
  app.post('/api/actions',async(req:any)=>{
    const a=who(req),{id,action,args,reason}=req.body??{};requireValue(hex32.test(id)&&Array.isArray(args)&&text(reason));
    if(!roles[action]?.includes(a.role)||action==='submitNotice')throw new Fault(403,'ROLE_DENIED');
    const rejectNumber=(value:any):void=>{if(typeof value==='number')throw new Fault(400,'DECIMAL_STRING_REQUIRED');if(value&&typeof value==='object')for(const v of Object.values(value))rejectNumber(v);};rejectNumber(args);
    if(s.getMeta('halted')||s.getMeta('indexError'))throw new Fault(503,'INDEX_NOT_READY');
    let p:any;
    if(action==='registerDecision') {p=await policy(a,args[0].policyId);requireValue(id===args[0].decisionId&&args[0].reasonHash===keccak256(stringToHex(reason)));}
    else if(action==='executePayment'){p=await policy(a,args[0].policyId);requireValue(id===args[0].paymentId);}
    else {let incidentId=args[0];if(action==='reopenIncident'){const d=await chain.read('disputes',[args[0]]);incidentId=d[0];}const i=await chain.incident(incidentId);p=await policy(a,i.policyId);const reasonIndex=action==='appendDispute'?3:action==='setIncidentFreeze'?2:1;requireValue(args[reasonIndex]===keccak256(stringToHex(reason)));}
    if(a.role==='insured'){if(p.quote.insured.toLowerCase()!==a.address)throw new Fault(403,'OWNER_REQUIRED');}else independent(a,p);
    await chain.client.simulateContract({address:chain.core,abi:(await import('./chain.ts')).coreAbi,functionName:action,args,account:a.address});
    await assertBridge(s,'action',{action,args});const job=enqueue(a,id,action,args);s.audit(a.address,'reason',`${id}:${reason}`);return job;
  });
  app.post('/api/sign',async(req:any)=>{
    const a=who(req),{type,message,decision,policyId}=req.body??{};
    const permitted:Record<string,string>={Assessment:'ASSESSOR',ClaimDecision:'CLAIM_APPROVER',SupervisorApproval:'SUPERVISOR',PaymentAuthorization:'CLAIM_APPROVER',NoticeAuthorization:'insured'};
    if(permitted[type]!==a.role)throw new Fault(403,'ROLE_DENIED');
    const p=await policy(a,policyId);if(a.role!=='insured')independent(a,p);else requireValue(p.quote.insured.toLowerCase()===a.address);
    if(type==='Assessment'){requireValue(decision?.policyId===policyId&&message.decisionContentHash===decisionContentHash(typed('ClaimDecision',decision))&&message.assessor.toLowerCase()===a.address);}
    else if(type==='SupervisorApproval'){requireValue(decision?.policyId===policyId&&message.decisionDigest===digest('ClaimDecision',typed('ClaimDecision',decision),domain(chain.core,chain.deploymentId))&&message.supervisor.toLowerCase()===a.address);}
    else {requireValue(message.policyId===policyId);const field=type==='ClaimDecision'?'approver':type==='NoticeAuthorization'?'submitter':null;if(field)requireValue(message[field].toLowerCase()===a.address);}
    if(a.role!=='insured'&&!await chain.read('hasRole',[keccak256(stringToHex(a.role)),a.address]))throw new Fault(403,'CHAIN_ROLE_REVOKED');
    requireValue(BigInt(message.signerEpoch)===await chain.read('epochs',[a.address]));
    const typedDomain=domain(chain.core,chain.deploymentId),normalized=typed(type as MessageType,message);digest(type as MessageType,normalized,typedDomain);
    await assertBridge(s,type==='NoticeAuthorization'?'notice':'raw-sign',{...normalized,policyId});
    const signature=await chain.sign(a.address,type,normalized),messageDigest=digest(type as MessageType,normalized,typedDomain);
    s.tx(()=>{s.run('INSERT INTO signed_messages VALUES(?,?,?,?,?,?) ON CONFLICT(digest,actor) DO NOTHING',messageDigest,a.address,a.tenant,type,json(normalized),signature);s.audit(a.address,'development_signature',messageDigest);});return {signature,mode:'development signer; local chain only'};
  });
  app.post('/api/exports',async(req:any)=>{
    const a=who(req),result={deployment:scope,tenant:a.tenant,notices:s.all('SELECT id,payload,received_at,binding FROM notices WHERE tenant=?',a.tenant),evidence:s.all('SELECT id,notice_id,digest,media_type FROM evidence WHERE tenant=?',a.tenant),reviews:s.all('SELECT * FROM reviews WHERE tenant=?',a.tenant),drafts:s.all('SELECT * FROM drafts WHERE tenant=?',a.tenant),signatures:s.all('SELECT * FROM signed_messages WHERE tenant=?',a.tenant),transactions:s.all('SELECT * FROM outbox WHERE tenant=?',a.tenant).map(j=>({...publicJob(j),payload:JSON.parse(j.payload)})),views:s.all('SELECT * FROM views WHERE tenant=?',a.tenant)};
    s.audit(a.address,'export',a.tenant);return result;
  });
  for(const [url,file,type] of [['/','index.html','text/html'],['/app.js','app.js','text/javascript'],['/style.css','style.css','text/css']])app.get(url!,async(_,reply)=>reply.type(type!).send(readFileSync(new URL(`../../web/${file}`,import.meta.url))));
  return app;
}


