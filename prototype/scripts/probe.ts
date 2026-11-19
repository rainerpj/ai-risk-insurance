import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import hre from 'hardhat';
import { createPublicClient, createWalletClient, custom, hashStruct, recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { types, domain, digest, decisionContentHash, type MessageType } from '../packages/domain/typed-data.ts';
const connection = await hre.network.create({ network: 'default' });
try {
  const transport = custom(connection.provider);
  const client = createPublicClient({ chain: foundry, transport });
  const [deployer] = await createWalletClient({ chain: foundry, transport }).getAddresses();
  assert(deployer);
  assert.equal(await client.getChainId(), 31337);
  const wallet = createWalletClient({ account: deployer, chain: foundry, transport });
  const artifact = await hre.artifacts.readArtifact('SignatureProbe');
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode as Hex });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  const address = receipt.contractAddress!;
  const salt = `0x${randomBytes(32).toString('hex')}` as Hex;
  const scope = domain(address, salt);
  const signer = privateKeyToAccount(`0x${randomBytes(32).toString('hex')}`);
  const vectors = [];
  for (const primaryType of Object.keys(types) as MessageType[]) {
    const message: Record<string, bigint | Hex> = Object.fromEntries(types[primaryType].map((f, i): [string, bigint | Hex] => [f.name,
      f.type === 'address' ? deployer : f.type === 'bytes32' ? `0x${(i + 1).toString(16).padStart(64, '0')}` : BigInt(i + 1)]));
    const structHash: Hex = hashStruct({ data: message, primaryType, types });
    const onchain = await client.readContract({ address, abi: artifact.abi, functionName: `hash${primaryType}`, args: [message] });
    assert.equal(onchain, structHash);
    if (primaryType === 'ClaimDecision') assert.equal(await client.readContract({ address, abi: artifact.abi, functionName: 'decisionContentHash', args: [message] }), decisionContentHash(message));
    const typedDigest = digest(primaryType, message, scope);
    assert.equal(await client.readContract({ address, abi: artifact.abi, functionName: 'typedDigest', args: [structHash, salt] }), typedDigest);
    const signature = await signer.signTypedData({ domain: scope, types, primaryType, message });
    assert.equal(await recoverTypedDataAddress({ domain: scope, types, primaryType, message, signature }), signer.address);
    assert.notEqual(digest(primaryType, message, domain(address, `0x${'ff'.repeat(32)}`)), typedDigest);
    vectors.push({ primaryType, message, structHash, typedDigest, signature });
  }
  const runId = randomUUID();
  mkdirSync('reports', { recursive: true });
  writeFileSync(`reports/m0-${runId}.json`, JSON.stringify({ runId, kind: 'M0 encoding probe only', node: process.version, chainId: 31337,
    deploymentId: salt, contract: address, signer: signer.address, receipt, vectors }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log(`PASS: local deployment, ${vectors.length} TS/Solidity hashes and signatures; reports/m0-${runId}.json`);
} finally { await connection.close(); }
