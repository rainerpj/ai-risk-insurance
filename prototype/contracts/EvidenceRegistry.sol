// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
interface IEvidenceAuthority { function hasRole(bytes32 role, address account) external view returns (bool); }
/// @notice Only opaque commitments are public. This contract cannot approve a claim.
contract EvidenceRegistry {
    IEvidenceAuthority public immutable authority;
    bytes32 public constant PROTOCOL = keccak256("FDE-EVIDENCE-v1");
    struct Batch { bytes32 root; uint64 size; bytes32 protocol; address submitter; uint64 anchoredAt; }
    mapping(bytes32 => Batch) public batches;
    bool public paused;
    error Unauthorized(); error InvalidBatch(); error BatchConflict(); error Paused();
    event EvidenceAnchored(bytes32 indexed batchId, bytes32 root, uint64 size, bytes32 protocol, address indexed submitter);
    event EvidencePauseChanged(bool paused, bytes32 reasonHash);
    constructor(address core) { require(core.code.length != 0, "INVALID_CORE"); authority = IEvidenceAuthority(core); }
    function anchorBatch(bytes32 batchId, bytes32 root, uint64 size, bytes32 protocol) external {
        if (!authority.hasRole(keccak256("ANCHOR_OPERATOR"), msg.sender)) revert Unauthorized();
        if (paused) revert Paused();
        if (batchId == 0 || root == 0 || size == 0 || size > 10000 || protocol != PROTOCOL || block.timestamp > type(uint64).max) revert InvalidBatch();
        Batch storage old = batches[batchId];
        if (old.size != 0) { if (old.root != root || old.size != size || old.protocol != protocol) revert BatchConflict(); return; }
        batches[batchId] = Batch(root, size, protocol, msg.sender, uint64(block.timestamp));
        emit EvidenceAnchored(batchId, root, size, protocol, msg.sender);
    }
    function setPaused(bool value, bytes32 reason) external {
        if (!authority.hasRole(keccak256("GOVERNOR"), msg.sender)) revert Unauthorized();
        if (reason == 0) revert InvalidBatch(); paused = value; emit EvidencePauseChanged(value, reason);
    }
}
