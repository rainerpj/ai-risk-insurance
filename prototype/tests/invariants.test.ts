import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, U, H, id } from './chain-helper.ts';
type Model = { policy: number; incidentId: ReturnType<typeof id>; noticeId: ReturnType<typeof id>; P: bigint; R: bigint; N: bigint; D: bigint; Q: bigint; version: bigint };
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;
test('seeded stateful EVM ledger invariants: two policies/tokens and four incidents', async t => {
  const c = await setup(); const outcomes: unknown[] = []; let snapshot = await c.connection.provider.request({ method: 'evm_snapshot' });
  try {
    for (const seed of [173n, 20261023n, 987654321n]) await t.test(`seed ${seed}, 80 operations`, async () => {
      await c.connection.provider.request({ method: 'evm_revert', params: [snapshot] }); snapshot = await c.connection.provider.request({ method: 'evm_snapshot' });
      let random = seed;
      const next = () => { random = (random * 1664525n + 1013904223n) & 0xffffffffn; return random; };
      const quotes = [await c.issue(), await c.issue({ pool: c.vault2.address, token: c.usdt.address })];
      const tokens = [c.usdc, c.usdt], vaults = [c.vault, c.vault2];
      const models: Model[] = [];
      for (let p = 0; p < 2; p++) {
        await c.send(tokens[p]!, 'approve', [vaults[p]!.address, 2n ** 255n], 'insured');
        for (let k = 0; k < 2; k++) {
          const notice = await c.notice(quotes[p]!);
          models.push({ policy: p, incidentId: id(), noticeId: notice.n.noticeId, P: 0n, R: 0n, N: 0n, D: 0n, Q: 0n, version: 0n });
        }
      }
      const donated = [0n, 0n], withdrawn = [0n, 0n];
      const trace: unknown[] = [];
      async function assertAll(step: number) {
        for (const model of models) {
          const actual = await c.read(c.core, 'getIncident', [model.incidentId]);
          for (const field of ['P', 'R', 'N', 'D', 'Q'] as const) assert.equal(actual[field], model[field], `seed=${seed} step=${step} ${field}`);
          assert(model.R <= model.P); assert.equal(model.D * model.Q, 0n);
          assert.equal(model.D, max(0n, model.N - model.P + model.R)); assert.equal(model.Q, max(0n, model.P - model.R - model.N));
        }
        for (let p = 0; p < 2; p++) {
          const group = models.filter(m => m.policy === p);
          const paid = group.reduce((s,m) => s + m.P, 0n), returns = group.reduce((s,m) => s + m.R, 0n), due = group.reduce((s,m) => s + m.D, 0n);
          const policy = await c.read(c.core, 'getPolicy', [quotes[p]!.quoteId]);
          const [A, unexpected, W] = await c.read(vaults[p]!, 'balances') as [bigint, bigint, bigint];
          const Hactual = await c.read(vaults[p]!, 'H'), K = await c.read(vaults[p]!, 'K');
          assert.equal(policy.paidTotal, paid); assert.equal(policy.dueTotal, due); assert(paid + due <= quotes[p]!.annualLimit);
          assert.equal(A, 160000n * U + returns - paid + donated[p]! - withdrawn[p]!);
          assert.equal(Hactual, 10000n * U + returns); assert.equal(K, quotes[p]!.annualLimit - paid);
          assert.equal(unexpected, donated[p]); assert.equal(W, 140000n * U - quotes[p]!.annualLimit - withdrawn[p]!);
          assert(A >= Hactual + K + 10000n * U + unexpected);
        }
      }
      for (let step = 0; step < 80; step++) {
        // Use upper PRNG bits: low bits of an LCG have short cycles.
        const model = models[Number((next() >> 16n) % 4n)]!, p = model.policy, q = quotes[p]!;
        let action = Number((next() >> 16n) % 5n);
        if (model.version === 0n || (action === 1 && model.D === 0n) || (action === 2 && model.Q === 0n)) action = 0;
        c.label(`invariant seed=${seed} step=${step} action=${action}`);
        const beforeP = model.P, beforeR = model.R;
        if (action === 0) {
          const loss = (next() % 170001n) * U;
          const peers = models.filter(m => m.policy === p && m !== model);
          const allPaid = models.filter(m => m.policy === p).reduce((s,m) => s + m.P, 0n);
          const otherDue = peers.reduce((s,m) => s + m.D, 0n);
          const available = min(q.incidentLimit - model.P, q.annualLimit - allPaid - otherDue);
          const approved = min(loss, model.P - model.R + available);
          if (model.version > 0n) await c.send(c.core, 'setIncidentFreeze', [model.incidentId, true, H('random revision')]);
          const d = await c.decision(q, [model.noticeId], model.incidentId, loss, { netApproved: approved, reviewAmount: max(loss, model.P + model.D) });
          await c.send(c.core, 'registerDecision', d.args);
          if (model.version > 0n) await c.send(c.core, 'setIncidentFreeze', [model.incidentId, false, H('reconciled')]);
          model.version++; model.N = approved; model.D = max(0n, approved - model.P + model.R); model.Q = max(0n, model.P - model.R - approved);
          trace.push({ step, action: 'revise', loss, approved });
        } else if (action === 1) {
          const amount = 1n + next() % model.D; const payment = await c.payment(q, model.incidentId, amount);
          await c.send(c.core, 'executePayment', [payment.p, payment.sig], 'executor'); model.P += amount; model.D -= amount;
          if (step % 11 === 0) await c.rejects(c.core, 'executePayment', [payment.p, payment.sig], 'executor');
          trace.push({ step, action: 'pay', amount });
        } else if (action === 2) {
          const amount = 1n + next() % model.Q; const returnId = id();
          await c.send(c.core, 'returnRecovery', [model.incidentId, amount, returnId], 'insured'); model.R += amount; model.Q -= amount;
          if (step % 13 === 0) await c.rejects(c.core, 'returnRecovery', [model.incidentId, amount, returnId], 'insured');
          trace.push({ step, action: 'return', amount });
        } else if (action === 3) {
          const amount = 1n + next() % U; await c.send(tokens[p]!, 'mint', [vaults[p]!.address, amount]); donated[p] = donated[p]! + amount;
          trace.push({ step, action: 'unsolicited', amount });
        } else {
          const W = 140000n * U - q.annualLimit - withdrawn[p]!;
          if (W > 0n) { const amount = min(W, 1n + next() % U); await c.send(c.core, 'withdrawCapital', [vaults[p]!.address, amount], 'treasurer'); withdrawn[p] = withdrawn[p]! + amount; trace.push({ step, action: 'withdraw', amount }); }
        }
        assert(model.P >= beforeP); assert(model.R >= beforeR); await assertAll(step);
      }
      for (const model of models) await c.state(quotes[model.policy], model.incidentId, vaults[model.policy], tokens[model.policy]);
      outcomes.push({ seed, operations: 80, status: 'passed', trace, finalModels: models });
    });
  } finally { console.log(`Invariant evidence: ${c.save('invariants', outcomes)}`); await c.connection.close(); }
});
