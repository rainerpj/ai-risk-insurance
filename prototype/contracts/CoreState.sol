// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureTypes as T} from "./SignatureTypes.sol";
import {PoolVault} from "./PoolVault.sol";
import {GrantRegistry} from "./GrantRegistry.sol";
import {SettlementMath} from "./SettlementMath.sol";


abstract contract CoreState is AccessControl, ReentrancyGuard {
    bytes32 public constant GOVERNOR = keccak256("GOVERNOR");
    bytes32 public constant UNDERWRITER = keccak256("UNDERWRITER");
    bytes32 public constant ASSESSOR = keccak256("ASSESSOR");
    bytes32 public constant CLAIM_APPROVER = keccak256("CLAIM_APPROVER");
    bytes32 public constant SUPERVISOR = keccak256("SUPERVISOR");
    bytes32 public constant AUTO_REVIEWER = keccak256("AUTO_REVIEWER");
    bytes32 public constant AUTO_AUTHORIZER = keccak256("AUTO_AUTHORIZER");
    bytes32 public constant TREASURER = keccak256("TREASURER");
    bytes32 internal constant ANCHOR_OPERATOR = keccak256("ANCHOR_OPERATOR");
    bytes32 public deploymentId;
    SettlementMath public settlementMath;
    GrantRegistry public grantRegistry;
    mapping(address => uint64) public epochs;
    struct Identity { bytes32 enterpriseId; bytes32 fdeId; address fde; }
    mapping(address => Identity) public identities;
    struct Product { bytes32 termsHash; bytes32 formulaVersion; bytes32 settlementRuleVersion; bytes32 allowedCategoriesHash; }
    mapping(bytes32 => Product) public products;
    mapping(address => bool) public registeredPools;
    mapping(bytes32 => address) public poolByAsset;
    mapping(bytes32 => bool) public quoteUsed;
    mapping(bytes32 => bytes32) public revokedQuoteDigest;
    struct Policy { T.Quote quote; uint64 issuedAt; uint64 revision; uint256 paidTotal; uint256 dueTotal; address fde; }
    mapping(bytes32 => Policy) internal policies;
    struct Notice { T.NoticeAuthorization data; bytes32 digest; uint64 anchoredAt; bytes32 incidentId; }
    mapping(bytes32 => Notice) internal notices;
    struct Incident {
        bytes32 policyId; uint64 version; uint64 revision; uint64 installmentIndex;
        uint256 P; uint256 R; uint256 N; uint256 D; uint256 Q;
        bool frozen; bytes32 noticeSetHash; bytes32 decisionDigest;
        bool manualHold; bytes32 activeDispute;
        T.Assessment assessment; T.ClaimDecision decision; T.SupervisorApproval supervisor;
    }
    mapping(bytes32 => Incident) internal incidents;
    mapping(bytes32 => bool) public usedDecisionIds;
    mapping(bytes32 => bool) public usedPaymentIds;
    mapping(bytes32 => bool) public usedReturnIds;
    mapping(bytes32 => mapping(uint64 => bytes32)) public decisionHistory;
    struct Dispute { bytes32 incidentId; uint64 challengedVersion; bytes32 reasonHash; address claimant;
        address formerAssessor; address formerApprover; bool reopened; uint64 resolvedVersion; }
    mapping(bytes32 => Dispute) public disputes;
    mapping(uint8 => bool) public actionPaused; // 0 purchase, 1 withdraw, 2 payment
    error InvalidInput(); error RoleConflict(); error InvalidEpoch(); error ExpiredAuthorization();
    error InvalidSignature(); error QuoteAlreadyUsed(); error QuoteIsRevoked(); error QuoteDigestConflict();
    error StaleLedger(); error StaleDecision(); error AmountMismatch(); error LimitExceeded();
    error PaymentAlreadyExecuted(); error PoolNotReady(); error UnsupportedToken(); error PaymentFrozen();
    error ChannelPaused(); error NoticeConflict(); error SelfReview(); error MissingSupervisor(); error FreezeRequired();
    error DisputePending(); error RecoveryInvalid();
    event EpochChanged(address indexed account, uint64 epoch);
    event PoolRegistered(address indexed pool, bytes32 indexed insurerId, address token);
    event ProductRegistered(bytes32 indexed productKey);
    event PolicyIssued(bytes32 indexed policyId, bytes32 indexed quoteId, address indexed insured, uint256 premium, uint256 annualLimit);
    event QuoteRevoked(bytes32 indexed quoteId, bytes32 quoteDigest, address indexed operator, bytes32 reasonHash);
    event NoticeRegistered(bytes32 indexed noticeId, bytes32 indexed policyId, bytes32 digest, uint64 anchoredAt);
    event DecisionRegistered(bytes32 indexed incidentId, bytes32 indexed decisionId, uint64 version, bytes32 digest, uint256 N, uint256 D, uint256 Q);
    event PaymentExecuted(bytes32 indexed paymentId, bytes32 indexed incidentId, uint256 amount, uint256 P, uint256 D);
    event IncidentFreezeChanged(bytes32 indexed incidentId, bool frozen, bytes32 reasonHash);
    event ActionPauseChanged(uint8 action, bool paused, bytes32 reasonHash);
    event RecoveryReceived(bytes32 indexed returnId, bytes32 indexed incidentId, uint256 amount, uint256 R, uint256 D, uint256 Q);
    event DisputeRecorded(bytes32 indexed disputeId, bytes32 indexed incidentId, uint64 challengedVersion, bytes32 decisionDigest, bytes32 reasonHash);
    event IncidentReopened(bytes32 indexed disputeId, address indexed reviewer, bytes32 reasonHash);
    event DisputeResolved(bytes32 indexed disputeId, uint64 version, bytes32 decisionDigest);
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (account == address(0)) revert InvalidInput();
        if ((role == ASSESSOR && (hasRole(CLAIM_APPROVER, account) || hasRole(SUPERVISOR, account))) ||
            (role == CLAIM_APPROVER && (hasRole(ASSESSOR, account) || hasRole(SUPERVISOR, account))) ||
            (role == SUPERVISOR && (hasRole(ASSESSOR, account) || hasRole(CLAIM_APPROVER, account))) ||
            (role == AUTO_REVIEWER && hasRole(AUTO_AUTHORIZER, account)) ||
            (role == AUTO_AUTHORIZER && hasRole(AUTO_REVIEWER, account))) revert RoleConflict();
        bool changed = super._grantRole(role, account);
        if (changed) { epochs[account]++; emit EpochChanged(account, epochs[account]); }
        return changed;
    }
    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        bool changed = super._revokeRole(role, account);
        if (changed) { epochs[account]++; emit EpochChanged(account, epochs[account]); }
        return changed;
    }
    function _pool(address pool) internal view { if (!registeredPools[pool]) revert PoolNotReady(); }
    function productKey(bytes32 id, uint64 version) internal pure returns (bytes32) { return keccak256(abi.encode(id, version)); }
    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"), keccak256("FDEInsurancePrototype"), keccak256("1"), block.chainid, address(this), deploymentId));
    }
    function _digest(bytes32 structHash) internal view returns (bytes32) { return MessageHashUtils.toTypedDataHash(domainSeparator(), structHash); }
    function _time() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert InvalidInput();
        return uint64(block.timestamp);
    }
    function _current(address who, bytes32 role, uint64 epoch, uint64 expires) internal view {
        _checkRole(role, who);
        if (epochs[who] != epoch) revert InvalidEpoch();
        if (block.timestamp >= expires) revert ExpiredAuthorization();
    }
    function _signature(bytes32 h, bytes calldata sig, address expected) internal pure { if (ECDSA.recover(h, sig) != expected) revert InvalidSignature(); }
    function _independent(address who, Policy storage p) internal view { if (who == p.quote.insured || who == p.fde) revert SelfReview(); }
    function _dependencies(Incident storage i) internal view {
        if(i.decision.channel!=0) grantRegistry.validate(policies[i.policyId].quote,i.decision,i.assessment.assessor,true,i.manualHold);
        _current(i.assessment.assessor, i.decision.channel==0?ASSESSOR:AUTO_REVIEWER, i.assessment.signerEpoch, i.assessment.expiresAt);
        _current(i.decision.approver, i.decision.channel==0?CLAIM_APPROVER:AUTO_AUTHORIZER, i.decision.signerEpoch, i.decision.expiresAt);
        if (i.supervisor.supervisor != address(0)) _current(i.supervisor.supervisor, SUPERVISOR, i.supervisor.signerEpoch, i.supervisor.expiresAt);
    }
    function ledgerHash(bytes32 policyId, bytes32 incidentId) public view returns (bytes32) {
        Policy storage p = policies[policyId]; Incident storage i = incidents[incidentId];
        return keccak256(abi.encode(policyId, incidentId, i.P, i.R, i.N, i.D, i.Q, i.version, i.revision, i.noticeSetHash, p.paidTotal, p.dueTotal, p.revision));
    }
}
