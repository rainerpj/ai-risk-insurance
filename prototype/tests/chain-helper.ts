import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import hre from 'hardhat';
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, keccak256, stringToHex, type Address, type Hex, type Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { calculateQuote } from '../packages/domain/pricing.ts';
import { types, domain, digest, decisionContentHash, zeroHash, type MessageType } from '../packages/domain/typed-data.ts';
export const U = 1_000_000n;
export const H = (s: string) => keccak256(stringToHex(s));
export const id = () => `0x${randomBytes(32).toString('hex')}` as Hex;
export const zeroAddress = `0x${'00'.repeat(20)}` as Address;
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export type Contract = { address: Address; abi: Abi };
export async function setup(options: {network?: 'default'|'localhost'; captureKey?:(name:string,key:Hex)=>void} = {}) {
  const connection = await hre.network.create({ network: options.network??'default' });
  const transport = custom(connection.provider);
  const client = createPublicClient({ chain: foundry, transport, pollingInterval: 10 });
  if(await client.getChainId()!==31337){await connection.close();throw new Error('LOCAL_CHAIN_ONLY');}
  const names = ['governor', 'treasurer', 'insured', 'fde', 'underwriter', 'assessor', 'approver', 'supervisor', 'executor', 'outsider', 'assessor2', 'approver2'] as const;
  const accounts = Object.fromEntries(names.map(name => {const key=generatePrivateKey();options.captureKey?.(name,key);return [name, privateKeyToAccount(key)];})) as Record<typeof names[number], ReturnType<typeof privateKeyToAccount>>;
  for (const account of Object.values(accounts)) await connection.provider.request({ method: 'hardhat_setBalance', params: [account.address, '0x3635c9adc5dea00000'] });
  const records: unknown[] = [];
  const signatures: unknown[] = [];
  const states: unknown[] = [];
  const quoteSnapshots: unknown[] = [];
  const sizes: Record<string, number> = {};
  const deployments: { name: string; address: Address; constructorArgs: readonly unknown[] }[] = [];
  const runId = randomUUID();
  let label = 'setup';
  function wallet(who: keyof typeof accounts) { return createWalletClient({ account: accounts[who], chain: foundry, transport }); }
  async function deploy(name: string, args: readonly unknown[] = []): Promise<Contract> {
    const artifact = await hre.artifacts.readArtifact(name);
    const hash = await wallet('governor').deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success');
    records.push({ label, action: `deploy ${name}`, receipt });
    const bytecode = await client.getCode({ address: receipt.contractAddress! });
    sizes[name] = (bytecode!.length - 2) / 2;
    assert((bytecode!.length - 2) / 2 <= 24576, `${name}: EIP170 size`);
    deployments.push({ name, address: receipt.contractAddress!, constructorArgs: args });
    return { address: receipt.contractAddress!, abi: artifact.abi };
  }
  async function read(c: Contract, functionName: string, args: readonly unknown[] = []): Promise<any> {
    return client.readContract({ ...c, functionName, args });
  }
  async function send(c: Contract, functionName: string, args: readonly unknown[] = [], who: keyof typeof accounts = 'governor') {
    const hash = await wallet(who).writeContract({ ...c, functionName, args, gas: 14_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    records.push({ label, action: functionName, caller: accounts[who].address, receipt });
    if (receipt.status !== 'success') await client.simulateContract({ ...c, functionName, args, account: accounts[who].address });
    assert.equal(receipt.status, 'success', functionName);
    return receipt;
  }
  async function rejects(c: Contract, functionName: string, args: readonly unknown[], who: keyof typeof accounts = 'governor', expected?: RegExp) {
    const simulate = () => client.simulateContract({ ...c, functionName, args, account: accounts[who].address });
    if (expected) await assert.rejects(simulate, expected); else await assert.rejects(simulate);
    const hash = await wallet(who).writeContract({ ...c, functionName, args, gas: 14_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'reverted', `${functionName} should revert`);
    records.push({ label, action: functionName, expectedFailure: true, receipt });
  }
  const salt = id(); const core = await deploy('InsuranceCore', [salt]);
  for(const [name,getter] of [['PolicyModule','policyModule'],['GrantRegistry','grantRegistry']]){const address=await read(core,getter!) as Address;sizes[name!]=((await client.getCode({address}))!.length-2)/2;assert(sizes[name!]!<=24576);deployments.push({name:name!,address,constructorArgs:name==='GrantRegistry'?[core.address]:[]});}
  const coreArtifact=await hre.artifacts.readArtifact('InsuranceCore');assert((coreArtifact.bytecode.length-2)/2+32<=49152,'EIP3860 initcode');
  const math = await read(core, 'settlementMath') as Address;
  sizes.SettlementMath = ((await client.getCode({ address: math }))!.length - 2) / 2;
  assert(sizes.SettlementMath <= 24576);
  deployments.push({ name: 'SettlementMath', address: math, constructorArgs: [] });
  const usdc = await deploy('MockUSDC'), usdt = await deploy('MockUSDT');
  const insurer = H('local insurer');
  const vault = await deploy('PoolVault', [core.address, usdc.address, insurer, 10000n * U]);
  const vault2 = await deploy('PoolVault', [core.address, usdt.address, insurer, 10000n * U]);
  for (const [role, who] of [['TREASURER', 'treasurer'], ['UNDERWRITER', 'underwriter'], ['ASSESSOR', 'assessor'], ['ASSESSOR', 'assessor2'], ['CLAIM_APPROVER', 'approver'], ['SUPERVISOR', 'supervisor']] as const) await send(core, 'grantRole', [H(role), accounts[who].address]);
  await send(core, 'bindIdentity', [accounts.insured.address, H('enterprise'), H('fde'), accounts.fde.address]);
  const product = { termsHash: H('terms'), formulaVersion: H('quote-interval-v1'), settlementRuleVersion: H('zero-deductible-net-v1'), allowedCategoriesHash: H('recovery,emergency') };
  await send(core, 'registerProduct', [H('product'), 1n, product]);
  for (const [token, pool] of [[usdc, vault], [usdt, vault2]] as const) {
    await send(core, 'registerPool', [pool.address]);
    await send(token, 'mint', [accounts.treasurer.address, 150000n * U]);
    await send(token, 'approve', [pool.address, 150000n * U], 'treasurer');
    await send(core, 'depositCapital', [pool.address, 150000n * U], 'treasurer');
    await send(core, 'sealPool', [pool.address]);
    await send(token, 'mint', [accounts.insured.address, 50000n * U]);
    await send(token, 'approve', [pool.address, 50000n * U], 'insured');
  }
  const scope = domain(core.address, salt);
  const now = async () => (await client.getBlock()).timestamp;
  async function sign(primaryType: MessageType, message: Record<string, unknown>, who: keyof typeof accounts, override = scope) {
    const signature = await accounts[who].signTypedData({ domain: override, types, primaryType, message });
    signatures.push({ label, primaryType, message, signature, signer: accounts[who].address, domain: override });
    return signature;
  }
  async function quote(overrides: Record<string, unknown> = {}) {
    const t = await now();
    const calculation = calculateQuote({ p: '0.001', q: '0.01', k: '1.2', tasks: 10000n, mode: 'budget', amount: 10000n * U });
    const q: Record<string, any> = { quoteId: id(), insured: accounts.insured.address, beneficiary: accounts.insured.address,
      enterpriseId: H('enterprise'), fdeId: H('fde'), workflowHash: H('workflow'), insurerId: insurer, pool: vault.address, token: usdc.address,
      productId: H('product'), productVersion: 1n, ...{ termsHash: product.termsHash, formulaVersion: product.formulaVersion },
      riskSnapshotHash: H(json(calculation)), quoteMode: 0n, premium: calculation.input.amount, annualLimit: calculation.output, incidentLimit: calculation.output,
      startAt: t + 3600n, endAt: t + 31536000n, expiresAt: t + 10000n, signerEpoch: await read(core, 'epochs', [accounts.underwriter.address]), ...overrides };
    quoteSnapshots.push({ label, quoteId: q.quoteId, source: 'PRD v0.4 section 8.2 synthetic inputs', calculation, snapshotHash: H(json(calculation)), overrides });
    return { q, sig: await sign('Quote', q, 'underwriter'), calculation };
  }
  async function issue(overrides: Record<string, unknown> = {}) {
    const signed = await quote(overrides);
    await send(core, 'purchasePolicy', [signed.q, signed.sig], 'insured');
    await connection.provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(signed.q.startAt)] });
    await connection.provider.request({ method: 'evm_mine' });
    return signed.q;
  }
  async function notice(q: Record<string, any>, overrides: Record<string, unknown> = {}) {
    const n = { noticeId: id(), policyId: q.quoteId, incidentCommitment: id(), evidenceHash: H('synthetic evidence'), declaredIncidentAt: q.startAt,
      submitter: accounts.insured.address, signerEpoch: await read(core, 'epochs', [accounts.insured.address]), expiresAt: (await now()) + 20000n, ...overrides };
    const sig = await sign('NoticeAuthorization', n, 'insured');
    await send(core, 'submitNotice', [n, sig], 'insured');
    return { n, sig };
  }
  const expense = (gross: bigint) => ({ gross, duplicate: 0n, compensation: 0n, recovery: 0n });
  async function decision(q: Record<string, any>, noticeIds: Hex[], incidentId = id(), amount = 33000n * U, overrides: Record<string, unknown> = {}, assessor: 'assessor' | 'assessor2' = 'assessor', approver: 'approver' | 'approver2' = 'approver') {
    const previous = await read(core, 'getIncident', [incidentId]);
    const expenses = [expense(amount > 3000n * U ? amount - 3000n * U : amount), expense(amount > 3000n * U ? 3000n * U : 0n)] as const;
    const components = ['gross', 'duplicate', 'compensation', 'recovery'].map(name => ({ name, type: 'uint256' }));
    const d: Record<string, any> = { decisionId: id(), policyId: q.quoteId, incidentId, noticeSetHash: keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [[...noticeIds].sort()])),
      version: previous.version + 1n, previousVersion: previous.version, expectedLedgerHash: await read(core, 'ledgerHash', [q.quoteId, incidentId]), assessmentHash: zeroHash,
      amountsHash: keccak256(encodeAbiParameters([{ type: 'tuple[2]', components }], [expenses])), netApproved: amount, beneficiary: q.beneficiary, reasonHash: H('manual verified synthetic claim'), reviewAmount: amount,
      channel: 0n, grantId: zeroHash, grantEpoch: 0n, budgetVersion: 0n, reservationId: zeroHash, approver: accounts[approver].address,
      signerEpoch: await read(core, 'epochs', [accounts[approver].address]), expiresAt: (await now()) + 10000n, ...overrides };
    const a = { decisionContentHash: decisionContentHash(d), assessor: accounts[assessor].address, signerEpoch: await read(core, 'epochs', [accounts[assessor].address]), expiresAt: (await now()) + 10000n };
    d.assessmentHash = digest('Assessment', a, scope);
    const aSig = await sign('Assessment', a, assessor), dSig = await sign('ClaimDecision', d, approver);
    const s = { decisionDigest: zeroHash, supervisor: zeroAddress, signerEpoch: 0n, expiresAt: 0n };
    let sSig: Hex = '0x';
    if (d.reviewAmount > 50000n * U) {
      s.decisionDigest = digest('ClaimDecision', d, scope); s.supervisor = accounts.supervisor.address;
      s.signerEpoch = await read(core, 'epochs', [s.supervisor]); s.expiresAt = (await now()) + 10000n;
      sSig = await sign('SupervisorApproval', s, 'supervisor');
    }
    return { d, a, s, args: [d, expenses, [...noticeIds].sort(), a, aSig, dSig, s, sSig] as unknown[], expenses };
  }
  async function payment(q: Record<string, any>, incidentId: Hex, amount: bigint, overrides: Record<string, unknown> = {}, approver: 'approver' | 'approver2' = 'approver') {
    const i = await read(core, 'getIncident', [incidentId]);
    const p: Record<string, any> = { paymentId: id(), policyId: q.quoteId, incidentId, decisionVersion: i.version, decisionDigest: i.decisionDigest,
      token: q.token, beneficiary: q.beneficiary, amount, installmentIndex: i.installmentIndex + 1n, grantId: zeroHash, grantEpoch: 0n, budgetVersion: 0n,
      reservationId: zeroHash, supersedesPaymentId: zeroHash, signerEpoch: await read(core, 'epochs', [accounts[approver].address]), expiresAt: (await now()) + 1000n, ...overrides };
    return { p, sig: await sign('PaymentAuthorization', p, approver) };
  }
  async function state(q?: Record<string, any>, incidentId?: Hex, pool = vault, token = usdc) {
    const result = { pool: { A_U_W: await read(pool, 'balances'), H: await read(pool, 'H'), K: await read(pool, 'K'), B: await read(pool, 'B'), classified: await read(pool, 'classifiedAssets') },
      beneficiaryBalance: await read(token, 'balanceOf', [accounts.insured.address]), policy: q ? await read(core, 'getPolicy', [q.quoteId]) : null, incident: incidentId ? await read(core, 'getIncident', [incidentId]) : null };
    states.push({ label, ...result }); return result;
  }
  return { connection, client, core, usdc, usdt, vault, vault2, accounts, scope, salt, records, signatures, states, runId,
    deploy, read, send, rejects, quote, issue, notice, decision, payment, state, sign, now,
    label(value: string) { label = value; },
    save(kind: string, extra: unknown = {}) {
      mkdirSync('reports', { recursive: true });
      mkdirSync('deployments', { recursive: true });
      const path = `reports/${kind}-${runId}.json`;
      const manifest = { runId, chainId: 31337, deploymentId: salt, environment: options.network==='localhost'?'persistent local EVM; addresses valid only for the same running node state':'ephemeral local EVM; addresses not available after process exit',
        node: process.version, solidity: '0.8.28', evm: 'cancun', viaIR: true, optimizerRuns: 50, sizes,
        dependencies: JSON.parse(readFileSync('package.json', 'utf8')), deployments, contracts: { core: core.address, settlementMath: math, usdc: usdc.address, usdt: usdt.address, vault: vault.address, vault2: vault2.address },
        roles: Object.fromEntries(Object.entries(accounts).map(([k,v]) => [k,v.address])) };
      writeFileSync(`deployments/${kind}-${runId}.json`, json(manifest));
      writeFileSync(path, json({ runId, kind, chainId: 31337, deploymentId: salt, contracts: { core: core.address, usdc: usdc.address, usdt: usdt.address, vault: vault.address, vault2: vault2.address },
        roles: manifest.roles, sizes, deployments, quoteSnapshots, records, signatures, states, extra }));
      return path;
    },
  };
}
export async function manualScenario(ctx: Awaited<ReturnType<typeof setup>>) {
  ctx.label('manual-main');
  await ctx.state();
  const q = await ctx.issue();
  const issued = await ctx.state(q);
  assert.equal(issued.pool.A_U_W[0], 160000n * U); assert.equal(issued.pool.K, q.annualLimit);
  const notice = await ctx.notice(q);
  const decision = await ctx.decision(q, [notice.n.noticeId]);
  await ctx.send(ctx.core, 'registerDecision', decision.args, 'executor');
  const registered = await ctx.state(q, decision.d.incidentId);
  assert.equal(registered.incident.D, 33000n * U);
  const first = await ctx.payment(q, decision.d.incidentId, 8000n * U);
  // Both installments signed against the SAME registered decision before either is paid.
  const second = await ctx.payment(q, decision.d.incidentId, 25000n * U, { installmentIndex: 2n });
  await ctx.send(ctx.core, 'executePayment', [first.p, first.sig], 'executor');
  const partial = await ctx.state(q, decision.d.incidentId);
  assert.equal(partial.incident.D, 25000n * U);
  await ctx.send(ctx.core, 'executePayment', [second.p, second.sig], 'outsider');
  const final = await ctx.state(q, decision.d.incidentId);
  assert.equal(final.incident.P, 33000n * U); assert.equal(final.incident.D, 0n);
  assert.equal(final.pool.A_U_W[0], 127000n * U); assert.equal(final.pool.H, 10000n * U);
  assert.equal(final.pool.K, 93099383836n); assert.equal(final.pool.A_U_W[2], 13900616164n);
  assert.equal(final.policy.paidTotal, final.incident.P); assert.equal(final.policy.dueTotal, 0n);
  await ctx.rejects(ctx.core, 'executePayment', [first.p, first.sig], 'executor', /PaymentAlreadyExecuted/);
  assert.deepEqual(await ctx.state(q, decision.d.incidentId), final);
  return { q, decision, first, second, final };
}
