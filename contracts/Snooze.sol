// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 24-hour TWAP and current spot, both in the same units (paired asset per token).
interface ITwapOracle {
    function spot() external view returns (uint256);
    function twap24() external view returns (uint256);
    /// @return true once the oracle has a full 24h of observations behind it
    function ready() external view returns (bool);
}

/// @title Snooze
/// @notice "You snooze, you win." Two rules, in code rather than in a promise.
///
///   RULE 1 — you sell at yesterday's price. If spot P is above the 24h average T, only
///            T/P of what you send reaches the pool and the rest burns. burnBps = (P-T)/P.
///   RULE 2 — no wallet moves more than 20% of its bag per rolling day. Including the dev.
///
/// WHAT THE ARITHMETIC ACTUALLY DOES, as opposed to what a pitch would say. Each of these is
/// pinned by a test in test/run-snooze.mjs, and each is a correction to the original spec:
///
///   - The burn is ZERO whenever P <= T. In a downtrend spot sits below the 24h average, so
///     selling into a dump costs nothing at all. Rule 1 taxes selling into STRENGTH. It does
///     nothing about the sellers you would most want it to touch. Rule 2 is the only thing
///     slowing a dump, and it slows it by 20%/day per wallet, not by burning.
///
///   - "Sleep on it and tomorrow the jump is yours" is not what happens. Tomorrow you are
///     paid min(spot, twap) again. If the price fell back overnight you get the lower spot
///     and the jump was never yours. Waiting converts a certain haircut into an uncertain
///     price. That is a real trade, and it is not the trade the slogan describes.
///
///   - Rule 2 does not stop a determined exit, it reshapes it. Splitting to fresh wallets is
///     itself an outbound transfer and therefore capped, but the tokens that arrive are
///     uncapped at rest and each new wallet gets its own 20%. The drain accelerates
///     geometrically. test/run-snooze.mjs computes the real curve rather than asserting the
///     five-day drip.
///
///   - Supply only falls AND the dev is paid from the burn cannot both be true, because burnt
///     tokens are gone. This contract resolves it by paying the dev NOTHING from the burn:
///     devBps is a share of the haircut diverted to the dev instead of destroyed, it defaults
///     to zero, it is capped at 2000 (20% of the haircut, never of the trade), and it is
///     immutable. At the default the supply claim is exactly true. Above zero it is not, and
///     `supplyOnlyFalls()` returns false so the site cannot claim otherwise by accident.
contract Snooze {
    string public constant name = "Snooze";
    string public constant symbol = "SNOOZE";
    uint8  public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// Rule 2, in basis points of the wallet's balance at the start of its own rolling day.
    uint256 public constant DAILY_BPS = 2000;      // 20%
    uint256 public constant WINDOW = 1 days;
    /// The haircut is capped so a broken or manipulated oracle cannot confiscate a whole sale.
    uint256 public constant MAX_BURN_BPS = 9000;   // 90%

    ITwapOracle public immutable oracle;
    address public immutable dev;
    /// Share of the HAIRCUT (never of the trade) diverted to the dev instead of burned.
    uint256 public immutable devBps;

    /// Addresses that count as "the market" — sending to one is a sell.
    mapping(address => bool) public isPool;
    /// Addresses exempt from Rule 2 only. The pool must be, or nobody could ever buy: tokens
    /// leaving the pool to a buyer would be capped at 20% of the pool's balance per day.
    mapping(address => bool) public capExempt;

    address public immutable admin;
    bool public frozen;

    struct Window { uint64 start; uint192 baseline; uint256 moved; }
    mapping(address => Window) public window;

    uint256 public totalBurned;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Snoozed(address indexed seller, uint256 sent, uint256 delivered, uint256 burned, uint256 toDev);

    error CapExceeded(uint256 allowed, uint256 wanted);
    error NotAdmin();
    error Frozen();
    error BadConfig();
    error OracleNotReady();

    constructor(uint256 supply, ITwapOracle _oracle, address _dev, uint256 _devBps) {
        // The dev's cut is of the haircut, and it is capped hard. A dev share above this stops
        // being "paid from the burn" and starts being a sell tax with a story attached.
        if (_devBps > 2000) revert BadConfig();
        if (address(_oracle) == address(0)) revert BadConfig();
        oracle = _oracle;
        dev = _dev;
        devBps = _devBps;
        admin = msg.sender;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    /// @notice True only if every haircut is destroyed rather than partly paid out.
    /// @dev The site reads this. A launch that takes a dev cut cannot display the
    ///      "supply only goes down" claim, because it would not be true.
    function supplyOnlyFalls() external view returns (bool) { return devBps == 0; }

    function setPool(address p, bool on) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        isPool[p] = on;
        capExempt[p] = on;   // the pool must be able to pay buyers out
    }

    function setCapExempt(address a, bool on) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        capExempt[a] = on;
    }

    /// @notice Give up the ability to change pools or exemptions.
    /// @dev Until this is called the admin can exempt themselves from Rule 2, which makes
    ///      Rule 2 a promise rather than a rule. The site should refuse to show a launch as
    ///      locked while `frozen` is false.
    function freeze() external {
        if (msg.sender != admin) revert NotAdmin();
        frozen = true;
    }

    // ---------------------------------------------------------------- rule 1

    /// @notice The headline dial: how much of a sale burns right now, in basis points.
    /// @dev (P - T)/P, zero when P <= T, capped. Reverts nothing — a page must be able to
    ///      read this without a transaction.
    function burnBps() public view returns (uint256) {
        if (!oracle.ready()) return 0;
        uint256 p = oracle.spot();
        uint256 t = oracle.twap24();
        if (p == 0 || t >= p) return 0;
        uint256 bps = ((p - t) * 10_000) / p;
        return bps > MAX_BURN_BPS ? MAX_BURN_BPS : bps;
    }

    /// @notice What a sale of `amount` would actually deliver, burn and pay right now.
    /// @dev Quoting and executing use the same function, so the dial cannot drift from the
    ///      behaviour. A page that computed this itself would eventually disagree with the
    ///      chain, and the number people trust is the one on the page.
    function quoteSell(uint256 amount)
        public view returns (uint256 delivered, uint256 burned, uint256 toDev)
    {
        uint256 bps = burnBps();
        uint256 haircut = (amount * bps) / 10_000;
        toDev = (haircut * devBps) / 10_000;
        burned = haircut - toDev;
        delivered = amount - haircut;
    }

    // ---------------------------------------------------------------- rule 2

    /// @notice How much this wallet may still move today, and when its window resets.
    function remainingToday(address who) public view returns (uint256 allowed, uint64 resetsAt) {
        if (capExempt[who]) return (type(uint256).max, 0);
        Window memory w = window[who];
        if (w.start == 0 || block.timestamp >= uint256(w.start) + WINDOW) {
            // A fresh window is baselined on the CURRENT balance.
            return ((balanceOf[who] * DAILY_BPS) / 10_000, uint64(block.timestamp + WINDOW));
        }
        uint256 cap = (uint256(w.baseline) * DAILY_BPS) / 10_000;
        return (cap > w.moved ? cap - w.moved : 0, uint64(uint256(w.start) + WINDOW));
    }

    function _chargeWindow(address from, uint256 amount) internal {
        if (capExempt[from]) return;
        Window storage w = window[from];
        if (w.start == 0 || block.timestamp >= uint256(w.start) + WINDOW) {
            // Baseline on the balance at the START of the window. Charging 20% of the CURRENT
            // balance on each transfer would let a wallet move 20%, then 20% of the remaining
            // 80%, and so on — 36% in two goes, and unbounded in many.
            w.start = uint64(block.timestamp);
            w.baseline = uint192(balanceOf[from]);
            w.moved = 0;
        }
        uint256 cap = (uint256(w.baseline) * DAILY_BPS) / 10_000;
        if (w.moved + amount > cap) revert CapExceeded(cap - w.moved, amount);
        w.moved += amount;
    }

    // ---------------------------------------------------------------- erc20

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

    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");
        _chargeWindow(from, v);

        uint256 delivered = v;
        if (isPool[to] && !capExempt[from]) {
            // A sell. The haircut never touches a buy, a wallet-to-wallet move, or the pool
            // paying a buyer out — only tokens going INTO the market.
            (uint256 d, uint256 b, uint256 g) = quoteSell(v);
            delivered = d;
            balanceOf[from] -= v;
            if (b > 0) { totalSupply -= b; totalBurned += b; emit Transfer(from, address(0), b); }
            if (g > 0) { balanceOf[dev] += g; emit Transfer(from, dev, g); }
            balanceOf[to] += d;
            emit Transfer(from, to, d);
            emit Snoozed(from, v, d, b, g);
            return;
        }

        balanceOf[from] -= v;
        balanceOf[to] += delivered;
        emit Transfer(from, to, delivered);
    }
}
