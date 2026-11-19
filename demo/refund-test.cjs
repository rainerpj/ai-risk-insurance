'use strict';
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const E=require('./refund-engine.js');
let count=0;async function test(name,fn){await fn();console.log('PASS '+name);count++;}
(async()=>{
 await test('未执行不能封存或报案，未核定不能付款',async()=>{const s=E.initial();await assert.rejects(()=>E.seal(s));assert.throws(()=>E.report(s));assert.throws(()=>E.pay(s));});
 const s=E.initial();E.run(s);
 await test('200笔任务包含1000个五阶段快照且运行幂等',()=>{assert.equal(s.events.length,1000);E.run(s);assert.equal(s.events.length,1000);assert.equal(new Set(s.events.map(e=>e.event_id)).size,1000);assert.equal(s.events.filter(e=>e.stage===4).reduce((n,e)=>n+e.payload.second_refund_usd,0),50000);});
 await E.seal(s);
 await test('SHA256与独立Node加密实现一致',async()=>{const first=s.events[0],nonce=s.sealed.nonces[0];const independent=createHash('sha256').update('FDE-EVIDENCE-v1').update(Buffer.from(nonce,'hex')).update(E.canonical(first)).digest('hex');assert.equal(independent,s.sealed.commitments[0]);});
 await test('全部原件及包含证明通过，不生成自动理赔决定',async()=>{const v=await E.verify(s);assert.equal(v.integrity,'passed');assert.equal(v.inclusion,true);assert.equal(s.decision,null);assert.equal(v.signature,'not_implemented');});
 await test('奇数叶与单叶使用独立递归参考根，错误路径拒绝',async()=>{const h=x=>createHash('sha256').update(x).digest();const data=['a','b','c','d','e'].map(x=>h(Buffer.concat([Buffer.from([0]),Buffer.from(x)])));function reference(a){if(a.length===1)return a[0];let k=1;while(k*2<a.length)k*=2;return h(Buffer.concat([Buffer.from([1]),reference(a.slice(0,k)),reference(a.slice(k))]));}for(const n of [1,3,5]){const leaves=data.slice(0,n).map(b=>b.toString('hex')),root=await E.tree(leaves);assert.equal(root,reference(data.slice(0,n)).toString('hex'));for(let i=0;i<n;i++)assert.equal(await E.verifyPath(leaves[i],await E.proof(leaves,i),root),true);}const p=await E.proof(data.map(b=>b.toString('hex')),0);p[0].hash='00'.repeat(32);assert.equal(await E.verifyPath(data[0].toString('hex'),p,reference(data).toString('hex')),false);});
 await test('链离线排队仍能独立报案，恢复保持原根',()=>{s.offline=true;E.anchor(s);assert.equal(s.anchor.status,'queued');const root=s.anchor.root;E.report(s);assert.equal(s.incident.id,'DEMO-CLAIM-001');s.offline=false;E.anchor(s);assert.equal(s.anchor.status,'confirmed');assert.equal(s.anchor.root,root);});
 await test('篡改原件真实检测，包含证明不代替源真实性',async()=>{E.corrupt(s,'tamper');const v=await E.verify(s);assert.equal(v.failed,1);assert.equal(v.integrity,'failed');assert.equal(v.inclusion,true);});
 await test('原件缺失为未知，不可用链摘要恢复',async()=>{E.corrupt(s,'missing');const v=await E.verify(s);assert.equal(v.missing,1);assert.equal(v.integrity,'unknown');});
 await test('替代证据人工复核不篡改技术核验结果',()=>{E.assess(s);assert.equal(s.verification.integrity,'unknown');assert.equal(s.decision,null);E.decide(s);assert.equal(s.decision.total,21000);});
 await test('首次赔款21000，客户自留12000，重复入账无效',()=>{E.pay(s);E.pay(s);assert.equal(s.payments.length,1);assert.equal(E.amounts(s).paid,21000);assert.equal(E.amounts(s).retained,12000);assert.equal(E.amounts(s).due,0);});
 await test('首次付款后不可追溯换方案',()=>assert.throws(()=>E.setPlan(s,'hybrid')));
 await test('新增追回重开，旧决定不能付款，原流水保留',()=>{E.recover(s);E.recover(s);assert.equal(s.recoveries.length,1);assert.equal(s.decision,null);assert.throws(()=>E.pay(s));assert.equal(s.payments[0].amount,21000);assert.equal(s.decisions[0].total,21000);E.assess(s);E.decide(s);assert.equal(E.amounts(s).due,-13500);E.pay(s);assert.equal(E.amounts(s).paid,7500);assert.equal(s.decisions.length,2);});
 await test('组合追回调整8000，定额版本保持13000',()=>{for(const [plan,expected] of [['hybrid',-8000],['fixed',0]]){const x=E.initial();E.run(x);E.setPlan(x,plan);E.report(x);E.assess(x);E.decide(x);E.pay(x);E.recover(x);E.assess(x);E.decide(x);assert.equal(E.amounts(x).due,expected);}});
 await test('JSON导出往返后仍能核验，丢失原件不会伪通过',async()=>{const restored=JSON.parse(JSON.stringify(s));assert.equal((await E.verify(restored)).integrity,'unknown');assert.equal(restored.payments.length,2);});
 console.log(`${count} refund journey tests passed`);
})().catch(e=>{console.error(e);process.exitCode=1;});
