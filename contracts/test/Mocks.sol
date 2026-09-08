// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Mocks for test/run-pooled.mjs. Not for deployment — several of these are deliberately
/// hostile, which is the point: a pooled-custody contract has to survive the token and the
/// router being adversarial, because on a launch day they often are.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// An ordinary token, plus switches for the ways real launch tokens misbehave.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    uint256 public feeBps;          // fee-on-transfer: recipient receives less than sent
    bool public returnsFalse;       // transfer() returns false instead of reverting
    bool public noReturnValue;      // pre-ERC20 token with no return data at all
    address public reenter;         // call back into this address on transfer
    bytes public reenterData;

    function setFee(uint256 b) external { feeBps = b; }
    function setReturnsFalse(bool v) external { returnsFalse = v; }
    function setNoReturnValue(bool v) external { noReturnValue = v; }
    function setReenter(address a, bytes calldata d) external { reenter = a; reenterData = d; }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }

    function transfer(address to, uint256 amt) external returns (bool) {
        if (returnsFalse) return false;
        uint256 fee = (amt * feeBps) / 10_000;
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt - fee;
        if (reenter != address(0)) {
            (bool ok, ) = reenter.call(reenterData);
            ok;
        }
        if (noReturnValue) {
            assembly { return(0, 0) }
        }
        return true;
    }
}

/// A router that can be told to lie, to under-deliver, or to keep the ETH.
contract MockRouter {
    MockToken public token;
    uint256 public rate = 1000;      // tokens per ETH
    uint256 public lieMultiplier = 10_000;  // 10000 = report the truth
    bool public keepEth;
    bool public deliverNothing;

    constructor(MockToken t) { token = t; }
    function setRate(uint256 r) external { rate = r; }
    function setLie(uint256 m) external { lieMultiplier = m; }
    function setKeepEth(bool v) external { keepEth = v; }
    function setDeliverNothing(bool v) external { deliverNothing = v; }

    function swapExactETHForTokens(address, uint256, address to)
        external payable returns (uint256)
    {
        uint256 out = (msg.value * rate) / 1 ether;
        if (!deliverNothing) token.mint(to, out);
        if (!keepEth) { /* ETH stays here either way; this mock never returns change */ }
        return (out * lieMultiplier) / 10_000;
    }
}

/// A depositor that refuses ETH, to test whether one participant can wedge the round.
contract RejectingDepositor {
    function deposit(address pool) external payable {
        (bool ok, ) = pool.call{value: msg.value}(abi.encodeWithSignature("deposit()"));
        require(ok, "deposit failed");
    }
    function exitEarly(address pool) external {
        (bool ok, ) = pool.call(abi.encodeWithSignature("exitEarly()"));
        require(ok, "exit failed");
    }
    function refund(address pool) external {
        (bool ok, ) = pool.call(abi.encodeWithSignature("refund()"));
        require(ok, "refund failed");
    }
    receive() external payable { revert("no thanks"); }
}

/// A depositor that reenters on receiving ETH.
/// Reentrant on receiving ETH. Static signatures only — the test harness encodes calldata by
/// hand and does not do dynamic ABI types.
contract ReentrantDepositor {
    address public pool;
    uint256 public depth;
    uint256 public mode;   // 1 = reenter refund(), 2 = reenter exitEarly()

    function arm(address p, uint256 m) external { pool = p; mode = m; }

    function deposit() external payable {
        (bool ok, ) = pool.call{value: msg.value}(abi.encodeWithSignature("deposit()"));
        require(ok, "deposit failed");
    }
    function callRefund() external {
        (bool ok, bytes memory ret) = pool.call(abi.encodeWithSignature("refund()"));
        if (!ok) { assembly { revert(add(ret, 0x20), mload(ret)) } }
    }
    function callExit() external {
        (bool ok, bytes memory ret) = pool.call(abi.encodeWithSignature("exitEarly()"));
        if (!ok) { assembly { revert(add(ret, 0x20), mload(ret)) } }
    }
    receive() external payable {
        if (depth < 2 && mode != 0) {
            depth++;
            if (mode == 1) { (bool ok, ) = pool.call(abi.encodeWithSignature("refund()")); ok; }
            else { (bool ok, ) = pool.call(abi.encodeWithSignature("exitEarly()")); ok; }
        }
    }
}
