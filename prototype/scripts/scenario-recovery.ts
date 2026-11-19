import assert from 'node:assert/strict';
import { setup, manualScenario, U, H, id } from '../tests/chain-helper.ts';
import type { Hex } from 'viem';
const c = await setup();
try {
  const { q, decision } = await manualScenario(c);
  c.label('recovery-extension');
  const incidentId = decision.d.incidentId;
  await c.send(c.core, 'setIncidentFreeze', [incidentId, true, H('confirmed third party reimbursement')]);
  const revision = await c.decision(q, decision.args[2] as Hex[], incidentId, 23000n * U, { reviewAmount: 33000n * U });
  await c.send(c.core, 'registerDecision', revision.args);
  const receivable = await c.state(q, incidentId);
  assert.equal(receivable.incident.Q, 10000n * U); assert.equal(receivable.pool.A_U_W[0], 127000n * U);
  await c.send(c.usdc, 'approve', [c.vault.address, 10000n * U], 'insured');
  await c.send(c.core, 'returnRecovery', [incidentId, 10000n * U, id()], 'insured');
  const returned = await c.state(q, incidentId);
  assert.equal(returned.pool.A_U_W[0], 137000n * U); assert.equal(returned.pool.H, 20000n * U);
  assert.equal(returned.pool.K, 93099383836n); assert.equal(returned.pool.A_U_W[2], 13900616164n);
  assert.equal(returned.incident.P, 33000n * U); assert.equal(returned.incident.R, 10000n * U); assert.equal(returned.incident.Q, 0n);
  console.log(`PASS PRD11.2 cash recovery: ${c.save('recovery')}`);
} finally { await c.connection.close(); }
