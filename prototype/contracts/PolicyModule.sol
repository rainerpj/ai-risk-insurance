// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {CoreState} from "./CoreState.sol";
import {SignatureTypes as T} from "./SignatureTypes.sol";
import {PoolVault} from "./PoolVault.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
/// Fixed code executed only by the Core explicit selectors. No upgrade entry point.
contract PolicyModule is CoreState {
    function purchasePolicy(T.Quote calldata q, bytes calldata sig) external nonReentrant returns (bytes32) {
        if (actionPaused[0]) revert ChannelPaused();
        if (q.quoteId == 0 || quoteUsed[q.quoteId]) revert QuoteAlreadyUsed();
        if (revokedQuoteDigest[q.quoteId] != 0) revert QuoteIsRevoked();
        address signer = ECDSA.recover(_digest(T.hashQuote(q)), sig);
        _current(signer, UNDERWRITER, q.signerEpoch, q.expiresAt);
        Identity memory identity = identities[q.insured];
        Product memory product = products[productKey(q.productId, q.productVersion)];
        _pool(q.pool);
        PoolVault vault = PoolVault(q.pool);
        if (address(vault.token()) != q.token || vault.insurerId() != q.insurerId) revert UnsupportedToken();
        if (msg.sender != q.insured || identity.enterpriseId == 0 || identity.enterpriseId != q.enterpriseId || identity.fdeId != q.fdeId ||
            q.beneficiary == address(0) || q.beneficiary == q.pool || q.startAt < block.timestamp || q.endAt <= q.startAt ||
            q.premium == 0 || q.annualLimit == 0 || q.incidentLimit == 0 || q.incidentLimit > q.annualLimit ||
            q.workflowHash == 0 || q.riskSnapshotHash == 0 || q.quoteMode > 1 || product.termsHash == 0 || product.termsHash != q.termsHash || product.formulaVersion != q.formulaVersion) revert InvalidInput();
        quoteUsed[q.quoteId] = true;
        Policy storage p = policies[q.quoteId]; p.quote = q; p.issuedAt = _time(); p.fde = identity.fde;
        vault.purchase(q.insured, q.premium, q.annualLimit);
        emit PolicyIssued(q.quoteId, q.quoteId, q.insured, q.premium, q.annualLimit);
        return q.quoteId;
    }
    function revokeQuote(T.Quote calldata q, bytes calldata sig, bytes32 reason) external {
        if (quoteUsed[q.quoteId]) revert QuoteAlreadyUsed();
        if (q.quoteId == 0 || reason == 0) revert InvalidInput();
        bytes32 h = _digest(T.hashQuote(q)); address signer = ECDSA.recover(h, sig);
        if (!hasRole(GOVERNOR, msg.sender) && (msg.sender != signer || !hasRole(UNDERWRITER, signer))) revert InvalidSignature();
        _pool(q.pool);
        if (PoolVault(q.pool).insurerId() != q.insurerId) revert InvalidInput();
        if (revokedQuoteDigest[q.quoteId] != 0) {
            if (revokedQuoteDigest[q.quoteId] != h) revert QuoteDigestConflict();
            return;
        }
        revokedQuoteDigest[q.quoteId] = h; emit QuoteRevoked(q.quoteId, h, msg.sender, reason);
    }
    function submitNotice(T.NoticeAuthorization calldata n, bytes calldata sig) external {
        Policy storage p = policies[n.policyId];
        bytes32 h = _digest(T.hashNoticeAuthorization(n));
        if (notices[n.noticeId].digest != 0) { if (notices[n.noticeId].digest != h) revert NoticeConflict(); return; }
        if (n.noticeId == 0 || p.issuedAt == 0 || n.submitter != p.quote.insured || n.incidentCommitment == 0) revert InvalidInput();
        if (epochs[n.submitter] != n.signerEpoch) revert InvalidEpoch();
        if (block.timestamp >= n.expiresAt) revert ExpiredAuthorization();
        _signature(h, sig, n.submitter);
        notices[n.noticeId] = Notice(n, h, _time(), 0);
        emit NoticeRegistered(n.noticeId, n.policyId, h, _time());
    }
}
