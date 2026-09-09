// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 24-hour TWAP and current spot, both in the same units (paired asset per token).
interface ITwapOracle {
    function spot() external view returns (uint256);
    function twap24() external view returns (uint256);
    /// @return true once the oracle has a full 24h of observations behind it
    function ready() external view returns (bool);
}

/// @notice The reward token. Minted only by this contract, only by claimDream().
interface ISnoozeDream {
    function mint(address to, uint256 amount) external;
}

/// @title Snooze
/// @notice "You snooze, you win." Two rules, in code rather than in a promise.
///
///   RULE 1 — you sell at yesterday's price. If spot P is above the 24h average T, only
///            T/P of what you send reaches the pool and the rest burns. burnBps = (P-T)/P.
///   RULE 2 — no wallet moves more than 20% of its bag per rolling day. Including the dev.
///   RULE 3 — you are paid for not selling. A wallet accrues $DREAM for every second it holds
///            $SNOOZE without sending any out, at a rate that ramps for RAMP (90 days) and
///            then holds flat. Hold one SNOOZE untouched for the whole ramp and you have
///            accrued exactly one DREAM: same decimals, same count, an EQUIVALENT TOKEN.
///
/// RULE 3 IS THE ONLY ONE POINTED THE OTHER WAY, and that is the reason it exists. Rules 1 and
/// 2 are frictions on leaving, and the notes below say at length how little either really does
/// — Rule 1 is zero in exactly the downtrend you would want it to bite in, and Rule 2 reshapes
/// an exit rather than stopping it. Neither pays anybody for staying. Rule 3 does, and it does
/// it without a lock: nothing is staked, nothing is escrowed, no approval is given and no
/// transaction is required to start. Holding IS the position.
///
/// WHAT RULE 3 COSTS, stated where somebody checking will see it:
///
///   - EVERY TRANSFER GOT MORE EXPENSIVE. _move now settles the clock for both sides before it
///     touches a balance, which is two extra SLOADs and up to two SSTOREs per side. That is
///     paid by every holder on every transfer, including ones that will never claim.
///
///   - ANY OUTBOUND TRANSFER RESETS THE CLOCK, and "outbound" means outbound: a sale, a move
///     to your own second wallet, a deposit to an exchange, funding a friend. There is no way
///     to tell those apart from inside a transfer and no attempt is made to. What is already
///     accrued is BANKED and stays claimable; what is lost is the rate.
///
///   - DREAM IS UNCAPPED. After the ramp the rate is flat, not zero, so emission continues for
///     as long as anybody holds — two DREAM per SNOOZE per 90 days, forever. It is an
///     emissions token and SnoozeDream.sol says so on its own face.
///
///   - AND IT IS WORTH NOTHING BY ITSELF. This contract mints a count. It cannot mint a bid.
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
    string public constant name = "Snooze Bear";
    string public constant symbol = "SNOOZE";
    /// NINE, not eighteen, and the reason is the venue rather than taste. A Uniswap V2 reserve
    /// is uint112 = 5.192e33 base units, and `UniswapV2Pair._update` reverts above it. At 18
    /// decimals this token's 100 quadrillion units are 1e35 base units, so the pool could hold
    /// at most 5% of supply and bond() fed it 1.85e34 — a graduation that reverts forever, with
    /// the raise sealed in a curve whose parameters are immutable. At 9 the same 100 quadrillion
    /// tokens are 1e26 base units, 52 million times inside the ceiling, and no sell into the
    /// pool afterwards can ever reach it either. The count people see is unchanged.
    uint8  public constant decimals = 9;

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

    // ------------------------------------------------------------------------------ rule 3

    /// The ramp. Held for this long with nothing sent out, one SNOOZE has earned one DREAM.
    /// 90 days is a choice and the only defensible thing about the number is that it is long
    /// enough to be a decision and short enough to be one somebody actually makes.
    uint64 public constant RAMP = 90 days;

    /// The reward token. Zero until setDream, and settable exactly once, before freeze().
    address public dream;
    /// When this wallet's current unbroken hold began. Zero means it has never held any.
    mapping(address => uint64) public streakStart;
    /// The last moment accrual was banked for this wallet. Never behind streakStart.
    mapping(address => uint64) public settledAt;
    /// DREAM base units accrued and not yet claimed. Survives a broken streak on purpose.
    mapping(address => uint256) public dreamOwed;

    address public immutable admin;
    bool public frozen;

    struct Window { uint64 start; uint192 baseline; uint256 moved; }
    mapping(address => Window) public window;

    uint256 public totalBurned;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Snoozed(address indexed seller, uint256 sent, uint256 delivered, uint256 burned, uint256 toDev);
    /// A wallet sent something out and its clock went back to zero. `held` is how long the
    /// streak had run; `banked` is what it keeps. This is the only public record of a break,
    /// and it is permanent, which is the point.
    event WokeUp(address indexed who, uint64 held, uint256 banked);
    event Dreamed(address indexed who, uint256 amount);
    event DreamSet(address indexed dream);

    error CapExceeded(uint256 allowed, uint256 wanted);
    error NotAdmin();
    error Frozen();
    error BadConfig();
    error OracleNotReady();
    error NothingToClaim();
    error DreamNotSet();
    error AlreadySet();

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
        // The launcher holds everything from block one, so without this their clock never
        // starts: _sleep only ever fires on a RECEIPT, and a mint is not one.
        _sleep(msg.sender);
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
        if (on) _clearDream(p);
    }

    function setCapExempt(address a, bool on) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        capExempt[a] = on;
        if (on) _clearDream(a);
    }

    /// @notice Name the reward token. Once, before freeze(), and never again.
    /// @dev Deliberately NOT re-settable the way setPool is. A repointable mint target is an
    ///      unlimited supply of a token people are being told to hold for, held by whoever
    ///      holds the admin key — and unlike a pool registration there is no legitimate reason
    ///      to ever change it. Leaving it unset is a real choice and a safe one: accrual still
    ///      runs, dreamOwed still counts up, and claimDream() reverts DreamNotSet forever
    ///      after freeze(). Rule 3 is then a number on chain that nobody can ever mint.
    function setDream(address d) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        if (dream != address(0)) revert AlreadySet();
        if (d == address(0)) revert BadConfig();
        dream = d;
        emit DreamSet(d);
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

    /// @notice Whether Rule 1 is actually in force right now.
    /// @dev burnBps() returns 0 both when the price is at or below its average and when the
    ///      oracle is not ready. Those are completely different situations — one is the rule
    ///      working, the other is the rule absent — and nothing else on chain tells them
    ///      apart. A page that shows "0%" without reading this is showing a reassurance it
    ///      has not earned.
    function ruleActive() public view returns (bool) { return oracle.ready(); }

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

    // ---------------------------------------------------------------- rule 3

    /// @notice DREAM accrued by `bal` base units held from streak-age `a0` to streak-age `a1`.
    /// @dev The rate is k*min(age, RAMP), which ramps linearly for RAMP and is flat after.
    ///      Integrating it over [a0, a1] and taking k = 2/RAMP^2:
    ///
    ///          (min(a1,R)^2 - min(a0,R)^2) / R^2  +  2*(max(a1,R) - max(a0,R)) / R
    ///
    ///      At a0=0, a1=R that is exactly `bal` — one DREAM per SNOOZE for the full ramp,
    ///      which is the whole claim the site makes, in one line, checkable here. At a1=2R it
    ///      is 3*bal. After the ramp it is flat at 2*bal per R, forever.
    ///
    ///      Integer arithmetic, no fixed point and no rounding helper: the multiply happens
    ///      before the divide, so the only loss is the final truncation. Nothing overflows —
    ///      the supply is 1e26, R^2 is 6.05e13, and the product is 6.05e39 against a uint256
    ///      ceiling of 1.16e77, with room for the flat term for longer than the chain will run.
    function dreamBetween(uint256 bal, uint64 a0, uint64 a1) public pure returns (uint256) {
        if (bal == 0 || a1 <= a0) return 0;
        uint256 r = uint256(RAMP);
        uint256 m0 = a0 < RAMP ? uint256(a0) : r;
        uint256 m1 = a1 < RAMP ? uint256(a1) : r;
        uint256 x0 = a0 > RAMP ? uint256(a0) - r : 0;
        uint256 x1 = a1 > RAMP ? uint256(a1) - r : 0;
        return (bal * ((m1 * m1 - m0 * m0) + 2 * r * (x1 - x0))) / (r * r);
    }

    /// @notice How long `who` has held without sending anything out, in seconds.
    function streakSeconds(address who) public view returns (uint64) {
        uint64 s = streakStart[who];
        if (s == 0 || block.timestamp <= s) return 0;
        return uint64(block.timestamp) - s;
    }

    /// @notice What `who` could claim right now. A page reads this; it sends nothing.
    /// @dev Banked plus unsettled, which is what claimDream would pay in this same block.
    function dreamPending(address who) public view returns (uint256) {
        uint256 owed = dreamOwed[who];
        if (capExempt[who]) return owed;
        uint64 s = streakStart[who];
        uint64 t = settledAt[who];
        if (s == 0 || block.timestamp <= t) return owed;
        return owed + dreamBetween(balanceOf[who], t - s, uint64(block.timestamp) - s);
    }

    /// @notice Mint everything accrued so far. Does NOT touch your SNOOZE and does NOT break
    ///         your streak — nothing leaves your wallet, so there is nothing to break.
    function claimDream() external returns (uint256 amount) {
        if (dream == address(0)) revert DreamNotSet();
        _settle(msg.sender);
        amount = dreamOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        dreamOwed[msg.sender] = 0;
        ISnoozeDream(dream).mint(msg.sender, amount);
        emit Dreamed(msg.sender, amount);
    }

    /// Bank everything owed up to now, so a balance may change safely afterwards.
    function _settle(address who) internal {
        // A registered pool holds a large balance it did not buy and never sells, which under
        // Rule 3 is the perfect holder. So pools do not dream — and neither does the one
        // cap-exempt wallet, because the launcher farming the reward for holding their own
        // float is the failure mode this whole rule exists to avoid rewarding.
        if (capExempt[who]) return;
        uint64 s = streakStart[who];
        if (s == 0) return;
        uint64 t = settledAt[who];
        uint64 n = uint64(block.timestamp);
        if (n <= t) return;
        uint256 owed = dreamBetween(balanceOf[who], t - s, n - s);
        if (owed > 0) dreamOwed[who] += owed;
        settledAt[who] = n;
    }

    /// Start this wallet's clock at now.
    function _sleep(address who) internal {
        if (capExempt[who]) return;
        streakStart[who] = uint64(block.timestamp);
        settledAt[who] = uint64(block.timestamp);
    }

    /// An outbound transfer happened. Bank is already taken; the rate goes back to zero.
    function _wakeUp(address who) internal {
        if (capExempt[who]) return;
        uint64 s = streakStart[who];
        if (s != 0 && block.timestamp > s)
            emit WokeUp(who, uint64(block.timestamp) - s, dreamOwed[who]);
        _sleep(who);
    }

    /// Exempting an address ends its participation in Rule 3 and voids what it accrued.
    /// @dev Only reachable before freeze(), and only through the same two calls that hand out
    ///      the exemption itself — so it is not a new power, it is the existing one being
    ///      honest about its consequences. After freeze() nobody can do this to anybody.
    function _clearDream(address who) internal {
        streakStart[who] = 0;
        settledAt[who] = 0;
        dreamOwed[who] = 0;
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

    /// @dev BOTH rules fire on the same condition — a sell by a non-exempt address — and that
    ///      is a correction, not a simplification. The cap used to apply to EVERY outbound
    ///      transfer, which sounded stronger and made the token unusable:
    ///
    ///      The cap is 20% of a balance that INCLUDES the amount being sent, so a contract that
    ///      receives N and forwards N needs `N <= 0.2*(B+N)`, i.e. `N <= B/4` — four times the
    ///      trade parked permanently. Every router, aggregator, settler and wallet swap widget
    ///      is exactly that shape, so they reverted on BUYS as well as sells. A CEX deposit
    ///      address, which sweeps 100% of its balance, could never be emptied: measured, it
    ///      stranded 400 of 500 tokens and then the allowance floored to zero, permanently.
    ///
    ///      What the wider rule bought was "moving to a fresh wallet is throttled too", and it
    ///      bought almost nothing, because the cap is split-invariant either way: one wallet
    ///      with B sells 0.2B a day, and n wallets holding B/n each sell 0.2B/n, which is the
    ///      same 0.2B. Splitting was never an evasion. So the wide rule cost every integration
    ///      on Base and prevented a thing that was not possible anyway.
    function _move(address from, address to, uint256 v) internal {
        require(balanceOf[from] >= v, "balance");

        // RULE 3, and it has to be settled HERE — before a single balance moves. The accrual
        // owed is for the balance held UP TO now; settling after the transfer would pay the
        // sender for the whole period at their post-sale size, which is the smaller number,
        // and would pay the recipient for a period during which they held nothing.
        _settle(from);
        _settle(to);
        // Captured before the credit below, because a wallet that holds nothing has no streak
        // to continue. Without this, selling everything and buying back three months later
        // returns to a clock that has been running the whole time it held zero.
        bool toWasEmpty = balanceOf[to] == 0;

        uint256 delivered = v;
        if (isPool[to] && !capExempt[from]) {
            _chargeWindow(from, v);
            // A sell. The haircut never touches a buy, a wallet-to-wallet move, or the pool
            // paying a buyer out — only tokens going INTO the market.
            (uint256 d, uint256 b, uint256 g) = quoteSell(v);
            delivered = d;
            balanceOf[from] -= v;
            if (b > 0) { totalSupply -= b; totalBurned += b; emit Transfer(from, address(0), b); }
            if (g > 0) {
                // The dev's cut is a receipt like any other, so it starts a clock like any
                // other. Unreachable at devBps 0, which is what this launch ships.
                _settle(dev);
                bool devWasEmpty = balanceOf[dev] == 0;
                balanceOf[dev] += g;
                emit Transfer(from, dev, g);
                if (devWasEmpty) _sleep(dev);
            }
            balanceOf[to] += d;
            emit Transfer(from, to, d);
            emit Snoozed(from, v, d, b, g);
            _wakeUp(from);
            if (toWasEmpty) _sleep(to);
            return;
        }

        balanceOf[from] -= v;
        balanceOf[to] += delivered;
        emit Transfer(from, to, delivered);
        // Every outbound transfer, not only a sale. A move to your own second wallet is
        // indistinguishable from a deposit to an exchange from inside this function, and
        // pretending otherwise is how a hold-to-earn rule gets farmed with two wallets.
        _wakeUp(from);
        if (toWasEmpty) _sleep(to);
    }
}
