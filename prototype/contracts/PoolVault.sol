// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
contract PoolVault {
    using SafeERC20 for IERC20;
    address public immutable core;
    IERC20 public immutable token;
    bytes32 public immutable insurerId;
    uint256 public immutable B;
    uint256 public H;
    uint256 public K;
    uint256 public classifiedAssets;
    bool public enabled;
    mapping(address => uint256) public capitalOf;
    error OnlyCore(); error InvalidPool(); error BalanceDeficit(); error TransferMismatch();
    error InsufficientCapacity(); error InsufficientCapital();
    event CapitalDeposited(address indexed owner, uint256 amount);
    event CapitalWithdrawn(address indexed owner, uint256 amount);
    event PoolChanged(uint256 A, uint256 H, uint256 K, uint256 U, uint256 W);
    modifier onlyCore() { if (msg.sender != core) revert OnlyCore(); _; }
    constructor(address core_, address token_, bytes32 insurer_, uint256 buffer_) {
        if (core_ == address(0) || insurer_ == 0 || buffer_ == 0 || IERC20Metadata(token_).decimals() != 6) revert InvalidPool();
        core = core_; token = IERC20(token_); insurerId = insurer_; B = buffer_;
    }
    function balances() public view returns (uint256 A, uint256 U, uint256 W) {
        A = token.balanceOf(address(this));
        if (A < classifiedAssets) revert BalanceDeficit();
        U = A - classifiedAssets;
        uint256 restricted = H + K + B + U;
        W = A > restricted ? A - restricted : 0;
    }
    function _check() private {
        (uint256 A, uint256 U, uint256 W) = balances();
        if (enabled && A < H + K + B + U) revert InsufficientCapacity();
        emit PoolChanged(A, H, K, U, W);
    }
    function enable() external onlyCore {
        if (enabled || classifiedAssets < H + K + B) revert InvalidPool();
        enabled = true; _check();
    }
    function _in(address from, uint256 amount) private {
        if (amount == 0 || from == address(this)) revert TransferMismatch();
        (uint256 beforeBalance,,) = balances();
        uint256 fromBefore = token.balanceOf(from);
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount || token.balanceOf(from) + amount != fromBefore) revert TransferMismatch();
        classifiedAssets += amount;
    }
    function _out(address to, uint256 amount) private {
        if (amount == 0 || to == address(0) || to == address(this)) revert TransferMismatch();
        (uint256 beforeBalance,,) = balances();
        uint256 recipientBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        if (token.balanceOf(address(this)) + amount != beforeBalance || token.balanceOf(to) != recipientBefore + amount) revert TransferMismatch();
        classifiedAssets -= amount;
    }
    function deposit(address owner, uint256 amount) external onlyCore {
        _in(owner, amount); capitalOf[owner] += amount; _check(); emit CapitalDeposited(owner, amount);
    }
    function withdraw(address owner, uint256 amount) external onlyCore {
        (,,uint256 W) = balances();
        if (amount > W || amount > capitalOf[owner]) revert InsufficientCapital();
        capitalOf[owner] -= amount; _out(owner, amount); _check(); emit CapitalWithdrawn(owner, amount);
    }
    function purchase(address insured, uint256 premium, uint256 limit) external onlyCore {
        (,,uint256 W) = balances();
        if (!enabled || limit > W) revert InsufficientCapacity();
        _in(insured, premium); H += premium; K += limit; _check();
    }
    function pay(address beneficiary, uint256 amount) external onlyCore {
        if (!enabled || amount > K) revert InsufficientCapacity();
        K -= amount; _out(beneficiary, amount); _check();
    }
    function receiveRecovery(address insured, uint256 amount) external onlyCore {
        _in(insured, amount); H += amount; _check();
    }
}
