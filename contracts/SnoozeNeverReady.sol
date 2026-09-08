// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SnoozeNeverReady
/// @notice An oracle that answers every call, never reverts, and is never ready. On purpose.
///
/// WHY THIS EXISTS. Snooze takes an ITwapOracle in its constructor and the address is immutable,
/// and there is no observational oracle in this repository — only the settable mock in
/// contracts/test/, which must never reach Base. So a launch had a choice between an oracle
/// nobody had built and one nobody should deploy, and in practice that is not a choice.
///
/// WHAT IT MEANS, and it belongs on the front of anything that ships against it: RULE 1 NEVER
/// FIRES. `ready()` is false forever, so `burnBps()` returns 0 forever, so no sale is ever
/// haircut, at any price, on any day. $SNOOZE against this oracle is an ordinary ERC-20 with a
/// 20%/day cap on selling into the registered curve, and nothing else. That is a legitimate
/// launch and it is a smaller claim than the one Rule 1 makes; the site must not make the
/// larger one.
///
/// WHY IT IS SAFE IN THE WAY THE OTHER TWO ARE NOT:
///
///   - It cannot be a burn dial. There is no storage, no owner, no constructor argument and no
///     function that writes anything. Every function is `pure`, so the compiler itself refuses
///     a version of this file that could change its answers. `MockOracle` is the same shape
///     with a `set()` on it, and that one function is the whole difference between an oracle
///     and an admin key.
///   - It cannot be a honeypot. `ready()` runs inside every sell. This one returns a constant,
///     so a sell can never revert on it — which is the failure that cannot be fixed afterwards,
///     because the address is immutable on the token.
///   - There is no fallback and no receive, so a call to a function it does not have reverts
///     rather than returning empty. An address that answers everything with 0x is the one shape
///     that reads as working while being absent.
///
/// UPGRADING LATER IS NOT POSSIBLE, and that is the trade. If you want Rule 1 to work you need
/// a real observation on Base BEFORE the token exists, because the token can never be repointed
/// at one. See LAUNCH.md 2.1 for what a real one has to satisfy.
///
/// `spot()` and `twap24()` return the same non-zero value. Only their ratio is ever used, and
/// equal means "no premium over the average", which is the reading that produces a zero burn
/// even in the branch of `burnBps()` that runs before the `ready()` check is consulted.
contract SnoozeNeverReady {
    /// @return false, always. Rule 1 is off and stays off.
    function ready() external pure returns (bool) { return false; }

    /// @return a constant, equal to twap24(). Never zero: `burnBps()` divides by spot.
    function spot() external pure returns (uint256) { return 1e18; }

    /// @return the same constant. spot == twap is a zero premium, hence a zero haircut.
    function twap24() external pure returns (uint256) { return 1e18; }
}
