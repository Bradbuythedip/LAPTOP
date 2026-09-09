// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SnoozeDream
/// @notice $DREAM — what a wallet is paid for not selling $SNOOZE.
///
/// THE WHOLE MECHANIC, and it is deliberately not in this file. This contract mints when
/// `Snooze` tells it to and does nothing else. The clock, the ramp, the reset on an outbound
/// transfer and the arithmetic that turns held-seconds into an amount all live inside
/// `Snooze` itself, because the alternative — an external contract watching balances — cannot
/// see a sale it was not told about, and anything that notifies it can fail. A hook wrapped in
/// try/catch fails OPEN: the sale happens, the notice is dropped, and the streak survives a
/// sale it should not have survived. There is no gas limit at which that stops being true.
///
/// So `Snooze._move` does the bookkeeping in its own storage, with no external call, and this
/// contract is the smallest thing that can be on the other end of it: one minter, fixed at
/// construction, and no other way to create a token.
///
/// WHAT "EQUIVALENT TOKEN" MEANS, precisely. DREAM has nine decimals, the same as SNOOZE, and
/// the ramp is set so that a wallet holding one SNOOZE for the full 90-day ramp without
/// sending anything out has accrued exactly one DREAM. One for one, same units, same
/// magnitude. It is equivalent in COUNT. It is not equivalent in price and this contract
/// cannot make it so — see the disclaimers below, which are here rather than only on the site
/// because a block explorer is where somebody checks.
///
/// WHAT THIS TOKEN IS NOT:
///
///   - NOT capped. Emission continues for as long as anybody holds SNOOZE without selling:
///     linearly, at two DREAM per SNOOZE per 90 days, forever after the ramp. Anybody
///     describing DREAM as scarce is describing a different token. `totalSupply` only rises.
///
///   - NOT backed. No ETH, no treasury, no redemption. There is no pool here and this
///     contract has no ETH balance and no way to acquire one.
///
///   - NOT a claim on SNOOZE. Holding DREAM entitles you to nothing from the curve, the pool,
///     the fees or the launcher.
///
///   - NOT rebasing, and NOT reset. Once minted it is an ordinary balance. Selling your SNOOZE
///     afterwards costs you the streak that was earning more DREAM; it does not touch the
///     DREAM you already hold.
///
/// WHAT IT DOES DO: it is the only thing in this launch that pays a holder for the one
/// behaviour every other mechanism here can only discourage. Snooze Rule 2 caps a sale at
/// 20%/day and Rule 1 taxes selling into strength — both are frictions on leaving. This is the
/// only one pointed the other way.
contract SnoozeDream {
    string public constant name = "Snooze Dream";
    string public constant symbol = "DREAM";
    /// NINE, matching Snooze, and that is the whole reason for the number. The ramp pays one
    /// DREAM base unit per SNOOZE base unit held for the ramp, so if the decimals differed the
    /// headline "one for one" would be off by a factor of a billion in one direction or the
    /// other and every screenshot of it would be wrong.
    uint8 public constant decimals = 9;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// The Snooze token, and the only address that may ever mint. Immutable: a settable minter
    /// is an unlimited supply held by whoever holds the key, which is the thing every "reward
    /// token" is suspected of and most of them are.
    address public immutable minter;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotMinter();
    error BadConfig();

    constructor(address _minter) {
        if (_minter == address(0)) revert BadConfig();
        minter = _minter;
    }

    /// @notice Called by `Snooze.claimDream()` and by nothing else.
    /// @dev No cap and no per-call limit, because the limit is upstream and is real: the amount
    ///      is `Snooze.dreamOwed[who]`, which only that contract's own held-seconds arithmetic
    ///      can raise and which is zeroed in the same transaction it is paid.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Burn your own. Nobody else can burn yours — there is no burnFrom and no
    ///         allowance path to one, so a DREAM balance cannot be taken back by the launcher,
    ///         by the minter, or by anybody holding an approval on it.
    function burn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 v) external returns (bool) {
        allowance[msg.sender][spender] = v;
        emit Approval(msg.sender, spender, v);
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address from, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            require(a >= v, "allowance");
            allowance[from][msg.sender] = a - v;
        }
        _move(from, to, v);
        return true;
    }

    /// @dev No rules. DREAM has no haircut, no daily cap, no pool registry and no admin —
    ///      every one of those exists on SNOOZE to slow an exit, and slowing the exit from a
    ///      reward you were given for waiting would make the reward a second lock-up.
    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");
        balanceOf[from] -= v;
        balanceOf[to] += v;
        emit Transfer(from, to, v);
    }
}
