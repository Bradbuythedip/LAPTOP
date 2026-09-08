// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Snooze, ITwapOracle} from "./Snooze.sol";
import {PooledLaunchBuy, ILaunchRouter} from "./PooledLaunchBuy.sol";

/// @title SnoozeLaunchpad
/// @notice Launches tokens that carry the Snooze rules, and wires the pooled buy to them.
///
/// WHY A LAUNCHPAD AT ALL. Not to save anyone typing. The two contracts it deploys both pass
/// their own test suites and still do not work together: `PooledLaunchBuy.claim()` is an
/// outbound transfer, so Snooze's 20%/day cap applies to it, and a distribution where anyone
/// is owed more than 20% of the bag simply cannot complete. Waiting does not fix it, because
/// the share is fixed and the cap is a percentage of a shrinking baseline. A launcher wiring
/// these by hand hits that on distribution day, after the money is in.
///
/// So the only thing this contract is really for is that the wiring bug cannot be made. The
/// exemption is granted inside `launch()`, in the same transaction, before anyone can deposit.
///
/// ZERO DISCRETION AFTER LAUNCH. This contract takes the token's admin rights and gives them
/// up in the same call. It registers the venue and the distributor, then freezes. After
/// `launch()` returns there is no address anywhere — not the launcher, not this contract, not
/// its deployer — that can change a pool, an exemption, or a rule. The trade is stated rather
/// than hidden: a venue created later is permanently outside the rules, because the only
/// alternative is keeping a key that can rewrite them.
///
/// WHAT IT REFUSES. Parameters that would produce a launch whose own arithmetic works against
/// the buyers, checked at launch rather than discovered afterwards. See `validate`.
contract SnoozeLaunchpad {
    /// A launcher cannot take more than this share of the HAIRCUT. Above it, "paid from the
    /// burn" stops being true and it is a sell tax with a story attached.
    uint256 public constant MAX_DEV_BPS = 2000;
    /// The pooled buy must leave a real window between the buy and the refund, or depositors
    /// have no unconditional exit.
    uint256 public constant MIN_REFUND_WINDOW = 1 days;

    struct Params {
        uint256 supply;
        ITwapOracle oracle;
        address dev;
        uint256 devBps;
        ILaunchRouter router;
        uint64 executeAfter;
        uint64 refundAfter;
        uint256 minDeposit;
        uint256 exitFeeBps;
        /// Token base units per 1e18 wei. The floor a permissionless execute() cannot go
        /// below, published before anyone deposits. Without it any stranger can move the
        /// price, call execute(1), and buy the whole pool out at a price they chose.
        uint256 minTokensPerEth;
    }

    struct Launch {
        address token;
        address pool;
        address launcher;
        uint64 launchedAt;
    }

    Launch[] public launches;
    mapping(address => uint256) public launchOf;   // token => index+1

    event Launched(address indexed token, address indexed pool, address indexed launcher,
                   uint256 supply, uint256 devBps);

    error BadParams(string why);

    function count() external view returns (uint256) { return launches.length; }

    /// @notice Everything this contract refuses, in one place a launcher can read first.
    /// @dev Pure so a page can check a proposed launch without sending anything.
    function validate(Params calldata p) public pure returns (bool okAll, string memory why) {
        if (p.supply == 0) return (false, "supply is zero");
        if (address(p.oracle) == address(0)) return (false, "no oracle");
        if (address(p.router) == address(0)) return (false, "no router");
        if (p.devBps > MAX_DEV_BPS) return (false, "dev takes more than 20% of the haircut");
        if (p.refundAfter <= p.executeAfter) return (false, "refund window closes before it opens");
        if (uint256(p.refundAfter) - uint256(p.executeAfter) < MIN_REFUND_WINDOW)
            return (false, "refund window shorter than a day");
        if (p.exitFeeBps >= 10_000) return (false, "exit fee confiscates the deposit");
        if (p.minTokensPerEth == 0)
            return (false, "no price floor: any stranger could buy the pool out at any price");
        return (true, "");
    }

    /// @notice Whether a tax schedule leaves buying early the better trade.
    /// @dev All-in cost per token is spot/(1-tau). Spot rises with each buy and (1-tau) rises
    ///      as the tax decays, so the cost is rising over rising. If the tax decays FASTER
    ///      than the price climbs, later buyers pay less all-in, waiting becomes the dominant
    ///      strategy, and because the tax only decays ON BUYS the launch deadlocks: the relief
    ///      needs the buys that waiting prevents.
    ///
    ///      The condition is exact and needs no simulation:
    ///          spot(n+1)/spot(n) > (1 - tau(n+1))/(1 - tau(n))
    ///      Rearranged into integers to avoid division:
    ///          spotNext * (10000 - tauNow) > spotNow * (10000 - tauNext)
    ///
    ///      This is a view, not a gate, because the launchpad does not deploy the tax ramp —
    ///      it is here so a launcher and a page can both check a schedule with the same
    ///      arithmetic, and so the answer is on chain rather than in a spreadsheet.
    function earlyStaysBetter(uint256 spotNow, uint256 spotNext, uint256 tauNowBps,
                              uint256 tauNextBps) public pure returns (bool) {
        if (tauNowBps >= 10_000 || tauNextBps >= 10_000) return false;
        return spotNext * (10_000 - tauNowBps) > spotNow * (10_000 - tauNextBps);
    }

    /// @notice Deploy a Snooze-ruled token and its pooled buy, wired and frozen, in one call.
    function launch(Params calldata p) external returns (address token, address pool) {
        (bool okAll, string memory why) = validate(p);
        if (!okAll) revert BadParams(why);

        // This contract is the token's admin for the length of this transaction and no longer.
        Snooze t = new Snooze(p.supply, p.oracle, p.dev, p.devBps);
        PooledLaunchBuy b = new PooledLaunchBuy(
            p.router, address(t), p.executeAfter, p.refundAfter, p.minDeposit, p.exitFeeBps,
            p.minTokensPerEth);

        // The venue. setPool also grants the cap exemption, because a pool that could only pay
        // out 20% of its balance per day is not a pool.
        t.setPool(address(p.router), true);

        // THE WIRING. Without this the distribution cannot complete for anybody owed more than
        // 20% of the bag, and there is no later moment at which it starts working. Granted
        // here, before the pooled buy can take a single deposit.
        t.setCapExempt(address(b), true);

        // The constructor minted the supply to THIS contract, and this contract is subject to
        // Rule 2 like everything else — so handing the supply on is an outbound transfer of
        // 100% of a balance and reverts at 20%. That is the same wiring bug as the one above,
        // one level up, and it was made here first: the launchpad designed to prevent it hit
        // it on its own first transaction. Exempting itself is the fix, and it costs nothing
        // because the exemption dies with the freeze three lines below.
        t.setCapExempt(address(this), true);

        // The launcher receives the supply to seed liquidity with, and is exempt only so that
        // seeding is possible at all — 20% a day would take weeks to fill a book.
        t.setCapExempt(msg.sender, true);
        t.transfer(msg.sender, p.supply);

        // And now nobody can change any of it, including this contract.
        t.freeze();

        launches.push(Launch(address(t), address(b), msg.sender, uint64(block.timestamp)));
        launchOf[address(t)] = launches.length;
        emit Launched(address(t), address(b), msg.sender, p.supply, p.devBps);
        return (address(t), address(b));
    }
}
