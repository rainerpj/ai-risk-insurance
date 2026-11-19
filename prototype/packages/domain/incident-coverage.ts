import { exactObject,identifier,text,requireIncident as need,type CoverageReference } from './incident-schema.ts';
export const coverageFields=['mode','insurerParty','policyRef','termsVersion','currency','scale','deductible','share','incidentLimit','annualLimit','exclusionsRef','confirmationEvidence'];
export type CoverageInput=Omit<CoverageReference,'schemaVersion'|'tenantId'|'projectId'|'createdAt'>;
export const emptyCoverage=()=>({mode:'none' as const,insurerParty:null,policyRef:null,termsVersion:null,currency:null,scale:null,deductible:null,share:null,incidentLimit:null,annualLimit:null,exclusionsRef:null,confirmationEvidence:[] as string[]});
const amount=(v:unknown)=>v===null||(typeof v==='string'&&/^(0|[1-9]\d{0,35})$/.test(v));
export function parseCoverage(raw:unknown){
 exactObject(raw,coverageFields);need(typeof raw.mode==='string'&&['none','proposed','confirmed_external','local_test'].includes(raw.mode));
 for(const k of ['insurerParty','policyRef','termsVersion','exclusionsRef'])need(raw[k]===null||text(raw[k]));
 need(raw.currency===null||(typeof raw.currency==='string'&&/^[A-Z][A-Z0-9]{2,11}$/.test(raw.currency)));
 need(raw.scale===null||(Number.isInteger(raw.scale)&&Number(raw.scale)>=0&&Number(raw.scale)<=18));
 need((raw.currency===null)===(raw.scale===null),'CURRENCY_SCALE_REQUIRED');
 for(const k of ['deductible','incidentLimit','annualLimit'])need(amount(raw[k]));
 if(['deductible','incidentLimit','annualLimit'].some(k=>raw[k]!==null))need(raw.currency!==null,'CURRENCY_SCALE_REQUIRED');
 if(raw.share!==null){exactObject(raw.share,['numerator','denominator']);need(amount(raw.share.numerator)&&raw.share.numerator!==null&&amount(raw.share.denominator)&&raw.share.denominator!==null);need(BigInt(String(raw.share.denominator))>0n&&BigInt(String(raw.share.numerator))<=BigInt(String(raw.share.denominator)),'INVALID_SHARE');}
 need(Array.isArray(raw.confirmationEvidence)&&raw.confirmationEvidence.length<=32&&new Set(raw.confirmationEvidence).size===raw.confirmationEvidence.length&&raw.confirmationEvidence.every(r=>typeof r==='string'&&r.split('/').length===2&&r.split('/').every(identifier)),'INVALID_CONFIRMATION_REFS');
 if(raw.mode==='none')need(coverageFields.filter(k=>k!=='mode'&&k!=='confirmationEvidence').every(k=>raw[k]===null)&&raw.confirmationEvidence.length===0,'NONE_HAS_TERMS');
 if(raw.mode==='confirmed_external')need(text(raw.insurerParty)&&text(raw.policyRef)&&text(raw.termsVersion)&&raw.confirmationEvidence.length>0,'CONFIRMATION_REQUIRED',422);
 return raw as unknown as CoverageInput;
}



