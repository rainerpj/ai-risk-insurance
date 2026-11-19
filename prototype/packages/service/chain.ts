import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, type Hex, type Address, type Account, type Abi } from 'viem';
import { foundry } from 'viem/chains';
import { assertLocal } from '../domain/local.ts';
import { Fault } from './store.ts';
import { domain, types, type MessageType } from '../domain/typed-data.ts';
const abi = (name: string): Abi => JSON.parse(readFileSync(new URL(`../domain/abi/${name}.json`, import.meta.url),'utf8'));
export const coreAbi = abi('InsuranceCore'), vaultAbi = abi('PoolVault'), evidenceAbi=abi('EvidenceRegistry'), grantAbi=abi('GrantRegistry');
export class Chain {
  client: any; wallet: (address: string) => any;
  constructor(public core: Address, public deploymentId: Hex, transport: any, public accounts: Record<string, Account>,public registry?:Address) {
    this.client = createPublicClient({ chain: foundry, transport });
    this.wallet = address => { const account = accounts[address.toLowerCase()]; if (!account) throw new Fault(403,'NO_DEVELOPMENT_SIGNER'); return createWalletClient({ account, chain: foundry, transport }); };
  }
  static rpc(url: string, core: Address, deploymentId: Hex, accounts: Record<string,Account>,registry?:Address) { assertLocal(url); return new Chain(core,deploymentId,http(url),accounts,registry); }
  async check() { if (await this.client.getChainId() !== 31337 || await this.read('deploymentId') !== this.deploymentId) throw new Error('DEPLOYMENT_MISMATCH'); }
  async sign(actor:string,type:MessageType,message:any) { await this.check();return this.wallet(actor).account.signTypedData({domain:domain(this.core,this.deploymentId),types,primaryType:type,message}); }
  read(name: string,args: unknown[] = [],blockNumber?: bigint) { return this.client.readContract({ address:this.core,abi:coreAbi,functionName:name,args,blockNumber }); }
  async policy(id: string) { const p = await this.read('getPolicy',[id]); if (!p.issuedAt) throw new Fault(404,'POLICY_NOT_FOUND'); return p; }
  async incident(id: string) { const i = await this.read('getIncident',[id]); if (!i.version) throw new Fault(404,'INCIDENT_NOT_FOUND'); return i; }
  async prepare(actor: string,action: string,args: any[]): Promise<{raw:Hex;txHash:Hex}> {
    await this.check();
    // Fixed safety-only destination; callers cannot choose a target or resume a version.
    const safety=action==='safetyPauseTemplate';
    if(safety&&(args.length!==3||args[1]!==true))throw new Fault(400,'SAFETY_PAUSE_ONLY');
    const target=safety?await this.read('grantRegistry'):this.core, contractAbi=safety?grantAbi:coreAbi, name=safety?'pauseVersion':action;
    await this.client.simulateContract({address:target,abi:contractAbi,functionName:name,args,account:actor});
    const w = this.wallet(actor);
    const request = await w.prepareTransactionRequest({to:target,data:encodeFunctionData({abi:contractAbi,functionName:name,args}),gas:14_000_000n});
    const raw = await w.signTransaction(request); return {raw,txHash:keccak256(raw)};
  }
  async block(number: bigint) { return this.client.getBlock({blockNumber:number}); }
  async events(number: bigint,pools:string[] = []) {
    const logs = await this.client.getLogs({address:[this.core,...pools,...(this.registry?[this.registry]:[])],fromBlock:number,toBlock:number});
    return logs.flatMap((l:any) => { try { const e = decodeEventLog({abi:l.address.toLowerCase()===this.core.toLowerCase()?coreAbi:l.address.toLowerCase()===this.registry?.toLowerCase()?evidenceAbi:vaultAbi,data:l.data,topics:l.topics}); return [{...l,name:e.eventName,payload:e.args}]; } catch { return []; } });
  }
}
