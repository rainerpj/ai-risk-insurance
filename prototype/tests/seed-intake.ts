import {Store,hash,json} from '../packages/service/store.ts';
import type {Chain} from '../packages/service/chain.ts';
import type {Request} from '../packages/service/reviewer.ts';
import {intakeMessage} from '../packages/service/api.ts';

/** Synthetic rehearsal receipt, signed by the generated insured account. */
export async function seedIntake(store:Store,chain:Chain,account:any,request:Request,claimedAmount:bigint){
 const n=await chain.read('getNotice',[request.noticeId]),p=await chain.policy(request.policyId);
 const payload={noticeId:request.noticeId,policyId:request.policyId,incidentCommitment:n.data.incidentCommitment,evidenceHash:n.data.evidenceHash,declaredIncidentAt:n.data.declaredIncidentAt.toString(),summary:'synthetic rehearsal intake',claimedAmount:claimedAmount.toString()};
 const signature=await account.signMessage({message:intakeMessage(store.getMeta('scope')!,payload)});
 store.run('INSERT INTO notices VALUES(?,?,?,?,?,?,NULL,?)',request.noticeId,p.quote.enterpriseId,account.address.toLowerCase(),json({payload,signature}),hash(payload),new Date().toISOString(),'awaiting_binding');
}
