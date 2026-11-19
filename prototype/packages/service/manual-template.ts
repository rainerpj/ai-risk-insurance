import {keccak256,stringToHex} from 'viem';
import {Store,json} from './store.ts';
const valid=(id:unknown):id is string=>typeof id==='string'&&/^0x[a-f0-9]{64}$/.test(id)&&id!=='0x'+'0'.repeat(64);
export function manualReason(reason:string,templateId:unknown){
 if(templateId===undefined||templateId===null)return reason;
 if(!valid(templateId))throw Error('MANUAL_TEMPLATE_ID_INVALID');
 return json({schema:'manual-template-v1',templateId,reason});
}
/** This classification is signed through reasonHash; it never grants automatic permission. */
export function manualTemplate(s:Store,tenant:string,decision:any):string|null{
 if(Number(decision.channel)!==0)return null;
 const row=s.get('SELECT payload FROM drafts WHERE id=? AND tenant=?',decision.decisionId,tenant);if(!row)return null;
 try{
  const {reason}=JSON.parse(row.payload);if(typeof reason!=='string'||keccak256(stringToHex(reason))!==decision.reasonHash)return null;
  const value=JSON.parse(reason);
  if(Object.keys(value).sort().join()!=='reason,schema,templateId'||value.schema!=='manual-template-v1'||!valid(value.templateId)||typeof value.reason!=='string')return null;
  return value.templateId;
 }catch{return null;}
}
