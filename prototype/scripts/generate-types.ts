import { mkdirSync, writeFileSync } from 'node:fs';
import { types } from '../packages/domain/typed-data.ts';
// Regenerate rather than manually maintaining a second field order.
let source = '// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\n// Generated schema.\nlibrary SignatureTypes {\n';
let probe = '// SPDX-License-Identifier: MIT\npragma solidity 0.8.28;\nimport {SignatureTypes as T} from "./SignatureTypes.sol";\ncontract SignatureProbe {\n';
for (const [name, fields] of Object.entries(types)) {
  const signature = `${name}(${fields.map(f => `${f.type} ${f.name}`).join(',')})`;
  source += `    struct ${name} {\n${fields.map(f => `        ${f.type} ${f.name};`).join('\n')}\n    }\n`;
  source += `    function hash${name}(${name} memory value) internal pure returns (bytes32) {\n        return keccak256(abi.encode(keccak256("${signature}"), value));\n    }\n`;
  probe += `function hash${name}(T.${name} calldata value) external pure returns (bytes32) { return T.hash${name}(value); }\n`;
}
source += `function decisionContentHash(ClaimDecision memory value) internal pure returns (bytes32) {
value.assessmentHash = bytes32(0);
return keccak256(abi.encode(keccak256("FDE_DECISION_CONTENT_V1"), hashClaimDecision(value)));
}\n}\n`;
probe += `function decisionContentHash(T.ClaimDecision calldata value) external pure returns (bytes32) { return T.decisionContentHash(value); }
    function domainSeparator(bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"), keccak256("FDEInsurancePrototype"), keccak256("1"), block.chainid, address(this), salt));
    }
    function typedDigest(bytes32 structHash, bytes32 salt) external view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(salt), structHash));
    }
}\n`;
mkdirSync('contracts', { recursive: true });
writeFileSync('contracts/SignatureTypes.sol', source);
writeFileSync('contracts/SignatureProbe.sol', probe);
