// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract MockToken is ERC20 {
    uint8 private immutable precision;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) { precision = decimals_; }
    function decimals() public view override returns (uint8) { return precision; }
    // LOCAL synthetic asset only.
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
contract MockUSDC is MockToken { constructor() MockToken("Mock USDC", "mUSDC", 6) {} }
contract MockUSDT is MockToken { constructor() MockToken("Mock USDT", "mUSDT", 6) {} }
contract AdversarialToken is MockToken {
    uint8 public mode; // 1 false, 2 fee, 3 no movement, 4 reenter, 5 frozen transfers
    address public callback; bytes public callbackData;
    constructor() MockToken("Adversarial", "BAD", 6) {}
    function configure(uint8 mode_, address callback_, bytes calldata data_) external { mode = mode_; callback = callback_; callbackData = data_; }
    function burn(address account, uint256 amount) external { _burn(account, amount); }
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 3) return true;
        return super.transfer(to, amount);
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 3) return true;
        return super.transferFrom(from, to, amount);
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            require(mode != 5, "TOKEN_FROZEN");
            if (mode == 4) { (bool ok,) = callback.call(callbackData); require(ok, "CALLBACK_REJECTED"); }
            if (mode == 2) { super._update(from, address(0), 1); super._update(from, to, amount - 1); return; }
        }
        super._update(from, to, amount);
    }
}
