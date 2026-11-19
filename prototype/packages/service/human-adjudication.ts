import {hash} from './store.ts';

type Expected={state:'ready'|'manual'|'awaiting_evidence';net?:string};
export type HumanAdjudication={schema:'l2-human-adjudication-v1';corpusHash:string;reviewer:string;independenceStatement:string;decidedAt:string;cases:{id:string;expected:Expected;reason:string}[]};
/** Validates a supplied declaration; does not authenticate the reviewer or certify independence. */
export function freezeHumanAdjudication(input:unknown,corpus:unknown,caseIds:string[],startedAt:string){
 const value=structuredClone(input) as HumanAdjudication;
 if(!value||value.schema!=='l2-human-adjudication-v1'||value.corpusHash!==hash(corpus))throw Error('HUMAN_CORPUS_MISMATCH');
 if(typeof value.reviewer!=='string'||!value.reviewer.trim()||typeof value.independenceStatement!=='string'||!value.independenceStatement.trim())throw Error('HUMAN_REVIEWER_REQUIRED');
 const decided=Date.parse(value.decidedAt),started=Date.parse(startedAt);
 if(!Number.isFinite(decided)||!Number.isFinite(started)||decided>=started)throw Error('HUMAN_PREDECLARATION_REQUIRED');
 if(!Array.isArray(value.cases)||value.cases.length!==caseIds.length||new Set(value.cases.map(row=>row?.id)).size!==caseIds.length)throw Error('HUMAN_CASE_COVERAGE');
 for(const row of value.cases){
  if(!caseIds.includes(row.id)||!row.expected||!['ready','manual','awaiting_evidence'].includes(row.expected.state)||typeof row.reason!=='string'||!row.reason.trim())throw Error('HUMAN_CASE_INVALID');
  const net=row.expected.net;
  if(row.expected.state==='ready'?(typeof net!=='string'||!/^\d+$/.test(net)):(net!==undefined))throw Error('HUMAN_AMOUNT_INVALID');
 }
 return {status:'provided_unverified' as const,digest:hash(value),frozenAt:startedAt,declaration:value};
}

export function compareHumanDecision(expected:Expected,actual:{state:string;net:string|null}){
 return actual.state===expected.state&&(expected.net===undefined||actual.net===expected.net);
}
