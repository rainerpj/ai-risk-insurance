import { mkdirSync, writeFileSync } from 'node:fs';
import hre from 'hardhat';
import { types } from '../packages/domain/typed-data.ts';
mkdirSync('packages/domain/abi', { recursive: true });
for (const name of ['InsuranceCore', 'PoolVault', 'MockUSDC', 'MockUSDT', 'SettlementMath', 'EvidenceRegistry', 'PolicyModule', 'GrantRegistry']) {
  const artifact = await hre.artifacts.readArtifact(name);
  writeFileSync(`packages/domain/abi/${name}.json`, JSON.stringify(artifact.abi, null, 2) + '\n');
}
writeFileSync('packages/domain/abi/typed-data-v1.json', JSON.stringify(types, null, 2) + '\n');
