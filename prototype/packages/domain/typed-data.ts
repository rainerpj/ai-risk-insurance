import { hashTypedData, hashStruct, encodeAbiParameters, keccak256, stringToHex, type Address, type Hex } from 'viem';
// Canonical schema v1. Every field is static ABI data; amounts/times are bigint in TS.
const fields = (spec: string) => spec.split(' ').map(pair => { const [name, type] = pair.split(':'); return { name: name!, type: type! }; });
export const types = {
  Quote: fields('quoteId:bytes32 insured:address beneficiary:address enterpriseId:bytes32 fdeId:bytes32 workflowHash:bytes32 insurerId:bytes32 pool:address token:address productId:bytes32 productVersion:uint64 termsHash:bytes32 riskSnapshotHash:bytes32 formulaVersion:bytes32 quoteMode:uint8 premium:uint256 annualLimit:uint256 incidentLimit:uint256 startAt:uint64 endAt:uint64 expiresAt:uint64 signerEpoch:uint64'),
  Assessment: fields('decisionContentHash:bytes32 assessor:address signerEpoch:uint64 expiresAt:uint64'),
  SupervisorApproval: fields('decisionDigest:bytes32 supervisor:address signerEpoch:uint64 expiresAt:uint64'),
  ClaimDecision: fields('decisionId:bytes32 policyId:bytes32 incidentId:bytes32 noticeSetHash:bytes32 version:uint64 previousVersion:uint64 expectedLedgerHash:bytes32 assessmentHash:bytes32 amountsHash:bytes32 netApproved:uint256 beneficiary:address reasonHash:bytes32 reviewAmount:uint256 channel:uint8 grantId:bytes32 grantEpoch:uint64 budgetVersion:uint64 reservationId:bytes32 approver:address signerEpoch:uint64 expiresAt:uint64'),
  PaymentAuthorization: fields('paymentId:bytes32 policyId:bytes32 incidentId:bytes32 decisionVersion:uint64 decisionDigest:bytes32 token:address beneficiary:address amount:uint256 installmentIndex:uint64 grantId:bytes32 grantEpoch:uint64 budgetVersion:uint64 reservationId:bytes32 supersedesPaymentId:bytes32 signerEpoch:uint64 expiresAt:uint64'),
  NoticeAuthorization: fields('noticeId:bytes32 policyId:bytes32 incidentCommitment:bytes32 evidenceHash:bytes32 declaredIncidentAt:uint64 submitter:address signerEpoch:uint64 expiresAt:uint64'),
} as const;
export type MessageType = keyof typeof types;
export const zeroHash = `0x${'00'.repeat(32)}` as Hex;
export function decisionContentHash(message: Record<string, unknown>): Hex {
  const normalized = { ...message, assessmentHash: zeroHash };
  validateMessage('ClaimDecision', normalized);
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [
    keccak256(stringToHex('FDE_DECISION_CONTENT_V1')),
    hashStruct({ types, primaryType: 'ClaimDecision', data: normalized }),
  ]));
}
export function domain(verifyingContract: Address, deploymentId: Hex, chainId = 31337) {
  if (chainId !== 31337) throw new Error('LOCAL_CHAIN_ONLY');
  return { name: 'FDEInsurancePrototype', version: '1', chainId, verifyingContract, salt: deploymentId } as const;
}
export function validateMessage(type: MessageType, message: Record<string, unknown>): void {
  const schema = types[type];
  if (Object.keys(message).length !== schema.length) throw new Error('SCHEMA_FIELDS');
  for (const field of schema) {
    const value = message[field.name];
    if (field.type.startsWith('uint')) {
      const bits = BigInt(field.type.slice(4));
      if (typeof value !== 'bigint' || value < 0n || value >= (1n << bits)) throw new Error(`INVALID_${field.name}`);
    } else if (typeof value !== 'string' || !(field.type === 'address' ? /^0x[0-9a-fA-F]{40}$/ : /^0x[0-9a-fA-F]{64}$/).test(value)) {
      throw new Error(`INVALID_${field.name}`);
    }
  }
}
export function digest(primaryType: MessageType, message: Record<string, unknown>, scope: ReturnType<typeof domain>) {
  validateMessage(primaryType, message);
  return hashTypedData({ domain: scope, types, primaryType, message });
}
