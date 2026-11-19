// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {SignatureTypes as T} from "./SignatureTypes.sol";
contract SignatureProbe {
function hashQuote(T.Quote calldata value) external pure returns (bytes32) { return T.hashQuote(value); }
function hashAssessment(T.Assessment calldata value) external pure returns (bytes32) { return T.hashAssessment(value); }
function hashSupervisorApproval(T.SupervisorApproval calldata value) external pure returns (bytes32) { return T.hashSupervisorApproval(value); }
function hashClaimDecision(T.ClaimDecision calldata value) external pure returns (bytes32) { return T.hashClaimDecision(value); }
function hashPaymentAuthorization(T.PaymentAuthorization calldata value) external pure returns (bytes32) { return T.hashPaymentAuthorization(value); }
function hashNoticeAuthorization(T.NoticeAuthorization calldata value) external pure returns (bytes32) { return T.hashNoticeAuthorization(value); }
function decisionContentHash(T.ClaimDecision calldata value) external pure returns (bytes32) { return T.decisionContentHash(value); }
    function domainSeparator(bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"), keccak256("FDEInsurancePrototype"), keccak256("1"), block.chainid, address(this), salt));
    }
    function typedDigest(bytes32 structHash, bytes32 salt) external view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(salt), structHash));
    }
}
