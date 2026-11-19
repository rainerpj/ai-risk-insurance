import {Fault} from './store.ts';

export const costComponents=['human','model','chain','infrastructure','other'] as const;
const integer=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d*)$/.test(v)&&BigInt(v)<2n**128n;
/** Optional for legacy measurements. Each component is already denominated in the declared currency; no implicit FX or double addition of model estimates. */
export function validateCostBreakdown(input:any){
 if(input.costBreakdown===undefined)return;
 const b=input.costBreakdown;
 const fail=()=>{throw new Fault(400,'COST_BREAKDOWN_SCHEMA');};
 if(!b||typeof b!=='object'||Object.keys(b).sort().join()!==['basis','components','currency','reference'].sort().join()||
  !['actual','estimate'].includes(b.basis)||typeof b.currency!=='string'||! /^[A-Z]{3}$/.test(b.currency)||
  typeof b.reference!=='string'||!b.reference.trim()||b.reference.length>4000||!b.components||
  Object.keys(b.components).sort().join()!==[...costComponents].sort().join())fail();
 if(costComponents.some(k=>b.components[k]!==null&&!integer(b.components[k])))fail();
 const complete=costComponents.every(k=>b.components[k]!==null);
 const total=costComponents.reduce((sum,k)=>sum+BigInt(b.components[k]??0),0n);
 if(complete){if(total>=2n**128n||input.costCurrency!==b.currency||input.costMicros!==total.toString())fail();}
 else if(input.costCurrency!==null||input.costMicros!==null)fail();
}

export function summarizeCostBreakdowns(measurements:any[]){
 const groups=new Map<string,any>();let legacyUnitemized=0;
 for(const m of measurements){
  if(!m.costBreakdown){legacyUnitemized++;continue;}
  const b=m.costBreakdown,key=JSON.stringify([b.currency,b.basis]);
  const g=groups.get(key)??{currency:b.currency,basis:b.basis,measurements:0,completeMeasurements:0,knownCompleteTotalMicros:0n,components:Object.fromEntries(costComponents.map(k=>[k,{known:0,unknown:0,sumMicros:0n}]))};
  g.measurements++;let complete=true;
  for(const k of costComponents){const c=g.components[k],value=b.components[k];if(value===null){c.unknown++;complete=false;}else{c.known++;c.sumMicros+=BigInt(value);}}
  if(complete){g.completeMeasurements++;g.knownCompleteTotalMicros+=BigInt(m.costMicros);}
  groups.set(key,g);
 }
 return {unit:'millionth of stated currency',scope:'human-attested sampled review measurements; not a full-population cost',legacyUnitemized,groups:[...groups.values()].map(g=>({...g,knownCompleteTotalMicros:g.completeMeasurements?g.knownCompleteTotalMicros.toString():null,
  totalMicros:g.completeMeasurements===g.measurements?g.knownCompleteTotalMicros.toString():null,
  components:Object.fromEntries(costComponents.map(k=>[k,{...g.components[k],sumMicros:g.components[k].known?g.components[k].sumMicros.toString():null}]))}))};
}
