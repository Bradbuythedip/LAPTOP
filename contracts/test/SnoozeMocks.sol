// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Settable price feed for test/run-snooze.mjs. Not for deployment: a real one has to be a
/// pool observation, and the difference between "settable" and "observed" is the whole
/// oracle-manipulation surface.
contract MockOracle {
    uint256 public spot;
    uint256 public twap24;
    bool public ready;
    function set(uint256 s, uint256 t, bool r) external { spot = s; twap24 = t; ready = r; }
}

interface ISnoozeMin { function transfer(address,uint256) external returns (bool); }

/// Stands in for the AMM in the wiring test: takes ETH, hands over Snooze from a float it
/// holds. A real pool would price along a curve; this one is linear, because the wiring test
/// is about whether the two contracts compose, not about price discovery.
contract SnoozeRouter {
    ISnoozeMin public immutable token;
    uint256 public rate = 1_000_000;      // token base units per wei
    constructor(ISnoozeMin t) { token = t; }
    function setRate(uint256 r) external { rate = r; }
    function swapExactETHForTokens(address, uint256 minOut, address to)
        external payable returns (uint256)
    {
        uint256 out = msg.value * rate;
        require(out >= minOut, "minOut");
        token.transfer(to, out);
        return out;
    }
}
