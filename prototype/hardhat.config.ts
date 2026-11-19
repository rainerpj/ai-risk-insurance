import { defineConfig } from 'hardhat/config';
import { assertLocal } from './packages/domain/local.ts';
const url = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const chainId = Number(process.env.CHAIN_ID ?? '31337');
assertLocal(url, chainId);
export default defineConfig({
  solidity: { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 50 }, viaIR: true, evmVersion: 'cancun' } },
  networks: {
    default: { type: 'edr-simulated', chainType: 'l1', chainId: 31337, throwOnTransactionFailures: false },
    localhost: { type: 'http', chainType: 'l1', chainId: 31337, url },
  },
});
