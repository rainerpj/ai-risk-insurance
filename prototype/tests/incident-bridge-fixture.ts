import { fixture } from './incident-finance-fixture.ts';
import { IncidentCoverage } from '../packages/service/incident-coverage.ts';
import { IncidentExpense } from '../packages/service/incident-expense.ts';
import { IncidentInvestigation } from '../packages/service/incident-investigation.ts';
import { IncidentReport } from '../packages/service/incident-report.ts';
export async function bridgeSource(q:any,options:{coverage?:Record<string,unknown>;expense?:Record<string,unknown>}={}){const f=fixture();f.store.provision('reviewer','tenant',f.password,[{projectId:'project',role:'reviewer'}]);const invoice=f.add('Synthetic restore invoice'),payment=f.add('Synthetic restore payment');
 new IncidentExpense(f.store).append(f.actor,f.incident.incidentId,{projectId:'project',expenseId:'restore',expectedVersion:0,category:'restoration',currency:'USDC',scale:6,gross:'5000000',paid:'5000000',duplicate:'0',compensation:'0',recovery:'0',voucherRef:'synthetic-voucher',evidenceRefs:[{importId:invoice.importId,objectId:invoice.objectId,kind:'invoice'},{importId:payment.importId,objectId:payment.objectId,kind:'payment'}],verification:'confirmed',reason:'Synthetic explicit fee confirmation',...options.expense},'expense');
 new IncidentCoverage(f.store).put(f.actor,f.incident.incidentId,{projectId:'project',expectedVersion:0,coverage:{mode:'local_test',insurerParty:'synthetic',policyRef:q.quoteId,termsVersion:q.termsHash,currency:'USDC',scale:6,deductible:'0',share:{numerator:'1',denominator:'1'},incidentLimit:String(q.incidentLimit),annualLimit:String(q.annualLimit),exclusionsRef:null,confirmationEvidence:[],...options.coverage}},'coverage');
 const draft=(await new IncidentInvestigation(f.store).start(f.actor,f.incident.incidentId,{projectId:'project'},'draft')).report,service=new IncidentReport(f.store),report=service.publish(f.actor,f.incident.incidentId,{projectId:'project',investigationId:draft.reportId,expectedVersion:0},'report');
 const review=service.review({actorId:'reviewer',tenantId:'tenant'},report.report.reportId,{projectId:'project',expectedVersion:1,manifestDigest:report.report.evidenceManifestDigest,expectedReviewId:null,decision:'accepted',reason:'Synthetic reviewer account, not real independent human acceptance'},'review');
 return {...f,input:{projectId:'project',reportId:report.report.reportId,reviewId:review.review.reviewId,coverageVersion:1,policyId:q.quoteId,declaredIncidentAt:String(q.startAt),confirmSynthetic:true}};
}

