import { Fault,type Store } from './store.ts';
export type BridgeGuard=(binding:any,stage:string,payload:any)=>Promise<void>;
const guards=new WeakMap<Store,BridgeGuard>();
export function attachBridgeGuard(store:Store,guard:BridgeGuard){guards.set(store,guard);}
/** Persistent policy reservation fails closed if the incident-side verifier is not attached after restart. */
export async function assertBridge(store:Store,stage:string,payload:any){
 const policyId=payload?.policyId??payload?.d?.policyId??payload?.args?.[0]?.policyId;
 const incidentId=payload?.incidentId??payload?.d?.incidentId??payload?.args?.[0]?.incidentId??(typeof payload?.args?.[0]==='string'?payload.args[0]:undefined);
 const locks=store.all("SELECT value FROM meta WHERE key LIKE 'incident-bridge:%'").map(r=>JSON.parse(r.value));
 const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();const binding=locks.find(b=>same(policyId,b.policyId)||same(incidentId,b.chainIncidentId)||same(payload?.noticeId??payload?.args?.[0]?.noticeId,b.noticeId));
 if(!binding)return;
 if(stage==='action'&&payload.action==='setIncidentFreeze'&&payload.args[0]===binding.chainIncidentId&&payload.args[1]===true)return;
 const guard=guards.get(store);if(!guard)throw new Fault(409,'BRIDGE_VERIFIER_UNAVAILABLE');await guard(binding,stage,payload);
}

