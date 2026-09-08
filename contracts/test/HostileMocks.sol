// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20x { function balanceOf(address) external view returns (uint256); }

/// Token whose reported balance is inflated only while the router says so, and whose real
/// balance can be shrunk after the fact (rebase / clawback / blacklist-burn).
contract TrapToken {
    mapping(address => uint256) public real;
    uint256 public phantom;          // added to balanceOf() while armed
    address public phantomFor;
    bool public armed;
    function mint(address to, uint256 a) external { real[to] += a; }
    function shrink(address who, uint256 a) external { real[who] -= a; }   // negative rebase
    function arm(address who, uint256 p) external { phantomFor = who; phantom = p; armed = true; }
    function disarm() external { armed = false; }
    function balanceOf(address a) external view returns (uint256) {
        return armed && a == phantomFor ? real[a] + phantom : real[a];
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        real[msg.sender] -= amt;      // underflows -> revert when the cupboard is bare
        real[to] += amt;
        return true;
    }
}

/// Router that returns unspent ETH as change, the way every real AMM router does.
contract ChangeRouter {
    TrapToken public token;
    uint256 public changeWei = 1;
    constructor(TrapToken t) { token = t; }
    function setChange(uint256 c) external { changeWei = c; }
    function swapExactETHForTokens(address, uint256, address to) external payable returns (uint256) {
        uint256 out = (msg.value * 1000) / 1 ether;
        token.mint(to, out);
        (bool ok, ) = msg.sender.call{value: changeWei}("");   // refund dust
        require(ok, "change refused");
        return out;
    }
}

/// Router that cooperates with a token which lies about balanceOf, defeating minOut.
contract TrapRouter {
    TrapToken public token;
    uint256 public phantomAmt;
    uint256 public realAmt;
    constructor(TrapToken t) { token = t; }
    function set(uint256 r, uint256 p) external { realAmt = r; phantomAmt = p; }
    function swapExactETHForTokens(address, uint256, address to) external payable returns (uint256) {
        token.mint(to, realAmt);
        token.arm(to, phantomAmt);       // balanceOf(pool) now reads real+phantom
        return realAmt + phantomAmt;
    }
}
