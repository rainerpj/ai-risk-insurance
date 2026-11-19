// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {CoreState} from "./CoreState.sol";
import {PolicyModule} from "./PolicyModule.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SignatureTypes as T} from "./SignatureTypes.sol";
import {PoolVault} from "./PoolVault.sol";
import {GrantRegistry} from "./GrantRegistry.sol";
import {SettlementMath} from "./SettlementMath.sol";

/// @notice Local insurance core; fixed module and one shared accounting state.
contract InsuranceCore is CoreState {
    address public immutable policyModule;
    constructor(bytes32 salt) {
        if (block.chainid != 31337 || salt == 0) revert InvalidInput();
        policyModule = address(new PolicyModule()); deploymentId = salt; grantRegistry = new GrantRegistry(address(this)); settlementMath = new SettlementMath(); _grantRole(GOVERNOR, msg.sender);
        bytes32[9] memory allRoles = [GOVERNOR, UNDERWRITER, ASSESSOR, CLAIM_APPROVER, SUPERVISOR, AUTO_REVIEWER, AUTO_AUTHORIZER, TREASURER, ANCHOR_OPERATOR];
        for (uint256 i; i < allRoles.length; i++) _setRoleAdmin(allRoles[i], GOVERNOR);
    }


    function rotateEpoch(address account) external onlyRole(GOVERNOR) { epochs[account]++; emit EpochChanged(account, epochs[account]); }
    function bindIdentity(address insured, bytes32 enterpriseId, bytes32 fdeId, address fde) external onlyRole(GOVERNOR) {
        if (insured == address(0) || fde == address(0) || enterpriseId == 0 || fdeId == 0 || identities[insured].enterpriseId != 0) revert InvalidInput();
        identities[insured] = Identity(enterpriseId, fdeId, fde);
    }

    function registerProduct(bytes32 id, uint64 version, Product calldata product) external onlyRole(GOVERNOR) {
        bytes32 key = productKey(id, version);
        if (id == 0 || version == 0 || product.termsHash == 0 || product.formulaVersion == 0 || product.settlementRuleVersion != keccak256("zero-deductible-net-v1") || product.allowedCategoriesHash != keccak256("recovery,emergency") || products[key].termsHash != 0) revert InvalidInput();
        products[key] = product; emit ProductRegistered(key);
    }
    function registerPool(address pool) external onlyRole(GOVERNOR) {
        PoolVault vault = PoolVault(pool);
        bytes32 key = keccak256(abi.encode(vault.insurerId(), address(vault.token())));
        if (vault.core() != address(this) || poolByAsset[key] != address(0)) revert InvalidInput();
        registeredPools[pool] = true; poolByAsset[key] = pool;
        emit PoolRegistered(pool, vault.insurerId(), address(vault.token()));
    }

    function sealPool(address pool) external onlyRole(GOVERNOR) nonReentrant { _pool(pool); PoolVault(pool).enable(); }
    function depositCapital(address pool, uint256 amount) external onlyRole(TREASURER) nonReentrant { _pool(pool); PoolVault(pool).deposit(msg.sender, amount); }
    function withdrawCapital(address pool, uint256 amount) external onlyRole(TREASURER) nonReentrant {
        if (actionPaused[1]) revert ChannelPaused(); _pool(pool); PoolVault(pool).withdraw(msg.sender, amount);
    }

    // OZ EIP712's default domain has no salt; encode the specified salted domain above.






    function getPolicy(bytes32 id) external view returns (Policy memory) { return policies[id]; }
    function getNotice(bytes32 id) external view returns (Notice memory) { return notices[id]; }
    function getIncident(bytes32 id) external view returns (Incident memory) { return incidents[id]; }




    function registerDecision(T.ClaimDecision calldata d, SettlementMath.Expense[2] calldata amounts, bytes32[] calldata noticeIds,
        T.Assessment calldata assessment, bytes calldata assessmentSig, bytes calldata approvalSig,
        T.SupervisorApproval calldata supervisor, bytes calldata supervisorSig) external nonReentrant {
        Policy storage p = policies[d.policyId]; Incident storage i = incidents[d.incidentId];
        if (p.issuedAt == 0 || d.incidentId == 0 || d.decisionId == 0 || usedDecisionIds[d.decisionId] || (i.policyId != 0 && i.policyId != d.policyId)) revert InvalidInput();
        if (d.version != i.version + 1 || d.previousVersion != i.version) revert StaleDecision();
        if (d.expectedLedgerHash != ledgerHash(d.policyId, d.incidentId)) revert StaleLedger();
        if (d.channel == 0) { if(d.grantId != 0 || d.grantEpoch != 0 || d.budgetVersion != 0 || d.reservationId != 0) revert ChannelPaused(); }
        else { if(msg.sender==assessment.assessor||msg.sender==d.approver)revert RoleConflict();grantRegistry.validate(p.quote,d,assessment.assessor,false,i.manualHold); }
        if (d.beneficiary != p.quote.beneficiary || d.reasonHash == 0 || d.amountsHash != keccak256(abi.encode(amounts))) revert AmountMismatch();
        if (i.version != 0 && !i.frozen) revert FreezeRequired();
        if (i.activeDispute != 0) {
            Dispute storage dispute = disputes[i.activeDispute];
            if (!dispute.reopened) revert DisputePending();
            if (d.approver == dispute.formerApprover || d.approver == dispute.formerAssessor ||
                assessment.assessor == dispute.formerApprover || assessment.assessor == dispute.formerAssessor) revert RoleConflict();
        }
        bytes32 h = _digest(T.hashClaimDecision(d));
        if (assessment.decisionContentHash != T.decisionContentHash(d) || d.assessmentHash != _digest(T.hashAssessment(assessment))) revert InvalidSignature();
        _current(assessment.assessor, d.channel==0?ASSESSOR:AUTO_REVIEWER, assessment.signerEpoch, assessment.expiresAt);
        _current(d.approver, d.channel==0?CLAIM_APPROVER:AUTO_AUTHORIZER, d.signerEpoch, d.expiresAt);
        _independent(assessment.assessor, p); _independent(d.approver, p);
        if (assessment.assessor == d.approver) revert RoleConflict();
        _signature(d.assessmentHash, assessmentSig, assessment.assessor); _signature(h, approvalSig, d.approver);
        uint256 otherOccupied = p.paidTotal + p.dueTotal - i.P - i.D;
        (uint256 approved, uint256 due, uint256 refund) = settlementMath.calculate(amounts,
            SettlementMath.Limits(i.P, i.R, otherOccupied, p.quote.incidentLimit, p.quote.annualLimit, i.D, d.netApproved, d.reviewAmount));
        if(d.channel!=0) {
            uint256 loss;for(uint256 z;z<2;z++)loss+=amounts[z].gross-amounts[z].duplicate-amounts[z].compensation-amounts[z].recovery;
            if(approved==0||approved!=loss||approved<i.N||i.activeDispute!=0)revert ChannelPaused();
        }
        if (d.reviewAmount > 50_000e6) {
            if (supervisor.supervisor == address(0) || supervisor.decisionDigest != h) revert MissingSupervisor();
            _current(supervisor.supervisor, SUPERVISOR, supervisor.signerEpoch, supervisor.expiresAt);
            _independent(supervisor.supervisor, p);
            if (supervisor.supervisor == assessment.assessor || supervisor.supervisor == d.approver) revert RoleConflict();
            _signature(_digest(T.hashSupervisorApproval(supervisor)), supervisorSig, supervisor.supervisor);
        } else if (supervisor.supervisor != address(0) || supervisorSig.length != 0) revert InvalidInput();
        if (noticeIds.length == 0 || d.noticeSetHash != keccak256(abi.encode(noticeIds))) revert NoticeConflict();
        for (uint256 j; j < noticeIds.length; j++) {
            Notice storage n = notices[noticeIds[j]];
            if ((j > 0 && noticeIds[j] <= noticeIds[j-1]) || n.data.policyId != d.policyId || n.digest == 0 ||
                (n.incidentId != 0 && n.incidentId != d.incidentId) || n.data.declaredIncidentAt > block.timestamp || n.data.declaredIncidentAt < p.quote.startAt || n.data.declaredIncidentAt >= p.quote.endAt) revert NoticeConflict();
            n.incidentId = d.incidentId;
        }
        p.dueTotal = p.dueTotal - i.D + due; p.revision++;
        if (p.paidTotal + p.dueTotal > p.quote.annualLimit || i.P + due > p.quote.incidentLimit) revert LimitExceeded();
        i.policyId = d.policyId; i.version = d.version; i.revision++; i.N = approved; i.D = due;
        i.Q = refund; i.noticeSetHash = d.noticeSetHash;
        if(i.decision.channel!=0 && d.channel==0)i.manualHold=true;
        i.decisionDigest = h; i.assessment = assessment; i.decision = d; i.supervisor = supervisor;
        usedDecisionIds[d.decisionId] = true;
        decisionHistory[d.incidentId][d.version] = h;
        if (i.activeDispute != 0) {
            disputes[i.activeDispute].resolvedVersion = d.version;
            emit DisputeResolved(i.activeDispute, d.version, h); i.activeDispute = 0;
        }
        emit DecisionRegistered(d.incidentId, d.decisionId, d.version, h, approved, due, i.Q);
    }
    function executePayment(T.PaymentAuthorization calldata pay, bytes calldata sig) external nonReentrant {
        if (actionPaused[2]) revert ChannelPaused();
        if (pay.paymentId == 0 || usedPaymentIds[pay.paymentId]) revert PaymentAlreadyExecuted();
        Incident storage i = incidents[pay.incidentId]; Policy storage p = policies[pay.policyId];
        if (i.frozen) revert PaymentFrozen();
        if (i.version == 0 || i.policyId != pay.policyId || i.version != pay.decisionVersion || i.decisionDigest != pay.decisionDigest) revert StaleDecision();
        if(i.decision.channel!=0&&(msg.sender==i.assessment.assessor||msg.sender==i.decision.approver))revert RoleConflict();
        _dependencies(i);
        _current(i.decision.approver, i.decision.channel==0?CLAIM_APPROVER:AUTO_AUTHORIZER, pay.signerEpoch, pay.expiresAt);
        _signature(_digest(T.hashPaymentAuthorization(pay)), sig, i.decision.approver);
        if (pay.token != p.quote.token || pay.beneficiary != p.quote.beneficiary) revert UnsupportedToken();
        if(i.decision.channel==0) { if(pay.grantId != 0 || pay.grantEpoch != 0 || pay.budgetVersion != 0 || pay.reservationId != 0)revert ChannelPaused(); }
        else if(pay.grantId!=i.decision.grantId||pay.grantEpoch!=i.decision.grantEpoch||pay.budgetVersion!=i.decision.budgetVersion||pay.reservationId==0)revert ChannelPaused();
        if (pay.amount == 0 || pay.amount > i.D || pay.installmentIndex != i.installmentIndex + 1) revert AmountMismatch();
        // Replacement ID is audit-only: current version, next installment and D still gate execution.
        if (pay.supersedesPaymentId == pay.paymentId) revert InvalidInput();
        usedPaymentIds[pay.paymentId] = true; i.P += pay.amount; i.D -= pay.amount; i.revision++; i.installmentIndex++;
        p.paidTotal += pay.amount; p.dueTotal -= pay.amount; p.revision++;
        PoolVault(p.quote.pool).pay(pay.beneficiary, pay.amount);
        emit PaymentExecuted(pay.paymentId, pay.incidentId, pay.amount, i.P, i.D);
    }
    function setIncidentFreeze(bytes32 id, bool frozen, bytes32 reason) external {
        if (!hasRole(GOVERNOR, msg.sender)) _checkRole(CLAIM_APPROVER, msg.sender);
        if (incidents[id].version == 0 || reason == 0) revert InvalidInput();
        if (!frozen) {
            if (incidents[id].activeDispute != 0 && disputes[incidents[id].activeDispute].reopened) revert DisputePending();
            _dependencies(incidents[id]);
        }
        incidents[id].frozen = frozen; emit IncidentFreezeChanged(id, frozen, reason);
    }
    function setActionPause(uint8 action, bool paused, bytes32 reason) external onlyRole(GOVERNOR) {
        if (action > 2 || reason == 0) revert InvalidInput();
        actionPaused[action] = paused; emit ActionPauseChanged(action, paused, reason);
    }
    function returnRecovery(bytes32 incidentId, uint256 amount, bytes32 returnId) external nonReentrant {
        Incident storage i = incidents[incidentId]; Policy storage p = policies[i.policyId];
        if (i.version == 0 || msg.sender != p.quote.insured || returnId == 0 || usedReturnIds[returnId] || amount == 0 || amount > i.Q) revert RecoveryInvalid();
        usedReturnIds[returnId] = true; i.R += amount; i.Q -= amount; i.revision++; p.revision++;
        // Q>0 implies D=0. Return never reduces historical P or releases K.
        PoolVault(p.quote.pool).receiveRecovery(msg.sender, amount);
        emit RecoveryReceived(returnId, incidentId, amount, i.R, i.D, i.Q);
    }
    function appendDispute(bytes32 incidentId, bytes32 disputeId, uint64 version, bytes32 reason) external {
        Incident storage i = incidents[incidentId];
        if (msg.sender != policies[i.policyId].quote.insured || i.version == 0 || version != i.version || reason == 0 || disputeId == 0 || disputes[disputeId].incidentId != 0 || i.activeDispute != 0) revert InvalidInput();
        disputes[disputeId] = Dispute(incidentId, version, reason, msg.sender, i.assessment.assessor, i.decision.approver, false, 0);
        i.activeDispute = disputeId; i.manualHold = true; i.revision++;
        // Appeal does not force the claimant to forfeit undisputed D.
        emit DisputeRecorded(disputeId, incidentId, version, i.decisionDigest, reason);
    }
    function reopenIncident(bytes32 disputeId, bytes32 reason) external onlyRole(CLAIM_APPROVER) {
        Dispute storage d = disputes[disputeId]; Incident storage i = incidents[d.incidentId];
        if (d.incidentId == 0 || d.reopened || d.resolvedVersion != 0 || reason == 0 || i.activeDispute != disputeId) revert InvalidInput();
        if (msg.sender == d.formerApprover || msg.sender == d.formerAssessor) revert RoleConflict();
        _independent(msg.sender, policies[i.policyId]);
        d.reopened = true; i.frozen = true; i.revision++;
        emit IncidentReopened(disputeId, msg.sender, reason);
        emit IncidentFreezeChanged(d.incidentId, true, reason);
    }
    function purchasePolicy(T.Quote calldata, bytes calldata) external returns(bytes32) { _policy(); }
    function revokeQuote(T.Quote calldata, bytes calldata, bytes32) external { _policy(); }
    function submitNotice(T.NoticeAuthorization calldata, bytes calldata) external { _policy(); }
    function _policy() private {
        address target = policyModule;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let ok := delegatecall(gas(), target, ptr, calldatasize(), 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(ok) { revert(ptr, returndatasize()) }
            return(ptr, returndatasize())
        }
    }
}
