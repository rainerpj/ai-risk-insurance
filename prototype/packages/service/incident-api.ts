import type { IncidentClaimBridge } from './incident-claim-bridge.ts';
import { IncidentRoi } from './incident-roi.ts';
import { IncidentCoverage } from './incident-coverage.ts';
import Fastify from 'fastify';
import { parseStrictJSON } from '../domain/evidence.ts';
import { IncidentFault, exactObject, requireIncident } from '../domain/incident-schema.ts';
import { IncidentStore } from './incident-store.ts';
import { IncidentIngest, INGEST_LIMITS } from './incident-ingest.ts';
import { incidentTimeline } from './incident-timeline.ts';
import { IncidentApproval } from './incident-approval.ts';
import { IncidentInvestigation } from './incident-investigation.ts';
import { IncidentReport } from './incident-report.ts';
import { IncidentExpense,localTestCoverage } from './incident-expense.ts';
import { readFileSync } from 'node:fs';

export function createIncidentApp(store: IncidentStore, origin = 'http://127.0.0.1:3200', bridge?:IncidentClaimBridge) {
  const app = Fastify({logger:false,bodyLimit:128 * 1024});
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'string'},(_req,body,done) => {
    try { done(null,parseStrictJSON(String(body))); } catch { done(new IncidentFault(400,'INVALID_JSON'),undefined); }
  });
  app.setErrorHandler((error: any,_req,reply) => {
    if ([5,6].includes(error.errcode)) return reply.header('Retry-After','1').code(503).send({error:'INCIDENT_BUSY_RETRY'});
    return reply.code(error instanceof IncidentFault ? error.statusCode : error.statusCode ?? 500).send({error:error instanceof IncidentFault ? error.message : 'REQUEST_FAILED'});
  });
  app.addHook('onRequest',async (req,reply) => {
    reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
    requireIncident(!req.headers.origin || req.headers.origin === origin,'ORIGIN_DENIED',403);
    requireIncident(!req.headers['sec-fetch-site'] || ['same-origin','none'].includes(req.headers['sec-fetch-site'] as string),'ORIGIN_DENIED',403);
  });
  const token = (headers: Record<string,unknown>) => {
    const value = headers.authorization;
    requireIncident(typeof value === 'string' && /^Bearer [0-9a-f]{64}$/.test(value),'AUTH_REQUIRED',401);
    return value.slice(7);
  };
  const prefix = '/api/incidents-v1';
  app.get('/test-claims',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incident-claim-bridge.html',import.meta.url),'utf8')));
  app.get('/incident-claim-bridge.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incident-claim-bridge.js',import.meta.url),'utf8')));
  app.post(`${prefix}/incidents/:id/test-claims`,async(req,reply)=>{const actor=store.authenticate(token(req.headers));requireIncident(bridge,'LOCAL_BRIDGE_NOT_CONFIGURED',503);const result=await bridge.create(actor,(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(200).send(result);});
  app.get(`${prefix}/incidents/:id/test-claims`,async req=>{const actor=store.authenticate(token(req.headers));exactObject(req.query,['projectId']);requireIncident(bridge,'LOCAL_BRIDGE_NOT_CONFIGURED',503);return bridge.get(actor,req.query.projectId as string,(req.params as {id:string}).id);});
  app.get('/roi',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incident-roi.html',import.meta.url),'utf8')));
  app.get('/incident-roi.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incident-roi.js',import.meta.url),'utf8')));
  app.put(`${prefix}/workflows/:id/roi-periods/:period`,async req=>new IncidentRoi(store).put(store.authenticate(token(req.headers)),(req.params as {id:string}).id,(req.params as {period:string}).period,req.body,req.headers['idempotency-key'] as string));
  app.get(`${prefix}/workflows/:id/roi`,async req=>{exactObject(req.query,['projectId']);return new IncidentRoi(store).get(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);});
  app.get('/coverage',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incident-coverage.html',import.meta.url),'utf8')));
  app.get('/incident-coverage.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incident-coverage.js',import.meta.url),'utf8')));
  app.get(`${prefix}/incidents/:id/coverage`,async req=>{exactObject(req.query,['projectId']);return new IncidentCoverage(store).get(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);});
  app.put(`${prefix}/incidents/:id/coverage`,async req=>new IncidentCoverage(store).put(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string));
  app.post(`${prefix}/incidents/:id/underwriting-handoffs`,async(req,reply)=>{const result=new IncidentCoverage(store).handoff(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(result.replayed?200:201).send(result);});
  app.get(`${prefix}/underwriting-handoffs/:id`,async(req,reply)=>{exactObject(req.query,['projectId']);const id=(req.params as {id:string}).id,result=new IncidentCoverage(store).download(store.authenticate(token(req.headers)),req.query.projectId as string,id);return reply.header('Content-Disposition',`attachment; filename="underwriting-${id}.json"`).type('application/json').send(result);});
  app.get('/reports',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incident-reports.html',import.meta.url),'utf8')));
  app.get('/incident-reports.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incident-reports.js',import.meta.url),'utf8')));
  app.post(`${prefix}/incidents/:id/reports`,async(req,reply)=>{const result=new IncidentReport(store).publish(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(result.replayed?200:201).send(result);});
  app.get(`${prefix}/incidents/:id/reports`,async req=>{exactObject(req.query,['projectId']);return new IncidentReport(store).list(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);});
  app.get(`${prefix}/reports/:id`,async req=>{exactObject(req.query,['projectId']);return new IncidentReport(store).get(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);});
  app.post(`${prefix}/reports/:id/reviews`,async req=>new IncidentReport(store).review(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string));
  app.post(`${prefix}/reports/:id/exports`,async(req,reply)=>{const result=new IncidentReport(store).export(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(result.replayed?200:201).send(result);});
  app.get(`${prefix}/report-exports/:id`,async(req,reply)=>{exactObject(req.query,['projectId']);const id=(req.params as {id:string}).id,bundle=new IncidentReport(store).download(store.authenticate(token(req.headers)),req.query.projectId as string,id);return reply.header('Content-Disposition',`attachment; filename="investigation-${id}.json"`).type('application/json').send(bundle);});
  app.post(`${prefix}/report-exports/:id/revocation`,async req=>new IncidentReport(store).revoke(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body));
  app.get('/incident-investigations.css',async(_req,reply)=>reply.type('text/css').send(readFileSync(new URL('../../web/incident-investigations.css',import.meta.url),'utf8')));
  app.get('/investigations',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incident-investigations.html',import.meta.url),'utf8')));
  app.get('/incident-investigations.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incident-investigations.js',import.meta.url),'utf8')));
  app.post(`${prefix}/incidents/:id/investigations`,async(req,reply)=>{const result=await new IncidentInvestigation(store).start(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(result.replayed?200:201).send(result);});
  app.get(`${prefix}/investigations/:id`,async req=>{exactObject(req.query,['projectId']);return new IncidentInvestigation(store).get(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);});
  app.get('/expenses',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incident-expenses.html',import.meta.url),'utf8')));
  app.get('/incident-expenses.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incident-expenses.js',import.meta.url),'utf8')));
  app.post(`${prefix}/incidents/:id/expenses`,async(req,reply)=>{const result=new IncidentExpense(store).append(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(result.replayed?200:201).send(result);});
  app.get(`${prefix}/incidents/:id/expenses`,async req=>{exactObject(req.query,['projectId']);return new IncidentExpense(store).summary(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);});
  app.post(`${prefix}/incidents/:id/expenses/local-test`,async req=>{exactObject(req.body,['projectId','terms']);const summary=new IncidentExpense(store).summary(store.authenticate(token(req.headers)),req.body.projectId as string,(req.params as {id:string}).id);const terms=req.body.terms as Record<string,unknown>;localTestCoverage(null,terms);const groups=summary.totals.filter(t=>t.currency===terms.currency&&t.scale===terms.scale);requireIncident(groups.length===1,'CURRENCY_OR_DATA_CLASS_AMBIGUOUS',422);requireIncident(!summary.rows.some(r=>r.line.currency===terms.currency&&r.line.scale===terms.scale&&r.legacyCategory===null),'LEGACY_CATEGORY_UNMAPPED',422);return {...localTestCoverage(groups[0]!.netTotal,terms),dataClass:groups[0]!.dataClass};});
  app.post(`${prefix}/runs/:id/approvals`,async(req,reply)=>{const result=new IncidentApproval(store).create(store.authenticate(token(req.headers)),(req.params as {id:string}).id,req.body,req.headers['idempotency-key'] as string);return reply.code(result.replayed?200:201).send(result);});
  app.get('/incidents',async(_req,reply)=>reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send(readFileSync(new URL('../../web/incidents.html',import.meta.url),'utf8')));
  app.get('/incidents.js',async(_req,reply)=>reply.type('text/javascript').send(readFileSync(new URL('../../web/incidents.js',import.meta.url),'utf8')));
  app.get(`${prefix}/runs/:id/timeline`,async req=>{
    exactObject(req.query,['projectId']);return incidentTimeline(store,store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);
  });
  const ingest = new IncidentIngest(store);
  app.post(`${prefix}/sources`,async(req,reply) => reply.code(200).send(ingest.registerSource(store.authenticate(token(req.headers)),req.body)));
  app.get(`${prefix}/sources/:id`,async req => {
    exactObject(req.query,['projectId']);return ingest.source(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);
  });
  app.post(`${prefix}/sources/:id/revocation`,async req => {
    exactObject(req.body,['projectId','reason']);return ingest.revokeSource(store.authenticate(token(req.headers)),req.body.projectId as string,(req.params as {id:string}).id,req.body.reason as string);
  });
  app.post(`${prefix}/runs/imports`,{bodyLimit:INGEST_LIMITS.requestBytes},async(req,reply) => {
    const result=ingest.import(store.authenticate(token(req.headers)),req.body,req.headers['idempotency-key'] as string);
    return reply.code(result.replayed?200:201).send(result);
  });
  app.get(`${prefix}/imports/:id`,async req => {
    exactObject(req.query,['projectId']);return ingest.get(store.authenticate(token(req.headers)),req.query.projectId as string,(req.params as {id:string}).id);
  });
  app.get(`${prefix}/imports/:id/objects/:objectId`,async(req,reply) => {
    exactObject(req.query,['projectId']);const params=req.params as {id:string;objectId:string};
    const result=ingest.original(store.authenticate(token(req.headers)),req.query.projectId as string,params.id,params.objectId);
    return reply.header('Content-Disposition',`attachment; filename="${params.objectId}.bin"`).type('application/octet-stream').send(result.content);
  });
  app.post(`${prefix}/session`,async req => {
    exactObject(req.body,['actorId','password']);
    return store.login(req.body.actorId as string,req.body.password as string);
  });
  app.delete(`${prefix}/session`,async req => { const t = token(req.headers); store.authenticate(t); store.logout(t); return {loggedOut:true}; });
  app.get(`${prefix}/session`,async req => store.authenticate(token(req.headers)));
  for (const [plural,kind] of [['workflows','workflow'],['runs','run'],['incidents','incident']] as const) {
    app.post(`${prefix}/${plural}`,async (req,reply) => {
      const actor = store.authenticate(token(req.headers));
      const result = store.create(actor,kind,req.body,req.headers['idempotency-key'] as string);
      return reply.code(result.replayed ? 200 : 201).send(result);
    });
    app.get(`${prefix}/${plural}`,async req => {
      const actor = store.authenticate(token(req.headers)), q = req.query as Record<string,string>;
      requireIncident(Object.keys(q).every(k => ['projectId','cursor','limit'].includes(k)));
      requireIncident(q.limit === undefined || /^(?:[1-9]\d?|100)$/.test(q.limit),'INVALID_PAGE');
      return store.list(actor,q.projectId!,kind,q.cursor ?? '0',q.limit === undefined ? 50 : Number(q.limit));
    });
    app.get(`${prefix}/${plural}/:id`,async req => {
      const actor = store.authenticate(token(req.headers)), q = req.query as Record<string,string>;
      exactObject(q,['projectId']);
      return store.get(actor,q.projectId!,kind,(req.params as {id:string}).id);
    });
  }
  return app;
}




