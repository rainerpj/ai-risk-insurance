const assert=require('node:assert/strict');
const D=require('./engine.js');let tests=0;function test(name,fn){fn();tests++;console.log('PASS '+name);}
test('退款案例实损/定额/组合与原演算一致',()=>{const r=D.calculate(D.initial('support'));assert.deepEqual(r.claims.map(x=>x.total),[21000,13000,21000]);assert.deepEqual(r.claims.map(x=>x.retained),[12000,20000,12000]);});
test('小损失低于门槛无定额赔款',()=>{const s=D.initial('support');s.gross=5000;s.recovery=0;assert.equal(D.calculate(s).claims[1].economic,0);});
test('门槛边界触发且无重复叠加',()=>{const s=D.initial('support');s.gross=10000;s.recovery=0;const r=D.calculate(s);assert.equal(r.claims[1].economic,10000);assert.equal(r.claims[2].economic,10000);});
test('各模块年度余额分别限制赔款',()=>{const s=D.initial('drama');s.remaining=500;s.responseRemaining=100;s.legalOn=true;s.legalRemaining=200;assert.equal(D.calculate(s).claims[2].total,800);});
test('晚到追回款产生应返还差额',()=>{const s=D.initial('support');s.recovery=35000;s.paid=21000;const r=D.calculate(s);assert.equal(r.claims[0].settlement,-13500);assert.equal(r.claims[2].settlement,-8000);});
test('证据缺失阻止可支付状态',()=>{const s=D.initial('support');s.evidence=false;assert.equal(D.calculate(s).eligible,false);s.evidence=true;s.excluded=true;assert.equal(D.calculate(s).eligible,false);});
test('未选法律费用不赔，开启后独立受限',()=>{const s=D.initial('drama');assert.equal(D.calculate(s).claims[0].legalPay,0);s.legalOn=true;s.legalCap=5000;assert.equal(D.calculate(s).claims[0].legalPay,5000);});
test('事故金额及历史赔款不影响报价',()=>{const s=D.initial('support'),before=D.calculate(s).quote;s.gross=800000;s.paid=100000;s.remaining=100;assert.deepEqual(D.calculate(s).quote,before);});
test('不合法概率与费用加载拒绝计算',()=>{const s=D.initial('support');s.loading=100;assert.ok(D.calculate(s).errors.length);s.loading=35;s.weights=[50,50,50];assert.ok(D.calculate(s).errors.length);s.weights=[60,30,10];s.volume=200000;assert.ok(D.calculate(s).errors.length);});
test('无事故风险仍含固定成本且无虚构赔款',()=>{const s=D.initial('support');s.frequency=0;const r=D.calculate(s);assert.equal(r.quote[0].expected,0);assert.equal(r.quote[0].premium,s.expense/.65);});
test('定额独立年限额限制组合底额',()=>{const s=D.initial('support');s.gross=10000;s.recovery=0;s.fixedRemaining=500;assert.equal(D.calculate(s).claims[2].economic,500);});
test('非有限金额、负额、过度追回拒绝计算',()=>{for(const value of [-1,Infinity,NaN]){const s=D.initial('support');s.gross=value;assert.ok(D.calculate(s).errors.length);}const s=D.initial('support');s.recovery=60000;assert.ok(D.calculate(s).errors.length);});
console.log(`${tests} tests passed`);
