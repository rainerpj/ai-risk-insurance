import {encodeAbiParameters,keccak256} from 'viem';
import {Chain} from './chain.ts';
import {Originals,H,route,requestNoticeIds,type Request} from './reviewer.ts';
import {AgentEvidenceTools,verifyAgentItems,parseAgentProposal,ticketValidatorVersion,type AgentProposal} from './agent.ts';
import {zeroHash} from '../domain/typed-data.ts';
import {json} from './store.ts';
const integer=(v:any)=>{if(typeof v!=='string'||!/^(0|[1-9]\d*)$/.test(v)||BigInt(v)>=2n**128n)throw Error('INVALID_AMOUNT');return BigInt(v);};
export const semanticScope=(o:Originals)=>H({templateId:o.trust.templateId,runbooks:o.trust.runbooks,sources:o.trust.sources,runtimeDeployment:o.trust.runtimeDeployment,semantic:o.trust.semantic,ticketValidatorVersion});
/** Run independently in reviewer and authorizer. The model's route and totals have no authority. */
export async function reviewSemantic(chain:Chain,originals:Originals,request:Request,grant:any,proposal:AgentProposal){
 if(!request||Object.keys(request).sort().join()!==(request.previousEvidence?'expiresAt,grantId,noticeId,policyId,previousEvidence,refs':'expiresAt,grantId,noticeId,policyId,refs')||![request.policyId,request.noticeId,request.grantId].every(v=>/^0x[a-f0-9]{64}$/.test(v))||!Array.isArray(request.refs)||request.refs.length!==11||new Set(request.refs).size!==11)throw Error('SEMANTIC_REQUEST_SCHEMA');
 if(!originals.trust.semantic||Number(grant.channel)!==2)throw Error('SEMANTIC_PROFILE_REQUIRED');
 if(!proposal)throw Error('SEMANTIC_PROPOSAL_REQUIRED');
 const suggestion=parseAgentProposal(JSON.stringify(proposal));await chain.check();const head=await chain.client.getBlock(),p=await chain.read('getPolicy',[request.policyId],head.number),q=p.quote;
 if(!p.issuedAt)throw Error('POLICY_NOT_FOUND');const n=await chain.read('getNotice',[request.noticeId],head.number);
 if(n.digest===zeroHash||n.data.policyId!==request.policyId||H(request.refs)!==n.data.evidenceHash)throw Error('NOTICE_EVIDENCE_BINDING');
 if(request.previousEvidence){
  const previous=request.previousEvidence;
  if(Object.keys(previous).sort().join()!=='noticeId,refs'||!/^0x[a-f0-9]{64}$/.test(previous.noticeId)||previous.noticeId===request.noticeId||!Array.isArray(previous.refs)||previous.refs.length>11||new Set(previous.refs).size!==previous.refs.length||previous.refs.some(r=>!/^[a-f0-9]{64}$/.test(r)))throw Error('SUPPLEMENT_HISTORY_SCHEMA');
  const old=await chain.read('getNotice',[previous.noticeId],head.number);
  if(old.digest===zeroHash||old.data.policyId!==request.policyId||old.data.incidentCommitment!==n.data.incidentCommitment||old.data.declaredIncidentAt!==n.data.declaredIncidentAt||old.data.evidenceHash!==H(previous.refs)||old.incidentId!==zeroHash)throw Error('SUPPLEMENT_HISTORY_BINDING');
  for(const ref of previous.refs.filter(ref=>!request.refs.includes(ref))){
   // An existing original, even an invalid one, must not be silently discarded to obtain approval.
   try{originals.read(ref);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw Error('SUPPLEMENT_OLD_ORIGINAL_INVALID');}
   throw Error('SUPPLEMENT_REPLACED_AVAILABLE_ORIGINAL');
  }
 }
 const tools=new AgentEvidenceTools(originals,{enterpriseId:q.enterpriseId,policyId:request.policyId,deploymentId:chain.deploymentId,runtimeDeployment:originals.trust.runtimeDeployment,commitment:n.data.incidentCommitment,workflowHash:q.workflowHash},request.refs);
 const docs=request.refs.map(ref=>({ref,body:tools.read(ref)})),of=(kind:string)=>docs.filter(d=>d.body.kind===kind);
 for(const [kind,count] of [['release',1],['monitor',1],['replay',1],['ticket',2],['work',2],['completion',2],['payment',2]] as const)if(of(kind).length!==count)throw Error('MISSING_INDEPENDENT_EVIDENCE');
 const release=of('release')[0]!,monitor=of('monitor')[0]!,replay=of('replay')[0]!,now=head.timestamp as bigint,occurred=integer(release.body.occurredAt),reasons:string[]=[];
 if(occurred!==n.data.declaredIncidentAt||occurred<q.startAt||occurred>=q.endAt||occurred>now)reasons.push('OUTSIDE_COVERAGE');
 if(!release.body.revision||release.body.revision!==monitor.body.revision||release.body.revision!==replay.body.revision||monitor.body.failure!==true||replay.body.oldPass!==true||replay.body.newPass!==false||replay.body.rollbackPass!==true)reasons.push('CAUSALITY_OR_CONFLICT');
 const checked=verifyAgentItems(tools,suggestion,q.beneficiary,q.token),categories=new Set<number>(),amounts:any[]=[],expenseKeys:string[]=[];
 const used=suggestion.items.flatMap(i=>[i.ticketRef,i.workRef,i.completionRef,i.paymentRef]);if(new Set(used).size!==8||docs.filter(d=>!['release','monitor','replay'].includes(d.body.kind)).some(d=>!used.includes(d.ref)))throw Error('UNACCOUNTED_OR_DUPLICATE_EVIDENCE');
 for(let index=0;index<suggestion.items.length;index++){
  const item=suggestion.items[index]!,work=tools.read(item.workRef),payment=tools.read(item.paymentRef),limit=originals.trust.semantic[work.runbook+':'+work.action];
  if(!limit||![0,1].includes(limit.category)||categories.has(limit.category)||integer(work.units)===0n||integer(work.units)>integer(limit.maxUnits))throw Error('CATEGORY_OR_QUANTITY_LIMIT');
  categories.add(limit.category);amounts[limit.category]=checked.amounts[index];
  const scope={insurer:q.insurerId,token:q.token,enterprise:q.enterpriseId};
  expenseKeys.push(H({...scope,expense:work.expenseId}),H({...scope,invoice:work.invoiceId}),H({...scope,payment:payment.reference}));
 }
 if(categories.size!==2)throw Error('TWO_CATEGORIES_REQUIRED');
 const incidentId=H({deployment:chain.deploymentId,policy:request.policyId,commitment:n.data.incidentCommitment}),i=await chain.read('getIncident',[incidentId],head.number),net=checked.net,gross=amounts.reduce((s,a)=>s+a.gross,0n);
 if(i.version!==0n||i.manualHold||i.activeDispute!==zeroHash||n.incidentId!==zeroHash)reasons.push('EXISTING_OR_MANUAL_INCIDENT');
 for(const actor of [grant.reviewer,grant.authorizer])if([q.insured,p.fde].some(address=>address.toLowerCase()===actor.toLowerCase()))reasons.push('SELF_REVIEW');
 if(net===0n||net>q.incidentLimit||p.paidTotal+p.dueTotal+net>q.annualLimit)reasons.push('ZERO_OR_CAP_CLIPPING');
 for(const k of ['templateId','ruleVersion','modelVersion'] as const)if(grant[k]!==originals.trust[k])reasons.push('PROFILE_VERSION_MISMATCH');
 if(grant.scopeHash!==semanticScope(originals))reasons.push('PROFILE_SCOPE_MISMATCH');
 const baseRouting=route(gross,i.P,i.D,net,reasons),routing=baseRouting.channel==='L1'?{...baseRouting,channel:'L2'}:baseRouting; // Unstructured evidence may use L2 below the L1 ceiling.
 if(routing.channel!=='L2')throw Error('MANUAL_REQUIRED:'+json(routing));
 const expiresAt=integer(request.expiresAt);if(expiresAt<=now||expiresAt>now+3600n||expiresAt>grant.validUntil)throw Error('SIGNATURE_LIFETIME');
 const decisionId=H({request,proposal:suggestion,incidentId,version:'1'}),reservationId=H({decisionId,purpose:'obligation'});
 const d={decisionId,policyId:request.policyId,incidentId,noticeSetHash:keccak256(encodeAbiParameters([{type:'bytes32[]'}],[requestNoticeIds(request)])),version:1n,previousVersion:0n,expectedLedgerHash:await chain.read('ledgerHash',[request.policyId,incidentId],head.number),assessmentHash:zeroHash,
  amountsHash:keccak256(encodeAbiParameters([{type:'tuple[2]',components:['gross','duplicate','compensation','recovery'].map(name=>({name,type:'uint256'}))}],[amounts as [any,any]])),netApproved:net,beneficiary:q.beneficiary,reasonHash:H({request,proposal:suggestion,rule:originals.trust.ruleVersion}),reviewAmount:routing.reviewAmount,channel:2n,grantId:request.grantId,grantEpoch:BigInt(grant.epoch),budgetVersion:BigInt(grant.budgetVersion),reservationId,approver:grant.authorizer,signerEpoch:await chain.read('epochs',[grant.authorizer],head.number),expiresAt};
 if((await chain.block(head.number)).hash!==head.hash)throw Error('CHAIN_CHANGED');
 return {d,amounts,q,expenseKey:expenseKeys,report:{request,proposal:suggestion,incidentId,net:net.toString(),routing,rule:originals.trust.ruleVersion,sourceChecks:[{factId:'coverage',validatorId:'policy-notice-time',validatorVersion:'1',status:'passed',refs:[release.ref]},{factId:'causality',validatorId:'release-monitor-replay',validatorVersion:'1',status:'passed',refs:[release.ref,monitor.ref,replay.ref]},...checked.facts]}};
}
