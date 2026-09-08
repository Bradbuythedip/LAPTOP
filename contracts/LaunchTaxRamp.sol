// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LaunchTaxRamp
/// @notice The escalating launch tax, as an isolated, executable object.
///
/// LAPTOP as shipped is a plain OFT with no tax. Any tax therefore lives in a v4 hook, and
/// the hook is the thing that has to be right — not the token. This contract is only the fee
/// arithmetic: the schedule, its cap, its turn-off, and the exemptions. It holds no funds,
/// has no owner path to sweep anything, and cannot move a token. Isolating it this way is
/// deliberate: the arithmetic can then be executed and pinned in a test suite without a
/// testnet, and the hook that eventually calls it has one small thing to review rather than
/// a schedule tangled into swap accounting.
///
/// NOT AUDITED. NOT DEPLOYED. Compiled and executed against an in-process EVM only. The
/// integration with PoolManager — unlock/settle accounting, reentrancy, the delta the hook
/// returns — is NOT modelled here and is where the real risk lives.
contract LaunchTaxRamp {
    /// Basis points. 10_000 = 100%.
    uint256 internal constant BPS = 10_000;

    /// The unit the ramp advances in. The choice matters more than the rate: a ramp keyed to
    /// buy count is trivially evaded by splitting one buy into many wallets, while a ramp
    /// keyed to cumulative volume prices the splitter identically to the whale.
    enum Unit {
        PerBuy,        // advances once per taxed buy
        PerBlock,      // advances once per block since launch
        PerVolume      // advances per `stepUnit` wei of cumulative taxed volume
    }

    struct Schedule {
        Unit unit;
        uint64 startBlock;      // block the launch opened at; 0 = not started
        uint256 startBps;       // tax at the first taxed buy
        uint256 stepBps;        // added per unit
        uint256 stepUnit;       // wei per step, PerVolume only; ignored otherwise
        uint256 capBps;         // the ramp never exceeds this
        uint256 sellBps;        // flat tax on the sell side
        uint256 offAfterUnits;  // ramp turns off entirely once this many units elapse; 0 = never
    }

    /// @dev The schedule's live counters. Kept separate from the schedule so a view function
    ///      can price a hypothetical buy without touching state.
    struct Progress {
        uint256 buys;
        uint256 volume;
    }

    Schedule public schedule;
    Progress public progress;

    /// Addresses whose trades are never taxed. The seed LP is the one that matters: taxing
    /// the launch's own liquidity provision burns the operator's money on the way in and
    /// silently shrinks the book everything downstream is priced against.
    mapping(address => bool) public exempt;

    address public immutable admin;
    bool public frozen;

    error NotAdmin();
    error Frozen();
    error BadSchedule();
    error NotStarted();

    constructor(Schedule memory s, address seedLp) {
        admin = msg.sender;
        _validate(s);
        schedule = s;
        // The seed LP is exempt from construction, not by a later call, so there is no window
        // in which the launch's own liquidity could be taxed.
        if (seedLp != address(0)) exempt[seedLp] = true;
        exempt[msg.sender] = true;
    }

    function _validate(Schedule memory s) internal pure {
        // A cap below the start is not a cap, it is a silently different schedule.
        if (s.capBps < s.startBps) revert BadSchedule();
        // 100% is not a tax, it is a confiscation, and it would also make the pool math
        // divide by a zero input.
        if (s.capBps >= BPS || s.sellBps >= BPS) revert BadSchedule();
        if (s.unit == Unit.PerVolume && s.stepUnit == 0) revert BadSchedule();
    }

    function setExempt(address who, bool on) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        exempt[who] = on;
    }

    /// @notice Give up the ability to change exemptions. A tax whose exemption list can be
    ///         edited after launch is a tax the operator can lift for their own wallets, and
    ///         a buyer has no way to tell that from the outside. Freezing is the only thing
    ///         that makes the published schedule mean anything.
    function freeze() external {
        if (msg.sender != admin) revert NotAdmin();
        frozen = true;
    }

    function open(uint64 atBlock) external {
        if (msg.sender != admin) revert NotAdmin();
        if (frozen) revert Frozen();
        schedule.startBlock = atBlock;
    }

    /// @notice Units elapsed for a hypothetical next buy, given current progress.
    /// @dev The off-by-one lives here. The FIRST taxed buy must see zero elapsed units and
    ///      therefore pay exactly `startBps` — not `startBps + stepBps`. Counters are read
    ///      BEFORE they are advanced, which is the only ordering that gives that.
    function unitsElapsed(uint256 addVolume) public view returns (uint256) {
        Schedule memory s = schedule;
        if (s.unit == Unit.PerBuy) {
            return progress.buys;
        } else if (s.unit == Unit.PerBlock) {
            if (s.startBlock == 0) revert NotStarted();
            if (block.number <= s.startBlock) return 0;
            return block.number - s.startBlock;
        } else {
            // Volume already banked, not including the buy being priced. Pricing a buy
            // against the volume it is itself about to add would make the tax depend on the
            // buy's own size in a way the buyer cannot predict before sending.
            addVolume; // silence unused; retained for signature symmetry with callers
            return progress.volume / s.stepUnit;
        }
    }

    /// @notice The buy-side tax rate, in bps, for the next buy from `who`.
    function buyTaxBps(address who) public view returns (uint256) {
        if (exempt[who]) return 0;
        Schedule memory s = schedule;
        uint256 u = unitsElapsed(0);
        // Turn-off is checked before the ramp, so an expired ramp is exactly zero rather than
        // whatever the ramp happened to reach.
        if (s.offAfterUnits != 0 && u >= s.offAfterUnits) return 0;
        uint256 raw = s.startBps + s.stepBps * u;
        return raw > s.capBps ? s.capBps : raw;
    }

    function sellTaxBps(address who) public view returns (uint256) {
        if (exempt[who]) return 0;
        return schedule.sellBps;
    }

    /// @notice Split a gross buy into the tax and what the pool actually receives.
    /// @dev The pool prices the NET, never the gross. Anything else is tax-on-tax: the pool
    ///      fee would be charged on money the buyer never got to swap.
    function splitBuy(address who, uint256 grossIn)
        public view returns (uint256 tax, uint256 toPool)
    {
        tax = (grossIn * buyTaxBps(who)) / BPS;
        toPool = grossIn - tax;
    }

    /// @notice Split the pool's gross output on a sell into the tax and what the seller keeps.
    /// @dev Sell tax applies to what came OUT of the pool, after the pool fee, not to the
    ///      notional the seller typed. Applying it to the notional double-charges the pool fee.
    function splitSell(address who, uint256 grossOut)
        public view returns (uint256 tax, uint256 toSeller)
    {
        tax = (grossOut * sellTaxBps(who)) / BPS;
        toSeller = grossOut - tax;
    }

    /// @notice Record a completed taxed buy. Called by the hook after the swap settles.
    /// @dev Exempt trades must not advance the ramp. If they did, the operator seeding
    ///      liquidity would push the ramp along and the first real buyer would pay a rate
    ///      the published schedule never promised.
    function recordBuy(address who, uint256 grossIn) external {
        if (exempt[who]) return;
        unchecked {
            progress.buys += 1;
            progress.volume += grossIn;
        }
    }

    /// @notice Everything a caller needs to price a buy, in one read.
    function quote(address who, uint256 grossIn)
        external view returns (uint256 bps, uint256 tax, uint256 toPool, uint256 units)
    {
        bps = buyTaxBps(who);
        (tax, toPool) = splitBuy(who, grossIn);
        units = unitsElapsed(0);
    }
}
