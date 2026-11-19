// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {SignatureTypes as T} from "./SignatureTypes.sol";
interface IGrantAuthority { function hasRole(bytes32,address) external view returns(bool); }
/// Fixed companion registry: no funds, no upgrades and no authority to alter Core debt.
contract GrantRegistry {
    IGrantAuthority public immutable core;
    struct Grant {
        bytes32 insurerId; address token; bytes32 enterpriseId; bytes32 fdeId;
        bytes32 productId; bytes32 workflowHash; bytes32 scopeHash; bytes32 riskGroupId;
        bytes32 templateId; bytes32 ruleVersion; bytes32 modelVersion;
        address reviewer; address authorizer; uint8 channel;
        uint64 budgetVersion; uint64 validFrom; uint64 validUntil; uint64 epoch;
        uint256 reviewLimit; bool enabled;
    }
    mapping(bytes32=>Grant) private grants;
    mapping(uint8=>bool) public approvalEnabled;
    mapping(uint8=>bool) public paymentEnabled;
    mapping(bytes32=>bool) public disabledVersion;
    uint64 public governanceRevision;
    mapping(bytes32=>uint256) public activeTemplateGrants;
    mapping(bytes32=>bytes32) public recoveryEvidence;
    mapping(bytes32=>bytes32) public recoveredGrantEvidence;
    mapping(bytes32=>uint64) public recoveredGrantEpoch;
    error GrantInvalid(); error GrantInactive(); error ChannelPaused(); error Unauthorized();
    event GrantChanged(bytes32 indexed grantId,uint64 epoch,uint64 budgetVersion,bool enabled);
    event ChannelChanged(uint8 channel,bool approve,bool pay,bytes32 reason);
    event VersionPaused(bytes32 indexed version,bool paused,bytes32 reason);
    event RecoveryExecuted(bytes32 indexed version,uint64 revision,bytes32 evidenceDigest);
    event RecoveryGrantConfigured(bytes32 indexed grantId,bytes32 indexed version,uint64 epoch,bytes32 evidenceDigest);
    event RecoveryChannelEnabled(bytes32 indexed grantId,uint8 channel,bool approve,bool pay,bytes32 evidenceDigest);
    constructor(address authority) { core=IGrantAuthority(authority); }
    modifier governor() { if(!core.hasRole(keccak256("GOVERNOR"),msg.sender))revert Unauthorized();_; }
    function getGrant(bytes32 id) external view returns(Grant memory) { return grants[id]; }
    function configure(bytes32 id,Grant calldata g) external governor {
        _configure(id,g);
    }
    function _configure(bytes32 id,Grant calldata g) private {
        if(id==0 || g.insurerId==0 || g.token==address(0) || g.enterpriseId==0 || g.fdeId==0 || g.productId==0 || g.workflowHash==0 ||
            g.scopeHash==0 || g.riskGroupId==0 || g.templateId==0 || g.ruleVersion==0 || g.modelVersion==0 ||
            g.reviewer==g.authorizer || g.budgetVersion==0 || g.validUntil<=g.validFrom || g.channel==0 || g.channel>2 ||
            g.reviewLimit==0 || g.reviewLimit>(g.channel==1?1_000e6:10_000e6) ||
            !core.hasRole(keccak256("AUTO_REVIEWER"),g.reviewer) || !core.hasRole(keccak256("AUTO_AUTHORIZER"),g.authorizer))revert GrantInvalid();
        if(grants[id].enabled)activeTemplateGrants[grants[id].templateId]--;
        uint64 next=grants[id].epoch+1;grants[id]=g;grants[id].epoch=next;
        if(g.enabled)activeTemplateGrants[g.templateId]++;
        governanceRevision++;
        emit GrantChanged(id,next,g.budgetVersion,g.enabled);
    }
    function revoke(bytes32 id) external governor {if(grants[id].epoch==0)revert GrantInvalid();if(grants[id].enabled)activeTemplateGrants[grants[id].templateId]--;grants[id].epoch++;grants[id].enabled=false;governanceRevision++;emit GrantChanged(id,grants[id].epoch,grants[id].budgetVersion,false);}
    function setChannel(uint8 channel,bool approve,bool pay,bytes32 reason) external governor {if(channel==0||channel>2||reason==0)revert GrantInvalid();approvalEnabled[channel]=approve;paymentEnabled[channel]=pay;governanceRevision++;emit ChannelChanged(channel,approve,pay,reason);}
    function pauseVersion(bytes32 version,bool paused,bytes32 reason) external governor {if(version==0||reason==0)revert GrantInvalid();disabledVersion[version]=paused;if(paused)delete recoveryEvidence[version];governanceRevision++;emit VersionPaused(version,paused,reason);}
    /// Guarded recovery only removes the template pause. Channels remain off and old Grants remain revoked.
    function recoverVersion(bytes32 version,uint64 expectedRevision,bytes32 evidenceDigest,bytes32 reason) external governor {
        if(version==0||reason==0||evidenceDigest==0||expectedRevision!=governanceRevision||!disabledVersion[version]||activeTemplateGrants[version]!=0)revert GrantInactive();
        if(approvalEnabled[1]||paymentEnabled[1]||approvalEnabled[2]||paymentEnabled[2])revert ChannelPaused();
        disabledVersion[version]=false;recoveryEvidence[version]=evidenceDigest;governanceRevision++;
        emit VersionPaused(version,false,reason);emit RecoveryExecuted(version,governanceRevision,evidenceDigest);
    }
    /// Re-authorize only after guarded recovery; configuring never turns a channel on.
    function configureRecovered(bytes32 id,Grant calldata g,uint64 expectedRevision,bytes32 evidenceDigest) external governor {
        if(expectedRevision!=governanceRevision||evidenceDigest==0||recoveryEvidence[g.templateId]!=evidenceDigest||
            disabledVersion[g.templateId]||disabledVersion[g.ruleVersion]||disabledVersion[g.modelVersion]||
            !g.enabled||block.timestamp<g.validFrom||block.timestamp>=g.validUntil)revert GrantInactive();
        if(approvalEnabled[1]||paymentEnabled[1]||approvalEnabled[2]||paymentEnabled[2])revert ChannelPaused();
        _configure(id,g);
        recoveredGrantEvidence[id]=evidenceDigest;recoveredGrantEpoch[id]=grants[id].epoch;
        emit RecoveryGrantConfigured(id,g.templateId,grants[id].epoch,evidenceDigest);
    }
    /// Explicit global channel permission; caller must review all Grants sharing this channel.
    function enableRecoveredChannel(bytes32 id,bool approve,bool pay,uint64 expectedRevision,bytes32 evidenceDigest,bytes32 reason) external governor {
        Grant storage g=grants[id];
        if(expectedRevision!=governanceRevision||reason==0||(!approve&&!pay)||evidenceDigest==0||
            recoveryEvidence[g.templateId]!=evidenceDigest||recoveredGrantEvidence[id]!=evidenceDigest||recoveredGrantEpoch[id]!=g.epoch||
            !g.enabled||block.timestamp<g.validFrom||block.timestamp>=g.validUntil||disabledVersion[g.templateId]||
            disabledVersion[g.ruleVersion]||disabledVersion[g.modelVersion]||
            !core.hasRole(keccak256("AUTO_REVIEWER"),g.reviewer)||!core.hasRole(keccak256("AUTO_AUTHORIZER"),g.authorizer))revert GrantInactive();
        approvalEnabled[g.channel]=approve;paymentEnabled[g.channel]=pay;governanceRevision++;
        emit ChannelChanged(g.channel,approve,pay,reason);emit RecoveryChannelEnabled(id,g.channel,approve,pay,evidenceDigest);
    }
    function validate(T.Quote calldata q,T.ClaimDecision calldata d,address reviewer,bool payment,bool manualHold) external view {
        Grant storage g=grants[d.grantId];
        if(d.channel==0||d.channel>2||(payment?!paymentEnabled[d.channel]:!approvalEnabled[d.channel]))revert ChannelPaused();
        if(!g.enabled||g.epoch!=d.grantEpoch||g.budgetVersion!=d.budgetVersion||g.channel!=d.channel||
            block.timestamp<g.validFrom||block.timestamp>=g.validUntil||manualHold||d.reservationId==0||d.reviewAmount>g.reviewLimit||
            disabledVersion[g.templateId]||disabledVersion[g.ruleVersion]||disabledVersion[g.modelVersion])revert GrantInactive();
        if(g.insurerId!=q.insurerId||g.token!=q.token||g.enterpriseId!=q.enterpriseId||g.fdeId!=q.fdeId||g.productId!=q.productId||
            g.workflowHash!=q.workflowHash||g.reviewer!=reviewer||g.authorizer!=d.approver||
            !core.hasRole(keccak256("AUTO_REVIEWER"),reviewer)||!core.hasRole(keccak256("AUTO_AUTHORIZER"),d.approver))revert GrantInvalid();
    }
}
