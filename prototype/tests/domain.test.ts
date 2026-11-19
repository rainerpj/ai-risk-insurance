import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { calculateQuote, UINT256_MAX, type QuoteInput } from '../packages/domain/pricing.ts';
import { approval, netLoss, pool, settlement } from '../packages/domain/ledger.ts';
import { assertLocal } from '../packages/domain/local.ts';
import { validateRoles, validateParticipants } from '../packages/domain/roles.ts';
import { digest, domain, types, validateMessage, type MessageType } from '../packages/domain/typed-data.ts';
const unit = 1_000_000n;
const baseline: QuoteInput = { p: '0.001', q: '0.01', k: '1.2', tasks: 10_000n, mode: 'budget', amount: 10_000n * unit };
test('PRD budget 10000/6000 and reverse target, exact six decimals', () => {
  assert.equal(calculateQuote(baseline).output, 126099383836n);
  assert.equal(calculateQuote({ ...baseline, amount: 6000n * unit }).output, 75659630301n);
  assert.equal(calculateQuote({ ...baseline, mode: 'target', amount: 126099383836n }).output, 10000n * unit);
});
test('independent 400-digit decimal reference across deterministic risk vectors', () => {
  const D = Decimal.clone({ precision: 400 });
  for (let i = 1; i <= 60; i++) {
    const input = { ...baseline, p: `0.${String(i).padStart(3, '0')}`, tasks: BigInt(i * 7919), amount: BigInt(i * 987654321) };
    const a = new D(1).minus(new D(1).minus(new D(input.p).mul(input.q)).pow(input.tasks.toString()));
    for (const mode of ['budget', 'target'] as const) {
      const expected = mode === 'budget' ? new D(input.k).mul(input.amount.toString()).div(a).floor() : new D(input.amount.toString()).mul(a).div(input.k).ceil();
      assert.equal(calculateQuote({ ...input, mode }).output, BigInt(expected.toFixed(0)));
    }
  }
});
test('tiny risk, certain event and exact integer boundary', () => {
  assert.equal(calculateQuote({ ...baseline, p: '1', q: '1' }).output, 12000n * unit);
  assert.equal(calculateQuote({ ...baseline, p: '0.000000000000000001', q: '0.000000000000000001', tasks: 1n, k: '1', amount: 1n }).output, 10n ** 36n);
});

