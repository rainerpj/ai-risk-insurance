import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, type Hex } from 'viem';
import { generateKeyPairSync } from 'node:crypto';
import { setup, manualScenario, U, H, id, zeroAddress } from './chain-helper.ts';
import { seal, merkleRoot, inclusionProof, verifyEvidence, sha256 } from '../packages/domain/evidence.ts';
import { zeroHash } from '../packages/domain/typed-data.ts';
import { syntheticEvent } from './evidence-fixture.ts';
type Context = Awaited<ReturnType<typeof setup>>;
async function revise(c: Context, q: Record<string, any>, incidentId: Hex, notices: Hex[], amount: bigint, overrides: Record<string, unknown> = {}) {
  const before = await c.read(c.core, 'getIncident', [incidentId]);
  await c.send(c.core, 'setIncidentFreeze', [incidentId, true, H('revision')]);
  const reviewAmount = before.P + before.D > amount ? before.P + before.D : amount;
  const d = await c.decision(q, notices, incidentId, amount, { reviewAmount, ...overrides });
  await c.send(c.core, 'registerDecision', d.args); return d;
}
test('M1b cash recovery, dispute lifecycle, evidence anchoring and security', async t => {
  const c = await setup(); let snapshot = await c.connection.provider.request({ method: 'evm_snapshot' });
  const outcomes: unknown[] = [];
  async function run(name: string, fn: () => Promise<void>) {
    await t.test(name, async () => {
      await c.connection.provider.request({ method: 'evm_revert', params: [snapshot] }); snapshot = await c.connection.provider.request({ method: 'evm_snapshot' }); c.label(name);
      try { await fn(); outcomes.push({ name, status: 'passed' }); } catch (e) { outcomes.push({ name, status: 'failed' }); throw e; }
    });
  }
  try {
    await run('AC12-14: 33000 -> 23000; partial cash returns, replay/overreturn/outsider rejection; reopen cannot restore limits', async () => {
      const { q, decision, final } = await manualScenario(c); c.label('recovery-main');
      const notices = decision.args[2] as Hex[]; const incident = decision.d.incidentId;
      await revise(c, q, incident, notices, 23000n * U);
      const reduced = await c.state(q, incident); assert.equal(reduced.incident.Q, 10000n * U); assert.deepEqual(reduced.pool, final.pool);
      const returnId = id();
      await c.rejects(c.core, 'returnRecovery', [incident, 1n, returnId], 'outsider', /RecoveryInvalid/);
      await c.rejects(c.core, 'returnRecovery', [incident, 10000n * U + 1n, returnId], 'insured', /RecoveryInvalid/);
      await c.send(c.usdc, 'approve', [c.vault.address, 10000n * U], 'insured');
      await c.send(c.core, 'returnRecovery', [incident, 4000n * U, returnId], 'insured');
      assert.equal((await c.read(c.core, 'getIncident', [incident])).Q, 6000n * U);
      await c.rejects(c.core, 'returnRecovery', [incident, 1n, returnId], 'insured', /RecoveryInvalid/);
      await c.send(c.core, 'returnRecovery', [incident, 6000n * U, id()], 'insured');
      const returned = await c.state(q, incident);
      assert.equal(returned.pool.A_U_W[0], 137000n * U); assert.equal(returned.pool.H, 20000n * U);
      assert.equal(returned.pool.K, final.pool.K); assert.equal(returned.pool.A_U_W[2], final.pool.A_U_W[2]);
      assert.equal(returned.incident.P, 33000n * U); assert.equal(returned.incident.R, 10000n * U); assert.equal(returned.incident.Q, 0n);
      await revise(c, q, incident, notices, 200000n * U, { netApproved: q.annualLimit - 10000n * U });
      await c.send(c.core, 'setIncidentFreeze', [incident, false, H('approved reopen')]);
      const rest = await c.payment(q, incident, q.annualLimit - 33000n * U); await c.send(c.core, 'executePayment', [rest.p, rest.sig], 'executor');
      const end = await c.state(q, incident); assert.equal(end.incident.P, q.annualLimit); assert.equal(end.pool.K, 0n);
      await revise(c, q, incident, notices, 300000n * U, { netApproved: q.annualLimit - 10000n * U });
      assert.equal((await c.read(c.core, 'getIncident', [incident])).D, 0n);
    });
    await run('AC15: lower-decision race, freeze first or old payment first, stale snapshot and old version', async () => {
      const q = await c.issue(), n = await c.notice(q), d = await c.decision(q, [n.n.noticeId]); await c.send(c.core, 'registerDecision', d.args);
      const old = await c.payment(q, d.d.incidentId, 33000n * U);
      const stale = await c.decision(q, [n.n.noticeId], d.d.incidentId, 23000n * U, { reviewAmount: 33000n * U });
      await c.send(c.core, 'executePayment', [old.p, old.sig], 'executor');
      await c.send(c.core, 'setIncidentFreeze', [d.d.incidentId, true, H('freeze')]);
      await c.rejects(c.core, 'registerDecision', stale.args, 'executor', /StaleLedger/);
      await revise(c, q, d.d.incidentId, [n.n.noticeId], 23000n * U);
      assert.equal((await c.read(c.core, 'getIncident', [d.d.incidentId])).Q, 10000n * U);
      await c.send(c.core, 'setIncidentFreeze', [d.d.incidentId, false, H('ready')]);
      const n2 = await c.notice(q), d2 = await c.decision(q, [n2.n.noticeId], id(), 1000n * U); await c.send(c.core, 'registerDecision', d2.args);
      const blocked = await c.payment(q, d2.d.incidentId, 1000n * U);
      await c.send(c.core, 'setIncidentFreeze', [d2.d.incidentId, true, H('freeze first')]);
      await c.rejects(c.core, 'executePayment', [blocked.p, blocked.sig], 'executor', /PaymentFrozen/);
      await revise(c, q, d2.d.incidentId, [n2.n.noticeId], 500n * U);
      await c.send(c.core, 'setIncidentFreeze', [d2.d.incidentId, false, H('ready')]);
      await c.rejects(c.core, 'executePayment', [blocked.p, blocked.sig], 'executor', /StaleDecision/);
    });
    await run('AC21: denial -> appeal -> independent reopening -> new decision; immutable history and manual hold', async () => {
      const q = await c.issue(), n = await c.notice(q), d = await c.decision(q, [n.n.noticeId], id(), 0n); await c.send(c.core, 'registerDecision', d.args);
      const oldDigest = (await c.read(c.core, 'getIncident', [d.d.incidentId])).decisionDigest; const dispute = id();
      await c.rejects(c.core, 'appendDispute', [d.d.incidentId, dispute, 1n, H('appeal')], 'outsider');
      await c.send(c.core, 'appendDispute', [d.d.incidentId, dispute, 1n, H('appeal')], 'insured');
      await c.rejects(c.core, 'appendDispute', [d.d.incidentId, dispute, 1n, H('appeal')], 'insured');
      await c.rejects(c.core, 'reopenIncident', [dispute, H('review')], 'approver', /RoleConflict/);
      await c.send(c.core, 'grantRole', [H('CLAIM_APPROVER'), c.accounts.approver2.address]);
      await c.send(c.core, 'reopenIncident', [dispute, H('new reviewer')], 'approver2');
      await c.rejects(c.core, 'setIncidentFreeze', [d.d.incidentId, false, H('bypass')], 'governor', /DisputePending/);
      const reused = await c.decision(q, [n.n.noticeId], d.d.incidentId, 1000n * U);
      await c.rejects(c.core, 'registerDecision', reused.args, 'executor', /RoleConflict/);
      const fresh = await c.decision(q, [n.n.noticeId], d.d.incidentId, 1000n * U, {}, 'assessor2', 'approver2');
      await c.send(c.core, 'registerDecision', fresh.args);
      await c.send(c.core, 'setIncidentFreeze', [d.d.incidentId, false, H('review complete')], 'approver2');
      const pay = await c.payment(q, d.d.incidentId, 1000n * U, {}, 'approver2'); await c.send(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
      assert.equal(await c.read(c.core, 'decisionHistory', [d.d.incidentId, 1n]), oldDigest);
      assert.equal((await c.read(c.core, 'disputes', [dispute]))[7], 2n);
      assert.equal((await c.state(q, d.d.incidentId)).incident.manualHold, true);
    });
    await run('appeal preserves undisputed debt and payout; direct revision cannot bypass reopening', async () => {
      const q = await c.issue(), n = await c.notice(q), d = await c.decision(q, [n.n.noticeId], id(), 1000n * U); await c.send(c.core, 'registerDecision', d.args);
      await c.send(c.core, 'appendDispute', [d.d.incidentId, id(), 1n, H('disputed additional cost')], 'insured');
      const pay = await c.payment(q, d.d.incidentId, 1000n * U); await c.send(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
      await c.send(c.core, 'setIncidentFreeze', [d.d.incidentId, true, H('freeze')]);
      const next = await c.decision(q, [n.n.noticeId], d.d.incidentId, 2000n * U);
      await c.rejects(c.core, 'registerDecision', next.args, 'executor', /DisputePending/);
      assert.equal((await c.state(q, d.d.incidentId)).incident.P, 1000n * U);
    });
    await run('AC18/19/22: registry append/idempotence/conflict/revocation/pause; zero-evidence notice and independent proof', async () => {
      const registry = await c.deploy('EvidenceRegistry', [c.core.address]);
      await c.send(c.core, 'grantRole', [H('ANCHOR_OPERATOR'), c.accounts.executor.address]);
      const keys = generateKeyPairSync('ed25519'); const original = Buffer.from('synthetic evidence');
      const envelope = seal(JSON.stringify({ schema_version: '1', event: syntheticEvent('1', ['o']), objects: [{ object_id: 'o', content_type: 'text/plain', byte_length: String(original.length), content_digest: sha256(original).toString('hex') }] }), keys.privateKey, 'collector', '2026-10-23T00:00:03Z');
      const leaves = [envelope.commitment, sha256('other').toString('hex'), sha256('third').toString('hex')];
      const root = '0x' + merkleRoot(leaves), batch = id();
      await c.rejects(registry, 'anchorBatch', [batch, root, 3n, H('FDE-EVIDENCE-v1')], 'outsider', /Unauthorized/);
      const anchorReceipt = await c.send(registry, 'anchorBatch', [batch, root, 3n, H('FDE-EVIDENCE-v1')], 'executor');
      await c.connection.provider.request({ method: 'evm_mine' });
      const observedHead = await c.client.getBlockNumber({ cacheTime: 0 });
      assert.ok(observedHead - anchorReceipt.blockNumber + 1n >= 2n);
      assert.equal((await c.client.getBlock({ blockNumber: anchorReceipt.blockNumber })).hash, anchorReceipt.blockHash);
      const saved = await c.read(registry, 'batches', [batch]);
      await c.send(registry, 'anchorBatch', [batch, root, 3n, H('FDE-EVIDENCE-v1')], 'executor');
      assert.deepEqual(await c.read(registry, 'batches', [batch]), saved);
      await c.rejects(registry, 'anchorBatch', [batch, id(), 3n, H('FDE-EVIDENCE-v1')], 'executor', /BatchConflict/);
      for (const [size, protocol] of [[0n, H('FDE-EVIDENCE-v1')], [10001n, H('FDE-EVIDENCE-v1')], [3n, H('other')]] as const) await c.rejects(registry, 'anchorBatch', [id(), root, size, protocol], 'executor', /InvalidBatch/);
      await c.send(registry, 'setPaused', [true, H('pause')]);
      await c.rejects(registry, 'anchorBatch', [id(), root, 3n, H('FDE-EVIDENCE-v1')], 'executor', /Paused/);
      const q = await c.issue(); await c.notice(q, { evidenceHash: zeroHash });
      await c.send(registry, 'setPaused', [false, H('resume')]);
      await c.send(c.core, 'revokeRole', [H('ANCHOR_OPERATOR'), c.accounts.executor.address]);
      await c.rejects(registry, 'anchorBatch', [id(), root, 3n, H('FDE-EVIDENCE-v1')], 'executor', /Unauthorized/);
      const proof = { batchId: batch, index: 0, size: 3, path: inclusionProof(leaves, 0), root: root.slice(2) };
      const result = verifyEvidence(envelope, new Map([['o', original]]), { keyId: 'collector', publicKey: keys.publicKey, validFrom: '2026-01-01Z', validUntil: '2027-01-01Z' }, proof,
        { batchId: batch, root: saved[0].slice(2), size: Number(saved[1]) });
      assert.equal(result.anchor, 'valid'); assert.equal(result.signature, 'valid'); assert.equal(result.inclusion, 'valid');
      c.states.push({ label: 'evidence protocol', envelope, proof, result, registry: registry.address, anchoredBatch: saved,
        anchorReceipt, observedHead, confirmations: observedHead - anchorReceipt.blockNumber + 1n });
    });
    for (const mode of [1, 2, 3, 4]) await run(`recovery token fault ${mode}: allowance/balance failure and reentry rollback do not consume return ID`, async () => {
      const token = await c.deploy('AdversarialToken'), vault = await c.deploy('PoolVault', [c.core.address, token.address, H('fault insurer'), 10000n * U]);
      await c.send(c.core, 'registerPool', [vault.address]); await c.send(token, 'mint', [c.accounts.treasurer.address, 150000n * U]);
      await c.send(token, 'approve', [vault.address, 150000n * U], 'treasurer'); await c.send(c.core, 'depositCapital', [vault.address, 150000n * U], 'treasurer'); await c.send(c.core, 'sealPool', [vault.address]);
      await c.send(token, 'mint', [c.accounts.insured.address, 10000n * U]); await c.send(token, 'approve', [vault.address, 10000n * U], 'insured');
      const q = await c.issue({ pool: vault.address, token: token.address, insurerId: H('fault insurer') }), n = await c.notice(q), d = await c.decision(q, [n.n.noticeId]);
      await c.send(c.core, 'registerDecision', d.args); const pay = await c.payment(q, d.d.incidentId, 33000n * U); await c.send(c.core, 'executePayment', [pay.p, pay.sig], 'executor');
      await revise(c, q, d.d.incidentId, [n.n.noticeId], 23000n * U);
      const returnId = id(), before = await c.state(q, d.d.incidentId, vault, token);
      await c.rejects(c.core, 'returnRecovery', [d.d.incidentId, 10000n * U, returnId], 'insured');
      await c.send(token, 'approve', [vault.address, 10000n * U], 'insured');
      if (mode === 1) {
        await c.send(token, 'transfer', [c.accounts.outsider.address, 33000n * U], 'insured');
        await c.rejects(c.core, 'returnRecovery', [d.d.incidentId, 10000n * U, returnId], 'insured');
        assert.equal((await c.read(c.core, 'getIncident', [d.d.incidentId])).Q, 10000n * U);
        await c.send(token, 'transfer', [c.accounts.insured.address, 33000n * U], 'outsider');
      }
      const callback = encodeFunctionData({ abi: c.core.abi, functionName: 'returnRecovery', args: [d.d.incidentId, 1n, id()] });
      await c.send(token, 'configure', [mode, c.core.address, callback]);
      await c.rejects(c.core, 'returnRecovery', [d.d.incidentId, 10000n * U, returnId], 'insured');
      assert.deepEqual(await c.state(q, d.d.incidentId, vault, token), before); assert.equal(await c.read(c.core, 'usedReturnIds', [returnId]), false);
      await c.send(token, 'configure', [0, zeroAddress, '0x']); await c.send(c.core, 'returnRecovery', [d.d.incidentId, 10000n * U, returnId], 'insured');
      assert.equal((await c.state(q, d.d.incidentId, vault, token)).incident.R, 10000n * U);
    });
  } finally { console.log(`M1b evidence: ${c.save('m1b', outcomes)}`); await c.connection.close(); }
});
