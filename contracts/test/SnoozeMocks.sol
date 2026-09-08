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
