import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { setup, manualScenario, U, H, id, zeroAddress } from './chain-helper.ts';
import { zeroHash } from '../packages/domain/typed-data.ts';

test('M1a local contract acceptance', async t => {
  const c = await setup();
  const outcomes: { name: string; status: string }[] = [];
  let snapshot = await c.connection.provider.request({ method: 'evm_snapshot' });
  async function run(name: string, fn: () => Promise<void>) {
    await t.test(name, async () => {
      assert.equal(await c.connection.provider.request({ method: 'evm_revert', params: [snapshot] }), true);
      snapshot = await c.connection.provider.request({ method: 'evm_snapshot' });
      c.label(name);
      try { await fn(); outcomes.push({ name, status: 'passed' }); }
      catch (e) { outcomes.push({ name, status: 'failed' }); throw e; }
    });
  }
  async function approved(amount = 33000n * U) {
    const q = await c.issue(); const n = await c.notice(q); const d = await c.decision(q, [n.n.noticeId], id(), amount);
    await c.send(c.core, 'registerDecision', d.args, 'executor');
    return { q, n, d };
  }
  try {
    await run('PRD 150000 capital / formula purchase / 8000+25000 and replay', async () => { await manualScenario(c); });
    await run('future coverage reserves full limit and expired policy accepts notice without releasing K', async () => {
      const { q, sig } = await c.quote(); await c.send(c.core, 'purchasePolicy', [q, sig], 'insured');
      assert((await c.now()) < q.startAt);
      const K = await c.read(c.vault, 'K'); assert.equal(K, q.annualLimit);
      const preStart=await c.notice(q,{declaredIncidentAt:q.startAt-1n});
      const premature=await c.decision(q,[preStart.n.noticeId]);
      const before=await c.state(q,premature.d.incidentId);
      await c.rejects(c.core,'registerDecision',premature.args,'executor',/NoticeConflict/);
      assert.deepEqual(await c.state(q,premature.d.incidentId),before);
      const future=await c.notice(q),futureDecision=await c.decision(q,[future.n.noticeId]);
      await c.rejects(c.core,'registerDecision',futureDecision.args,'executor',/NoticeConflict/);
      await c.connection.provider.request({method:'evm_setNextBlockTimestamp',params:[Number(q.startAt)]});
      await c.connection.provider.request({method:'evm_mine'});
      await c.send(c.core,'registerDecision',futureDecision.args,'executor');
      assert.equal((await c.read(c.core,'getIncident',[futureDecision.d.incidentId])).D,33000n*U);
      await c.connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(q.endAt + 1n)] });
      await c.connection.provider.request({ method: 'evm_mine' });
      await c.notice(q); assert.equal(await c.read(c.vault, 'K'), K);
    });
    await run('quote revocation permissions, idempotence, conflict, both ordering cases and unaffected other quote', async () => {
      const x = await c.quote(); const before = await c.state(x.q);
      await c.rejects(c.core, 'revokeQuote', [x.q, x.sig, H('reason')], 'outsider');
      await c.send(c.core, 'revokeQuote', [x.q, x.sig, H('reason')], 'underwriter');
      await c.send(c.core, 'revokeQuote', [x.q, x.sig, H('reason')], 'underwriter');
      await c.rejects(c.core, 'purchasePolicy', [x.q, x.sig], 'insured', /QuoteIsRevoked/);
      const changed = { ...x.q, premium: x.q.premium + 1n };
      await c.rejects(c.core, 'revokeQuote', [changed, await c.sign('Quote', changed, 'underwriter'), H('reason')], 'underwriter', /QuoteDigestConflict/);
      assert.deepEqual(await c.state(x.q), before);
      const other = await c.quote(); await c.send(c.core, 'purchasePolicy', [other.q, other.sig], 'insured');
      const purchased=await c.state(other.q);
      await c.rejects(c.core, 'revokeQuote', [other.q, other.sig, H('reason')], 'underwriter', /QuoteAlreadyUsed/);
      await c.rejects(c.core, 'purchasePolicy', [other.q, other.sig], 'insured', /QuoteAlreadyUsed/);
      assert.deepEqual(await c.state(other.q),purchased);
    });
    await run('governor may revoke expired quote of revoked signer; regrant never revives old quote', async () => {
      const x = await c.quote();
      await c.send(c.core, 'revokeRole', [H('UNDERWRITER'), c.accounts.underwriter.address]);
      await c.send(c.core, 'grantRole', [H('UNDERWRITER'), c.accounts.underwriter.address]);
      await c.rejects(c.core, 'purchasePolicy', [x.q, x.sig], 'insured', /InvalidEpoch/);
      await c.connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(x.q.expiresAt + 1n)] });
      await c.connection.provider.request({ method: 'evm_mine' });
      await c.send(c.core, 'revokeQuote', [x.q, x.sig, H('expired')]);
    });
    for (const which of ['expired', 'pastStart', 'wrongToken', 'wrongPool', 'capacity', 'wrongInsured', 'premiumZero', 'unknownProduct'] as const) {
      await run(`purchase rollback: ${which}`, async () => {
        const overrides = { expired: { expiresAt: 1n }, pastStart: { startAt: 1n }, wrongToken: { token: c.usdt.address }, wrongPool: { pool: c.vault2.address }, capacity: { annualLimit: 140001n * U, incidentLimit: 140001n * U }, wrongInsured: { insured: c.accounts.outsider.address }, premiumZero: { premium: 0n }, unknownProduct: { productVersion: 2n } }[which];
        const x = await c.quote(overrides); const before = await c.state(x.q);
        await c.rejects(c.core, 'purchasePolicy', [x.q, x.sig], 'insured');
        assert.deepEqual(await c.state(x.q), before); assert.equal(await c.read(c.core, 'quoteUsed', [x.q.quoteId]), false);
      });
    }
    for (const which of ['allowance', 'balance'] as const) {
      await run(`purchase rollback: insufficient ${which}`, async () => {
        if (which === 'allowance') await c.send(c.usdc, 'approve', [c.vault.address, 0n], 'insured');
        else await c.send(c.usdc, 'transfer', [c.accounts.outsider.address, 50000n * U], 'insured');
        const x = await c.quote(); const before = await c.state(x.q);
        await c.rejects(c.core, 'purchasePolicy', [x.q, x.sig], 'insured'); assert.deepEqual(await c.state(x.q), before);
        assert.equal(await c.read(c.core,'quoteUsed',[x.q.quoteId]),false);
      });
    }
    await run('cross chain, deployment, contract and field tampering reject signatures', async () => {
      const x = await c.quote();
      for (const override of [{ ...c.scope, salt: id() }, { ...c.scope, verifyingContract: c.vault.address }, { ...c.scope, chainId: 1 }]) {
        const sig = await c.accounts.underwriter.signTypedData({ domain: override, types: (await import('../packages/domain/typed-data.ts')).types, primaryType: 'Quote', message: x.q });
        await c.rejects(c.core, 'purchasePolicy', [x.q, sig], 'insured');
      }
      await c.rejects(c.core, 'purchasePolicy', [{ ...x.q, annualLimit: x.q.annualLimit + 1n }, x.sig], 'insured');
    });
    await run('roles cannot bypass forbidden pairs via AccessControl grantRole and self-review fails', async () => {
      await c.rejects(c.core, 'grantRole', [H('CLAIM_APPROVER'), c.accounts.assessor.address], 'governor', /RoleConflict/);
      await c.rejects(c.core, 'grantRole', [H('SUPERVISOR'), c.accounts.approver.address], 'governor', /RoleConflict/);
      await c.rejects(c.core, 'grantRole', [H('UNDERWRITER'), c.accounts.outsider.address], 'outsider');
      const q = await c.issue(), n = await c.notice(q);
      await c.send(c.core, 'grantRole', [H('ASSESSOR'), c.accounts.insured.address]);
      const d = await c.decision(q, [n.n.noticeId]);
      d.a.assessor = c.accounts.insured.address; d.a.signerEpoch = await c.read(c.core, 'epochs', [c.accounts.insured.address]);
      const { digest } = await import('../packages/domain/typed-data.ts');
      d.d.assessmentHash = digest('Assessment', d.a, c.scope);
      d.args[4] = await c.sign('Assessment', d.a, 'insured'); d.args[5] = await c.sign('ClaimDecision', d.d, 'approver');
      await c.rejects(c.core, 'registerDecision', d.args, 'executor', /SelfReview/);
    });
    await run('notice idempotence, conflict, coverage time and reuse across incidents', async () => {
      const q = await c.issue(), n = await c.notice(q);
      await c.send(c.core, 'submitNotice', [n.n, n.sig], 'outsider');
      const changed = { ...n.n, evidenceHash: id() };
      await c.rejects(c.core, 'submitNotice', [changed, await c.sign('NoticeAuthorization', changed, 'insured')], 'insured', /NoticeConflict/);
      const d = await c.decision(q, [n.n.noticeId]); await c.send(c.core, 'registerDecision', d.args);
      const d2 = await c.decision(q, [n.n.noticeId]); await c.rejects(c.core, 'registerDecision', d2.args, 'executor', /NoticeConflict/);
      const outside = await c.notice(q, { declaredIncidentAt: q.startAt - 1n });
      const d3 = await c.decision(q, [outside.n.noticeId]); await c.rejects(c.core, 'registerDecision', d3.args, 'executor', /NoticeConflict/);
    });
    await run('independent assessment, amounts hash, approved sum and automatic channel fail closed', async () => {
      const q = await c.issue(), n = await c.notice(q);
      for (const overrides of [{ netApproved: 1n }, { channel: 1n }, { amountsHash: id() }, { beneficiary: c.accounts.outsider.address }]) {
        const d = await c.decision(q, [n.n.noticeId], id(), 33000n * U, overrides);
        await c.rejects(c.core, 'registerDecision', d.args, 'executor');
      }
      const d = await c.decision(q, [n.n.noticeId]);
      d.args[4] = await c.sign('Assessment', d.a, 'outsider');
      await c.rejects(c.core, 'registerDecision', d.args, 'executor', /InvalidSignature/);
    });
    await run('two independently signed decisions race: stale policy snapshot rejected; annual cap recalculated', async () => {
      const q = await c.issue(), n1 = await c.notice(q), n2 = await c.notice(q);
      const d1 = await c.decision(q, [n1.n.noticeId], id(), 70000n * U), d2 = await c.decision(q, [n2.n.noticeId], id(), 70000n * U);
      await c.send(c.core, 'registerDecision', d1.args);
      await c.rejects(c.core, 'registerDecision', d2.args, 'executor', /StaleLedger/);
      const cap = q.annualLimit - 70000n * U;
      const revised = await c.decision(q, [n2.n.noticeId], d2.d.incidentId, 70000n * U, { netApproved: cap });
      await c.send(c.core, 'registerDecision', revised.args);
      assert.equal((await c.read(c.core, 'getPolicy', [q.quoteId])).dueTotal, q.annualLimit);
    });
    await run('supervisor required above 50000, independent epoch rechecked at payment', async () => {
      const q = await c.issue(), n = await c.notice(q), d = await c.decision(q, [n.n.noticeId], id(), 50001n * U);
      const missing = [...d.args]; missing[6] = { decisionDigest: zeroHash, supervisor: zeroAddress, signerEpoch: 0n, expiresAt: 0n }; missing[7] = '0x';
      await c.rejects(c.core, 'registerDecision', missing, 'executor', /MissingSupervisor/);
      await c.send(c.core, 'registerDecision', d.args);
      const pay = await c.payment(q, d.d.incidentId, 1000n * U);
      await c.send(c.core, 'rotateEpoch', [c.accounts.supervisor.address]);
      const before = await c.state(q, d.d.incidentId);
      await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'executor', /InvalidEpoch/);
      assert.deepEqual(await c.state(q, d.d.incidentId), before);
    });
    await run('payment expired, wrong recipient/token/version, excessive amount and unauthorized signatures preserve debt', async () => {
      const { q, d } = await approved();
      for (const overrides of [{ expiresAt: 1n }, { token: c.usdt.address }, { beneficiary: c.accounts.outsider.address }, { decisionVersion: 2n }, { amount: 33001n * U }]) {
        const pay = await c.payment(q, d.d.incidentId, 8000n * U, overrides), before = await c.state(q, d.d.incidentId);
        await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
        assert.deepEqual(await c.state(q, d.d.incidentId), before);
      }
      const pay = await c.payment(q, d.d.incidentId, 8000n * U);
      await c.rejects(c.core, 'executePayment', [pay.p, await c.sign('PaymentAuthorization', pay.p, 'executor')], 'executor', /InvalidSignature/);
    });
    await run('assessor revoked after 8000: freeze and new independent decision preserve P then pay remaining 25000', async () => {
      const { q, n, d } = await approved();
      const first = await c.payment(q, d.d.incidentId, 8000n * U); await c.send(c.core, 'executePayment', [first.p, first.sig], 'executor');
      const old = await c.payment(q, d.d.incidentId, 25000n * U);
      await c.send(c.core, 'revokeRole', [H('ASSESSOR'), c.accounts.assessor.address]);
      await c.rejects(c.core, 'executePayment', [old.p, old.sig], 'executor');
      await c.send(c.core, 'setIncidentFreeze', [d.d.incidentId, true, H('role rotation')]);
      const fresh = await c.decision(q, [n.n.noticeId], d.d.incidentId, 33000n * U, {}, 'assessor2');
      await c.send(c.core, 'registerDecision', fresh.args);
      await c.send(c.core, 'setIncidentFreeze', [d.d.incidentId, false, H('reconciled')]);
      await c.rejects(c.core, 'executePayment', [old.p, old.sig], 'executor', /StaleDecision/);
      const next = await c.payment(q, d.d.incidentId, 25000n * U); await c.send(c.core, 'executePayment', [next.p, next.sig], 'executor');
      const i = await c.read(c.core, 'getIncident', [d.d.incidentId]); assert.equal(i.P, 33000n * U); assert.equal(i.D, 0n);
    });
    await run('pool isolation, capital ownership, unsolicited transfer and restricted withdrawal', async () => {
      await c.issue(); const before2 = await c.read(c.vault2, 'balances');
      const W = (await c.read(c.vault, 'balances'))[2];
      await c.send(c.usdc, 'mint', [c.vault.address, 1000n * U]);
      const balances = await c.read(c.vault, 'balances'); assert.equal(balances[1], 1000n * U); assert.equal(balances[2], W);
      await c.rejects(c.core, 'withdrawCapital', [c.vault.address, W + 1n], 'treasurer');
      await c.send(c.core, 'grantRole', [H('TREASURER'), c.accounts.outsider.address]);
      await c.rejects(c.core, 'withdrawCapital', [c.vault.address, 1n], 'outsider');
      await c.send(c.core, 'withdrawCapital', [c.vault.address, W], 'treasurer');
      assert.equal((await c.read(c.vault, 'balances'))[2], 0n);
      assert.deepEqual(await c.read(c.vault2, 'balances'), before2);
      await c.rejects(c.vault, 'pay', [c.accounts.insured.address, 1n], 'governor');
    });
    await run('pause is action-scoped and any relayer remains subject to payment pause', async () => {
      const { q, d } = await approved(); const pay = await c.payment(q, d.d.incidentId, 8000n * U);
      await c.send(c.core, 'setActionPause', [2, true, H('pause')]);
      await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'outsider', /ChannelPaused/);
      await c.send(c.core, 'withdrawCapital', [c.vault.address, 1n], 'treasurer');
      await c.send(c.core, 'setActionPause', [2, false, H('resume')]);
      await c.send(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
    });
    await run('same name and decimals never substitute token address for premiums or payments', async () => {
      const clone=await c.deploy('MockUSDC');
      assert.notEqual(clone.address,c.usdc.address);
      for(const field of ['name','symbol','decimals'])assert.equal(await c.read(clone,field),await c.read(c.usdc,field));
      await c.send(clone,'mint',[c.accounts.insured.address,50000n*U]);
      await c.send(clone,'approve',[c.vault.address,50000n*U],'insured');
      const clonedBalance=await c.read(clone,'balanceOf',[c.accounts.insured.address]);
      const x=await c.quote({token:clone.address}),before=await c.state(x.q);
      await c.rejects(c.core,'purchasePolicy',[x.q,x.sig],'insured',/UnsupportedToken/);
      assert.deepEqual(await c.state(x.q),before);
      assert.equal(await c.read(c.core,'quoteUsed',[x.q.quoteId]),false);
      const {q,d}=await approved();const approvedState=await c.state(q,d.d.incidentId);
      for(const token of [clone,c.usdt]){
        const payment=await c.payment(q,d.d.incidentId,8000n*U,{token:token.address});
        await c.rejects(c.core,'executePayment',[payment.p,payment.sig],'executor',/UnsupportedToken/);
        assert.deepEqual(await c.state(q,d.d.incidentId),approvedState);
        assert.equal(await c.read(c.core,'usedPaymentIds',[payment.p.paymentId]),false);
      }
      assert.equal(await c.read(clone,'balanceOf',[c.accounts.insured.address]),clonedBalance);
      assert.equal(await c.read(clone,'balanceOf',[c.vault.address]),0n);
    });
    await run('wrong decimals, unsealed pool and one-time pool configuration', async () => {
      const wrong = await c.deploy('MockToken', ['Mock USDC', 'mUSDC', 18]);
      await assert.rejects(() => c.deploy('PoolVault', [c.core.address, wrong.address, H('wrong'), U]));
      await c.rejects(c.core, 'registerPool', [c.vault.address]);
      await c.rejects(c.core, 'sealPool', [c.vault.address]);
      const token = await c.deploy('MockUSDC'); const vault = await c.deploy('PoolVault', [c.core.address, token.address, H('unsealed'), 10000n * U]);
      await c.send(c.core, 'registerPool', [vault.address]);
      await c.send(token, 'mint', [c.accounts.insured.address, 20000n * U]); await c.send(token, 'approve', [vault.address, 20000n * U], 'insured');
      const q = await c.quote({ pool: vault.address, token: token.address, insurerId: H('unsealed') });
      await c.rejects(c.core, 'purchasePolicy', [q.q, q.sig], 'insured');
      await c.rejects(c.core, 'sealPool', [vault.address]);
    });
    await run('each dependency expires independently; payment-only renewal retains same installment', async () => {
      const { q, d } = await approved();
      const pay = await c.payment(q, d.d.incidentId, 8000n * U, { expiresAt: (await c.now()) + 10n });
      await c.connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(pay.p.expiresAt)] });
      await c.connection.provider.request({ method: 'evm_mine' });
      await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'executor', /ExpiredAuthorization/);
      const renewed = await c.payment(q, d.d.incidentId, 8000n * U, { supersedesPaymentId: pay.p.paymentId });
      await c.send(c.core, 'executePayment', [renewed.p, renewed.sig], 'executor');
      const next = await c.payment(q, d.d.incidentId, 25000n * U, { expiresAt: d.d.expiresAt + 1000n });
      await c.connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(d.a.expiresAt)] });
      await c.connection.provider.request({ method: 'evm_mine' });
      await c.rejects(c.core, 'executePayment', [next.p, next.sig], 'executor', /ExpiredAuthorization/);
      assert.equal((await c.read(c.core, 'getIncident', [d.d.incidentId])).D, 25000n * U);
    });
    await run('50000 boundary requires no supervisor; supervisor expiry blocks 50000.000001 payment', async () => {
      const { q, n } = await approved(50000n * U);
      const n2 = await c.notice(q), d = await c.decision(q, [n2.n.noticeId], id(), 50000n * U + 1n);
      d.s.expiresAt = (await c.now()) + 10n; d.args[7] = await c.sign('SupervisorApproval', d.s, 'supervisor');
      await c.send(c.core, 'registerDecision', d.args);
      const pay = await c.payment(q, d.d.incidentId, 1n * U);
      await c.connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(d.s.expiresAt)] });
      await c.connection.provider.request({ method: 'evm_mine' });
      await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'executor', /ExpiredAuthorization/);
    });
    await run('negative rebasing deficit stops payout, debt and payment ID remain intact', async () => {
      const token = await c.deploy('AdversarialToken'); const vault = await c.deploy('PoolVault', [c.core.address, token.address, H('deficit insurer'), 10000n * U]);
      await c.send(c.core, 'registerPool', [vault.address]);
      await c.send(token, 'mint', [c.accounts.treasurer.address, 150000n * U]); await c.send(token, 'approve', [vault.address, 150000n * U], 'treasurer');
      await c.send(c.core, 'depositCapital', [vault.address, 150000n * U], 'treasurer'); await c.send(c.core, 'sealPool', [vault.address]);
      await c.send(token, 'mint', [c.accounts.insured.address, 20000n * U]); await c.send(token, 'approve', [vault.address, 20000n * U], 'insured');
      const q = await c.issue({ pool: vault.address, token: token.address, insurerId: H('deficit insurer') });
      const n = await c.notice(q), d = await c.decision(q, [n.n.noticeId]); await c.send(c.core, 'registerDecision', d.args);
      const pay = await c.payment(q, d.d.incidentId, 8000n * U); const before = await c.read(c.core, 'getIncident', [d.d.incidentId]);
      await c.send(token, 'burn', [vault.address, 1n]);
      await assert.rejects(() => c.read(vault, 'balances'));
      await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
      assert.deepEqual(await c.read(c.core, 'getIncident', [d.d.incidentId]), before);
      assert.equal(await c.read(c.core, 'usedPaymentIds', [pay.p.paymentId]), false);
    });
    for (const mode of [1, 2, 3, 4]) {
      await run(`adversarial token mode ${mode}: deposit, premium and payout revert atomically`, async () => {
        const token = await c.deploy('AdversarialToken'); const vault = await c.deploy('PoolVault', [c.core.address, token.address, H('adversarial insurer'), 10000n * U]);
        await c.send(c.core, 'registerPool', [vault.address]);
        await c.send(token, 'mint', [c.accounts.treasurer.address, 150000n * U]); await c.send(token, 'approve', [vault.address, 150000n * U], 'treasurer');
        const callback = encodeFunctionData({ abi: c.core.abi, functionName: 'purchasePolicy', args: [(await c.quote()).q, '0x'] });
        await c.send(token, 'configure', [mode, c.core.address, callback]);
        await c.rejects(c.core, 'depositCapital', [vault.address, 150000n * U], 'treasurer');
        assert.equal(await c.read(vault, 'classifiedAssets'), 0n);
        await c.send(token, 'configure', [0, zeroAddress, '0x']); await c.send(c.core, 'depositCapital', [vault.address, 150000n * U], 'treasurer'); await c.send(c.core, 'sealPool', [vault.address]);
        await c.send(token, 'mint', [c.accounts.insured.address, 20000n * U]); await c.send(token, 'approve', [vault.address, 20000n * U], 'insured');
        const x = await c.quote({ pool: vault.address, token: token.address, insurerId: H('adversarial insurer') });
        await c.send(token, 'configure', [mode, c.core.address, callback]);
        const pre = await c.state(x.q, undefined, vault, token);
        await c.rejects(c.core, 'purchasePolicy', [x.q, x.sig], 'insured'); assert.deepEqual(await c.state(x.q, undefined, vault, token), pre);
        assert.equal(await c.read(c.core,'quoteUsed',[x.q.quoteId]),false);
        await c.send(token, 'configure', [0, zeroAddress, '0x']);
        const q = await c.issue({ pool: vault.address, token: token.address, insurerId: H('adversarial insurer') });
        const n = await c.notice(q), d = await c.decision(q, [n.n.noticeId]); await c.send(c.core, 'registerDecision', d.args);
        const pay = await c.payment(q, d.d.incidentId, 8000n * U);
        await c.send(token, 'configure', [mode, c.core.address, callback]);
        const before = await c.state(q, d.d.incidentId, vault, token);
        await c.rejects(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
        assert.deepEqual(await c.state(q, d.d.incidentId, vault, token), before); assert.equal(await c.read(c.core, 'usedPaymentIds', [pay.p.paymentId]), false);
        await c.send(token, 'configure', [0, zeroAddress, '0x']); await c.send(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
        assert.equal((await c.read(c.core, 'getIncident', [d.d.incidentId])).D, 25000n * U);
      });
    }
  } finally { console.log(`Contract evidence: ${c.save('contract-tests', outcomes)}`); await c.connection.close(); }
});
