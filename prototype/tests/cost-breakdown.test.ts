import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCostBreakdown,summarizeCostBreakdowns} from '../packages/service/cost-breakdown.ts';

const full=()=>({costCurrency:'USD',costMicros:'1000000',costBreakdown:{currency:'USD',basis:'actual',components:{human:'700000',model:'100000',chain:'100000',infrastructure:'100000',other:'0'},reference:'synthetic itemized invoice; no FX'}});
test('comprehensive costs require complete components for a total and never merge currencies or estimates',()=>{
 const a=full();validateCostBreakdown(a);
 for(const value of ['-1','0.1','01',String(2n**128n)]){const m=full();m.costBreakdown.components.model=value;assert.throws(()=>validateCostBreakdown(m),/COST_BREAKDOWN_SCHEMA/);}
 assert.throws(()=>validateCostBreakdown({...a,costMicros:'999999'}),/COST_BREAKDOWN_SCHEMA/);
 assert.throws(()=>validateCostBreakdown({...a,costCurrency:'CNY'}),/COST_BREAKDOWN_SCHEMA/);
 const partial:any=full();partial.costBreakdown.components.model=null;
 assert.throws(()=>validateCostBreakdown(partial),/COST_BREAKDOWN_SCHEMA/);partial.costMicros=null;partial.costCurrency=null;validateCostBreakdown(partial);
 const estimate=full();estimate.costBreakdown.basis='estimate';validateCostBreakdown(estimate);
 const cny=full();cny.costCurrency=cny.costBreakdown.currency='CNY';validateCostBreakdown(cny);
 const result=summarizeCostBreakdowns([a,partial,estimate,cny,{costMicros:'12'}]);
 assert.equal(result.legacyUnitemized,1);assert.equal(result.groups.length,3);
 const usd=result.groups.find(g=>g.currency==='USD'&&g.basis==='actual')!;
 assert.equal(usd.totalMicros,null);assert.equal(usd.knownCompleteTotalMicros,'1000000');assert.equal(usd.components.model.unknown,1);assert.equal(usd.components.other.sumMicros,'0');
 assert.equal(result.groups.find(g=>g.basis==='estimate')!.totalMicros,'1000000');
 assert.throws(()=>validateCostBreakdown({...a,costBreakdown:{...a.costBreakdown,reference:''}}),/COST_BREAKDOWN_SCHEMA/);
 const huge:any=full();huge.costBreakdown.components.human='9007199254740993';huge.costMicros='9007199255040993';validateCostBreakdown(huge);assert.equal(summarizeCostBreakdowns([huge]).groups[0]!.totalMicros,huge.costMicros);
});
