import { exactObject,identifier,text,requireIncident as need } from './incident-schema.ts';
export const scenarioKinds=['human','ai_uninsured','ai_assured'] as const;
export const requiredCosts={human:['human','uninsured','other','transition'],ai_uninsured:['fde','ai','supervision','uninsured','other','transition'],ai_assured:['fde','ai','assurance','supervision','uninsured','other','transition']};
export type Line={id:string;category:string;payer:string;amount:string|null;basis:'actual'|'estimated';sourceRefs:string[];sourceNote:string;includedIn:string|null;amortizationPeriods:number;allocationPeriod:number;fixed:boolean;contractConfirmed:boolean};
export type Scenario={kind:typeof scenarioKinds[number];qualityDefinition:string;qualifiedOutputs:string|null;lines:Line[]};
export type Group={currency:string;scale:number;scenarios:Scenario[];platform:{customers:string|null;revenues:Line[];costs:Line[]}};
export type RoiInput={groups:Group[]};
const count=(v:unknown)=>v===null||(typeof v==='string'&&/^(0|[1-9]\d{0,35})$/.test(v));
function lines(raw:unknown,categories:string[],mode:'enterprise'|'revenue'|'platform'){
 need(Array.isArray(raw)&&raw.length<=80);const ids=new Set();
 for(const row of raw){exactObject(row,['id','category','payer','amount','basis','sourceRefs','sourceNote','includedIn','amortizationPeriods','allocationPeriod','fixed','contractConfirmed']);
 need(identifier(row.id)&&!ids.has(row.id),'DUPLICATE_LINE');ids.add(row.id);need(typeof row.category==='string'&&categories.includes(row.category)&&text(row.payer)&&count(row.amount),'INVALID_COST');
 need((row.basis==='actual'||row.basis==='estimated')&&text(row.sourceNote)&&typeof row.fixed==='boolean'&&typeof row.contractConfirmed==='boolean');
 need(Array.isArray(row.sourceRefs)&&row.sourceRefs.length<=20&&row.sourceRefs.every(r=>typeof r==='string'&&r.split('/').length===2&&r.split('/').every(identifier))&&new Set(row.sourceRefs).size===row.sourceRefs.length,'INVALID_SOURCE_REFS');
 need(row.basis!=='actual'||row.amount===null||row.sourceRefs.length>0,'ACTUAL_SOURCE_REQUIRED',422);
 need(Number.isSafeInteger(row.amortizationPeriods)&&Number(row.amortizationPeriods)>=1&&Number(row.amortizationPeriods)<=1200,'INVALID_AMORTIZATION');
 need(['transition','acquisition'].includes(row.category)||row.amortizationPeriods===1,'INVALID_AMORTIZATION');need(Number.isSafeInteger(row.allocationPeriod)&&Number(row.allocationPeriod)>=1&&Number(row.allocationPeriod)<=Number(row.amortizationPeriods),'INVALID_ALLOCATION_PERIOD');
 need(row.includedIn===null||identifier(row.includedIn));need(mode==='enterprise'||row.includedIn===null,'INVALID_INCLUSION');
 if(mode==='enterprise')need(row.fixed===false&&row.contractConfirmed===false,'INVALID_ENTERPRISE_FLAGS');
 if(mode!=='revenue')need(row.contractConfirmed===false,'INVALID_CONTRACT_FLAG');
 if(mode==='revenue')need(row.fixed===false,'INVALID_REVENUE_FLAGS');
 }
 const result=raw as Line[];
 for(const row of result)if(row.includedIn!==null){const parent=result.find(r=>r.id===row.includedIn);need(parent&&parent.id!==row.id&&parent.category==='fde'&&parent.includedIn===null&&row.category!=='transition'&&row.category!=='fde','INVALID_INCLUSION');}
 return result;
}
export function parseRoi(raw:unknown):RoiInput{
 exactObject(raw,['groups']);need(Array.isArray(raw.groups)&&raw.groups.length>0&&raw.groups.length<=8);const currencies=new Set();
 for(const group of raw.groups){exactObject(group,['currency','scale','scenarios','platform']);need(typeof group.currency==='string'&&/^[A-Z][A-Z0-9]{2,11}$/.test(group.currency)&&!currencies.has(group.currency),'INVALID_CURRENCY');currencies.add(group.currency);need(Number.isInteger(group.scale)&&Number(group.scale)>=0&&Number(group.scale)<=18);
 need(Array.isArray(group.scenarios)&&group.scenarios.length===3);const kinds=new Set();for(const scenario of group.scenarios){exactObject(scenario,['kind','qualityDefinition','qualifiedOutputs','lines']);need(typeof scenario.kind==='string'&&scenarioKinds.includes(scenario.kind as any)&&!kinds.has(scenario.kind),'INVALID_SCENARIOS');kinds.add(scenario.kind);need(text(scenario.qualityDefinition)&&count(scenario.qualifiedOutputs));lines(scenario.lines,requiredCosts[scenario.kind as Scenario['kind']],'enterprise');}
 exactObject(group.platform,['customers','revenues','costs']);need(count(group.platform.customers));lines(group.platform.revenues,['onboarding','service','technical','premium'],'revenue');lines(group.platform.costs,['acquisition','delivery','support','operations'],'platform');
 }
 return raw as unknown as RoiInput;
}
type Fraction={n:bigint;d:bigint};
const gcd=(a:bigint,b:bigint):bigint=>b===0n?(a<0n?-a:a):gcd(b,a%b);
const fraction=(n:bigint,d=1n):Fraction=>{const g=gcd(n,d);return {n:n/g,d:d/g};};
const add=(a:Fraction,b:Fraction)=>fraction(a.n*b.d+b.n*a.d,a.d*b.d);
const sub=(a:Fraction,b:Fraction)=>add(a,{n:-b.n,d:b.d});
const divide=(a:Fraction,b:Fraction)=>b.n===0n?null:fraction(a.n*b.d,a.d*b.n);
const wire=(v:Fraction|null)=>v===null?null:{numerator:v.n.toString(),denominator:v.d.toString()};
function total(rows:Line[],required:string[]=[]){const missing=required.filter(k=>!rows.some(r=>r.category===k));const counted=rows.filter(r=>r.includedIn===null);const unknown=counted.filter(r=>r.amount===null).map(r=>r.id);const duplicateRefs=new Set<string>(),seen=new Set<string>();for(const r of counted)for(const ref of new Set(r.sourceRefs)){if(seen.has(ref))duplicateRefs.add(ref);seen.add(ref);}const complete=missing.length===0&&unknown.length===0&&duplicateRefs.size===0;return {period:complete?counted.reduce((a,r)=>add(a,fraction(BigInt(r.amount!),BigInt(r.amortizationPeriods))),fraction(0n)):null,cash:complete?counted.reduce((a,r)=>a+(r.allocationPeriod===1?BigInt(r.amount!):0n),0n).toString():null,missing,unknown,duplicateRefs:[...duplicateRefs],excluded:rows.filter(r=>r.includedIn!==null).map(r=>r.id)};}
export function calculateRoi(input:RoiInput){return {modelVersion:'partner-roi-v1',groups:input.groups.map(group=>{
 const baseline=group.scenarios.find(s=>s.kind==='human')!,base=total(baseline.lines,requiredCosts.human);
 const scenarios=group.scenarios.map(s=>{const t=total(s.lines,requiredCosts[s.kind]),comparable=s.qualityDefinition===baseline.qualityDefinition&&s.qualifiedOutputs!==null&&s.qualifiedOutputs!=='0'&&s.qualifiedOutputs===baseline.qualifiedOutputs;const net=comparable&&base.period&&t.period?sub(base.period,t.period):null;return {kind:s.kind,comparable,periodCost:wire(t.period),cashCost:t.cash,unitCost:wire(t.period&&s.qualifiedOutputs!==null&&s.qualifiedOutputs!=='0'?divide(t.period,fraction(BigInt(s.qualifiedOutputs))):null),netSavings:wire(net),roi:wire(s.kind!=='human'&&net&&t.period?divide(net,t.period):null),savingsRate:wire(net&&base.period?divide(net,base.period):null),missing:t.missing,unknown:t.unknown,duplicateRefs:t.duplicateRefs,excluded:t.excluded,basis:s.lines.every(r=>r.basis==='actual')?'actual':s.lines.every(r=>r.basis==='estimated')?'estimated':'mixed'};});
 const p=group.platform,eligible=p.revenues.filter(r=>r.category!=='premium'&&r.contractConfirmed),proposed=p.revenues.filter(r=>r.category!=='premium'&&!r.contractConfirmed),premium=total(p.revenues.filter(r=>r.category==='premium'),['premium']);
 const revenue=total(eligible),cost=total(p.costs,['acquisition','delivery','support','operations']),variable=total(p.costs.filter(r=>!r.fixed)),fixed=total(p.costs.filter(r=>r.fixed));
 const missingRevenue=['onboarding','service','technical'].filter(k=>!p.revenues.some(r=>r.category===k));const ready=missingRevenue.length===0&&proposed.length===0&&revenue.period!==null&&cost.period!==null;
 const contribution=ready&&variable.period?sub(revenue.period!,variable.period):null,profit=ready?sub(revenue.period!,cost.period!):null;const unit=contribution&&p.customers!==null&&p.customers!=='0'?divide(contribution,fraction(BigInt(p.customers))):null;
 const breakEven=unit&&unit.n>0n&&fixed.period?divide(fixed.period,unit):null;
 return {currency:group.currency,scale:group.scale,scenarios,platform:{eligibleTechnicalRevenue:wire(revenue.period),proposedTechnicalRevenue:wire(total(proposed).period),insurerPremium:wire(premium.period),periodCost:wire(cost.period),cashCost:cost.cash,contribution:wire(contribution),operatingResult:wire(profit),contributionPerCustomer:wire(unit),breakEvenCustomers:breakEven?((breakEven.n+breakEven.d-1n)/breakEven.d).toString():null,missingRevenue,unconfirmedContracts:proposed.map(r=>r.id),missingCosts:cost.missing,unknownCosts:cost.unknown,duplicateRefs:[...revenue.duplicateRefs,...cost.duplicateRefs],basis:[...p.revenues,...p.costs].every(r=>r.basis==='actual')?'actual':[...p.revenues,...p.costs].every(r=>r.basis==='estimated')?'estimated':'mixed',premiumIncludedInPlatformRevenue:false}};
 }),limitations:['All comparisons use one declared month and identical quality/output declarations; declarations are not independently verified.','Minor-unit amounts and exact fractions; cash transition cost and monthly allocation are separate views, never added together.','Premium belongs to insurer; contract confirmation is an administrative declaration, not proof of collected revenue.','No FX conversion, no guaranteed claim recovery, no conversion of the legacy self-underwriting model.']};}


