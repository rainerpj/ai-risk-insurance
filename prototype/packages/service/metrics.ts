import {Chain} from './chain.ts';
import {Store,Fault,hash,json} from './store.ts';
import {qualityStatus} from './quality.ts';
import {qualityPopulation} from './quality-population.ts';
import {validateCostBreakdown,summarizeCostBreakdowns} from './cost-breakdown.ts';
import {keccak256,stringToHex} from 'viem';
const fields=['id','reviewId','processingMs','humanMs','costCurrency','costMicros','wrongPaid','underpaid','duplicatePayments','manualOverturned','appealOverturned','reason'];
const integer=(v:any)=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&BigInt(v)<2n**128n;
export async function recordMeasurement(s:Store,chain:Chain,actor:any,input:any){
 if(!['ASSESSOR','CLAIM_APPROVER','SUPERVISOR'].includes(actor.role))throw new Fault(403,'ROLE_DENIED');
 if(!input||Object.keys(input).sort().join()!==[...fields,...(input.costBreakdown===undefined?[]:['costBreakdown'])].sort().join()||!/^0x[a-f0-9]{64}$/.test(input.id)||!/^0x[a-f0-9]{64}$/.test(input.reviewId)||
  !['processingMs','humanMs','costMicros','wrongPaid','underpaid','duplicatePayments'].every(k=>input[k]===null||integer(input[k]))||
  !['manualOverturned','appealOverturned'].every(k=>input[k]===null||typeof input[k]==='boolean')||
  !(input.costCurrency===null||typeof input.costCurrency==='string'&&/^[A-Z]{3}$/.test(input.costCurrency))||
  (input.costMicros===null)!==(input.costCurrency===null)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>10000)throw new Fault(400,'MEASUREMENT_SCHEMA');
 validateCostBreakdown(input);
 const review=s.get('SELECT * FROM quality_reviews WHERE id=? AND tenant=?',input.reviewId,actor.tenant);
 if(!review)throw new Fault(404,'NOT_FOUND');
 if(review.actor!==actor.address)throw new Fault(403,'REVIEW_AUTHOR_REQUIRED');
 if(!await chain.read('hasRole',[keccak256(stringToHex(actor.role)),actor.address]))throw new Fault(403,'CHAIN_ROLE_REVOKED');
 const payload=JSON.parse(review.payload);
 if(input.wrongPaid!==null&&(BigInt(input.wrongPaid)>BigInt(payload.P)||BigInt(input.wrongPaid)>0n&&payload.outcome!=='wrong_payment'))throw new Fault(400,'WRONG_PAYMENT_EVIDENCE_CONFLICT');
 const digest=hash({actor:actor.address,input}),old=s.get('SELECT * FROM quality_measurements WHERE id=? OR review_id=?',input.id,input.reviewId);
 if(old){if(old.tenant!==actor.tenant)throw new Fault(404,'NOT_FOUND');if(old.payload_hash!==digest)throw new Fault(409,'IMMUTABLE_MEASUREMENT');return {id:old.id};}
 const status=(await qualityStatus(s,chain,actor.tenant)).find(r=>r.id===input.reviewId);
 if(status?.proof_state!=='canonical')throw new Fault(409,'CANONICAL_REVIEW_REQUIRED');
 return s.tx(()=>{const concurrent=s.get('SELECT * FROM quality_measurements WHERE id=? OR review_id=?',input.id,input.reviewId);if(concurrent){if(concurrent.payload_hash!==digest)throw new Fault(409,'IMMUTABLE_MEASUREMENT');return {id:concurrent.id};}s.run('INSERT INTO quality_measurements VALUES(?,?,?,?,?,?,?)',input.id,input.reviewId,actor.tenant,actor.address,json(input),digest,new Date().toISOString());s.audit(actor.address,'quality_measurement',input.id);return {id:input.id};});
}
export function metricDistribution(values:bigint[]){if(!values.length)return {observations:0,sum:null,mean:null,p95:null};const sorted=[...values].sort((a,b)=>a<b?-1:a>b?1:0),sum=values.reduce((a,b)=>a+b,0n);return {observations:values.length,sum:sum.toString(),mean:{numerator:sum.toString(),denominator:values.length},p95:sorted[Math.ceil(values.length*0.95)-1]!.toString()};}
/** Human-attested sampled metrics. Missing values stay null; this is not a population error rate. */
export async function qualityMetrics(s:Store,chain:Chain,tenant:string){
 const reviews=await qualityStatus(s,chain,tenant),latest=new Map<string,any>();let excluded=0;
 for(const r of reviews){if(r.proof_state!=='canonical'){excluded++;continue;}const key=r.incident+':'+r.payload.decisionVersion;if(!latest.has(key))latest.set(key,r);}
 const groups=new Map<string,any>();const costMeasurements:any[]=[];
 for(const r of latest.values()){
  const p=r.payload,key=json([p.channel,p.templateId]);let g=groups.get(key);
  if(!g){g={channel:p.channel,templateId:p.templateId,reviewedDecisions:0,outcomes:{},measuredDecisions:0,processing:[],human:[],costs:new Map(),money:new Map(),duplicates:[],manual:[],appeal:[]};groups.set(key,g);}
  g.reviewedDecisions++;g.outcomes[p.outcome]=(g.outcomes[p.outcome]??0)+1;
  const row=s.get('SELECT payload FROM quality_measurements WHERE review_id=?',r.id);if(!row)continue;g.measuredDecisions++;const m=JSON.parse(row.payload);costMeasurements.push({...m,channel:p.channel,templateId:p.templateId});
  if(m.processingMs!==null)g.processing.push(BigInt(m.processingMs));if(m.humanMs!==null)g.human.push(BigInt(m.humanMs));
  if(m.costMicros!==null&&!m.costBreakdown){const amounts=g.costs.get(m.costCurrency)??[];amounts.push(BigInt(m.costMicros));g.costs.set(m.costCurrency,amounts);}
  // Currency token comes from the policy, never from the reporting request.
  const i=await chain.read('getIncident',[r.incident]),policy=await chain.policy(i.policyId),token=policy.quote.token;
  let money=g.money.get(token);if(!money){money={wrongPaid:[],underpaid:[]};g.money.set(token,money);}
  for(const k of ['wrongPaid','underpaid'])if(m[k]!==null)money[k].push(BigInt(m[k]));
  if(m.duplicatePayments!==null)g.duplicates.push(BigInt(m.duplicatePayments));for(const [key,target] of [['manualOverturned','manual'],['appealOverturned','appeal']])if(m[key!]!==null)g[target!].push(m[key!]?'1':'0');
 }
 return {basis:'latest canonical independent human review per incident and decision version',populationRate:null,costBreakdown:summarizeCostBreakdowns(costMeasurements),population:await qualityPopulation(s,chain,tenant,reviews),coverage:'sampled measurements; separate population reports confirmed decision-version coverage',excludedUnverifiedReviews:excluded,groups:[...groups.values()].map(g=>({channel:g.channel,templateId:g.templateId,costBreakdown:summarizeCostBreakdowns(costMeasurements.filter(m=>m.channel===g.channel&&m.templateId===g.templateId)),reviewedDecisions:g.reviewedDecisions,measuredDecisions:g.measuredDecisions,outcomes:g.outcomes,
  processingMs:metricDistribution(g.processing),humanMs:metricDistribution(g.human),costs:[...g.costs].map(([currency,amounts]:any)=>({currency,...metricDistribution(amounts)})),money:[...g.money].map(([token,m]:any)=>({token,wrongPaid:metricDistribution(m.wrongPaid),underpaid:metricDistribution(m.underpaid)})),duplicatePayments:metricDistribution(g.duplicates),manualOverturned:metricDistribution(g.manual.map(BigInt)),appealOverturned:metricDistribution(g.appeal.map(BigInt))}))};
}