test('AC31 doubled error rate reprices both directions without rounding probability', () => {
  const D = Decimal.clone({ precision: 400 });
  const a = new D(1).minus(new D(1).minus(new D('0.002').mul('0.01')).pow(10000));
  const budget = calculateQuote({ ...baseline, p: '0.002' });
  const target = calculateQuote({ ...baseline, p: '0.002', mode: 'target', amount: 126099383836n });
  assert.equal(budget.output, BigInt(new D('1.2').mul(baseline.amount.toString()).div(a).floor().toFixed(0)));
  assert.equal(target.output, BigInt(new D('126099383836').mul(a).div('1.2').ceil().toFixed(0)));
  assert(budget.output < calculateQuote(baseline).output);
  assert(target.output > baseline.amount);
  const roundedA = a.toDecimalPlaces(6);
  assert.notEqual(budget.output, BigInt(new D('1.2').mul(baseline.amount.toString()).div(roundedA).floor().toFixed(0)));
  // A positive sub-unit premium rounds up; a sub-unit coverage rounds down and is rejected.
  assert.equal(calculateQuote({ ...baseline, mode: 'target', amount: 1n }).output, 1n);
  assert.throws(() => calculateQuote({ ...baseline, p: '1', q: '1', k: '0.1', amount: 1n }), /ZERO_QUOTE/);
  for (const change of [{ q: '0' }, { amount: -1n }, { p: '1.1' }]) {
    assert.throws(() => calculateQuote({ ...baseline, ...change }));
  }
});
test('precision escalation and explicit ambiguous rejection', () => {
  assert.throws(() => calculateQuote(baseline, [2]), /PRECISION_AMBIGUOUS/);
  assert.equal(calculateQuote(baseline, [2, 80]).precision, 80);
});
for (const [label, change] of Object.entries({ zeroRisk: { p: '0' }, nan: { p: 'NaN' }, negative: { q: '-1' }, exponent: { p: '1e-3' }, precision: { p: '0.1234567890123456789' }, probability: { q: '1.1' }, kZero: { k: '0' }, kHigh: { k: '1001' }, tasksZero: { tasks: 0n }, tasksHigh: { tasks: 1000000001n }, amountZero: { amount: 0n }, overflow: { amount: UINT256_MAX } })) {
  test(`reject invalid quote ${label}`, () => assert.throws(() => calculateQuote({ ...baseline, ...change })));
}
test('loss deduction, partial payment, downward revision and recovery do not restore paid usage', () => {
  const expense = (gross: bigint) => ({ gross, duplicate: 0n, compensation: 0n, recovery: 0n });
  const N = netLoss([expense(30000n * unit), expense(3000n * unit)]);
  assert.equal(N, 33000n * unit);
  assert.equal(settlement(8000n * unit, 0n, N).D, 25000n * unit);
  assert.equal(settlement(N, 0n, 23000n * unit).Q, 10000n * unit);
  const recovered = settlement(N, 10000n * unit, 23000n * unit);
  assert.equal(recovered.D, 0n); assert.equal(recovered.Q, 0n); assert.equal(recovered.P, N);
  assert.throws(() => netLoss([{ ...expense(1n), compensation: 2n }, expense(0n)]));
  assert.throws(() => settlement(1n, 2n, 0n));
});
test('annual other-incident occupancy and re-open after recovery use historical paid limits', () => {
  assert.equal(approval(100n, 30n, 10n, 40n, 80n, 100n).N, 50n);
  assert.equal(approval(100n, 30n, 10n, 40n, 80n, 100n).D, 30n);
  assert.throws(() => approval(100n, 30n, 0n, 80n, 80n, 100n));
});
test('pool PRD walkthrough, unsolicited transfer restriction and shortfall detection', () => {
  const L = calculateQuote(baseline).output, B = 10000n * unit;
  const issued = pool(160000n * unit, 160000n * unit, B, L, B);
  const paid = pool(127000n * unit, 127000n * unit, B, L - 33000n * unit, B);
  const returned = pool(137000n * unit, 137000n * unit, 20000n * unit, paid.K, B);
  assert.equal(issued.W, 13900616164n); assert.equal(paid.W, issued.W); assert.equal(returned.W, issued.W);
  assert.equal(pool(returned.A + 100n, returned.A, returned.H, returned.K, B).W, returned.W);
  assert.throws(() => pool(99n, 100n, 0n, 0n, 0n));
  assert.throws(() => pool(100n, 100n, 50n, 50n, 1n));
});
test('local-only guard rejects external endpoints, credentials and wrong chain', () => {
  assertLocal(); assertLocal('http://[::1]:8545');
  for (const url of ['https://127.0.0.1', 'http://127.0.0.1.evil.test', 'http://user:pass@localhost', 'http://0.0.0.0', 'http://example.com']) assert.throws(() => assertLocal(url));
  assert.throws(() => assertLocal(undefined, 1));
});
test('role separation and self-review rejection', () => {
  validateRoles(['UNDERWRITER', 'ANCHOR_OPERATOR']);
  for (const pair of [['ASSESSOR', 'CLAIM_APPROVER'], ['ASSESSOR', 'SUPERVISOR'], ['CLAIM_APPROVER', 'SUPERVISOR'], ['AUTO_REVIEWER', 'AUTO_AUTHORIZER']] as const) assert.throws(() => validateRoles(pair));
  assert.throws(() => validateParticipants(['a', 'A'], 'b', 'c'));
  assert.throws(() => validateParticipants(['a', 'b'], 'a', 'c'));
  assert.throws(() => validateParticipants(['a', 'b'], 'c', 'd', 'A'));
});
test('all schema fields bind digest; narrowing, Number input and unknown fields fail', () => {
  const address = `0x${'11'.repeat(20)}` as const, salt = `0x${'22'.repeat(32)}` as const;
  for (const primaryType of Object.keys(types) as MessageType[]) {
    const message = Object.fromEntries(types[primaryType].map(f => [f.name, f.type === 'address' ? address : f.type === 'bytes32' ? salt : 1n]));
    const original = digest(primaryType, message, domain(address, salt));
    for (const f of types[primaryType]) {
      const changed = f.type === 'address' ? `0x${'33'.repeat(20)}` : f.type === 'bytes32' ? `0x${'44'.repeat(32)}` : 2n;
      assert.notEqual(digest(primaryType, { ...message, [f.name]: changed }, domain(address, salt)), original);
    }
    assert.throws(() => validateMessage(primaryType, { ...message, unknown: 0n }));
    assert.throws(() => validateMessage(primaryType, { ...message, signerEpoch: 1 }));
    assert.throws(() => validateMessage(primaryType, { ...message, signerEpoch: 1n << 64n }));
  }
});
