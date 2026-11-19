// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Generated schema.
library SignatureTypes {
    struct Quote {
        bytes32 quoteId;
        address insured;
        address beneficiary;
        bytes32 enterpriseId;
        bytes32 fdeId;
        bytes32 workflowHash;
        bytes32 insurerId;
        address pool;
        address token;
        bytes32 productId;
        uint64 productVersion;
        bytes32 termsHash;
        bytes32 riskSnapshotHash;
        bytes32 formulaVersion;
        uint8 quoteMode;
        uint256 premium;
        uint256 annualLimit;
        uint256 incidentLimit;
        uint64 startAt;
        uint64 endAt;
        uint64 expiresAt;
        uint64 signerEpoch;
    }
    function hashQuote(Quote memory value) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("Quote(bytes32 quoteId,address insured,address beneficiary,bytes32 enterpriseId,bytes32 fdeId,bytes32 workflowHash,bytes32 insurerId,address pool,address token,bytes32 productId,uint64 productVersion,bytes32 termsHash,bytes32 riskSnapshotHash,bytes32 formulaVersion,uint8 quoteMode,uint256 premium,uint256 annualLimit,uint256 incidentLimit,uint64 startAt,uint64 endAt,uint64 expiresAt,uint64 signerEpoch)"), value));
    }
    struct Assessment {
        bytes32 decisionContentHash;
        address assessor;
        uint64 signerEpoch;
        uint64 expiresAt;
    }
    function hashAssessment(Assessment memory value) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("Assessment(bytes32 decisionContentHash,address assessor,uint64 signerEpoch,uint64 expiresAt)"), value));
    }
    struct SupervisorApproval {
        bytes32 decisionDigest;
        address supervisor;
        uint64 signerEpoch;
        uint64 expiresAt;
    }
    function hashSupervisorApproval(SupervisorApproval memory value) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("SupervisorApproval(bytes32 decisionDigest,address supervisor,uint64 signerEpoch,uint64 expiresAt)"), value));
    }
    struct ClaimDecision {
        bytes32 decisionId;
        bytes32 policyId;
        bytes32 incidentId;
        bytes32 noticeSetHash;
        uint64 version;
        uint64 previousVersion;
        bytes32 expectedLedgerHash;
        bytes32 assessmentHash;
        bytes32 amountsHash;
        uint256 netApproved;
        address beneficiary;
        bytes32 reasonHash;
        uint256 reviewAmount;
        uint8 channel;
        bytes32 grantId;
        uint64 grantEpoch;
        uint64 budgetVersion;
        bytes32 reservationId;
        address approver;
        uint64 signerEpoch;
        uint64 expiresAt;
    }
    function hashClaimDecision(ClaimDecision memory value) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("ClaimDecision(bytes32 decisionId,bytes32 policyId,bytes32 incidentId,bytes32 noticeSetHash,uint64 version,uint64 previousVersion,bytes32 expectedLedgerHash,bytes32 assessmentHash,bytes32 amountsHash,uint256 netApproved,address beneficiary,bytes32 reasonHash,uint256 reviewAmount,uint8 channel,bytes32 grantId,uint64 grantEpoch,uint64 budgetVersion,bytes32 reservationId,address approver,uint64 signerEpoch,uint64 expiresAt)"), value));
    }
    struct PaymentAuthorization {
        bytes32 paymentId;
        bytes32 policyId;
        bytes32 incidentId;
        uint64 decisionVersion;
        bytes32 decisionDigest;
        address token;
        address beneficiary;
        uint256 amount;
        uint64 installmentIndex;
        bytes32 grantId;
        uint64 grantEpoch;
        uint64 budgetVersion;
        bytes32 reservationId;
        bytes32 supersedesPaymentId;
        uint64 signerEpoch;
        uint64 expiresAt;
    }
    function hashPaymentAuthorization(PaymentAuthorization memory value) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("PaymentAuthorization(bytes32 paymentId,bytes32 policyId,bytes32 incidentId,uint64 decisionVersion,bytes32 decisionDigest,address token,address beneficiary,uint256 amount,uint64 installmentIndex,bytes32 grantId,uint64 grantEpoch,uint64 budgetVersion,bytes32 reservationId,bytes32 supersedesPaymentId,uint64 signerEpoch,uint64 expiresAt)"), value));
    }
    struct NoticeAuthorization {
        bytes32 noticeId;
        bytes32 policyId;
        bytes32 incidentCommitment;
        bytes32 evidenceHash;
        uint64 declaredIncidentAt;
        address submitter;
        uint64 signerEpoch;
        uint64 expiresAt;
    }
    function hashNoticeAuthorization(NoticeAuthorization memory value) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256("NoticeAuthorization(bytes32 noticeId,bytes32 policyId,bytes32 incidentCommitment,bytes32 evidenceHash,uint64 declaredIncidentAt,address submitter,uint64 signerEpoch,uint64 expiresAt)"), value));
    }
function decisionContentHash(ClaimDecision memory value) internal pure returns (bytes32) {
value.assessmentHash = bytes32(0);
return keccak256(abi.encode(keccak256("FDE_DECISION_CONTENT_V1"), hashClaimDecision(value)));
}
}
