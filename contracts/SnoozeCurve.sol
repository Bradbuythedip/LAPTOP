// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// The three calls graduation needs, and no more. Uniswap V2's factory and pair, which on Base
/// are at addresses this repository already treats as verified (web/checker.html). Not the
/// router: addLiquidityETH refunds any excess ETH to msg.sender, and this contract refuses ETH
/// it did not price — so the pair is fed directly and `mint` is called on it, which is what the
/// router does underneath anyway, minus the refund path that would have reverted graduation.
interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
    function createPair(address, address) external returns (address);
}
interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
}
interface IWETH {
    function deposit() external payable;
    function transfer(address, uint256) external returns (bool);
}

/// @title SnoozeCurve
/// @notice A constant-product curve whose ETH side starts out imaginary, so a launch needs no
///         liquidity from anybody. Buyers send real ETH; the curve prices against virtual plus
///         real. When enough real ETH has arrived the token BONDS and the curve retires into a
///         real pool.
///
/// WHY THIS EXISTS. Nobody can put real ETH behind every token on a permissionless launchpad.
/// The alternative to virtual liquidity is not "deeper liquidity", it is "no launch".
///
/// AND WHY IT UNBLOCKS THE REST. LAUNCH.md 2.2 records that SnoozeLaunchpad passes ONE address
/// as both the router PooledLaunchBuy calls and the pool Rule 1 taxes, and that nothing
/// deployed on Base is both. A curve is both, necessarily: it holds the reserves, it prices the
/// trade and it pays out. The interface mismatch was a symptom of trying to borrow somebody
/// else's venue for a token that needs its own.
///
/// THE ARITHMETIC, which is short enough to state in full:
///   k = E * T, held across every trade.
///   E starts at E0 (virtual) and only ever rises with real ETH in and falls with real ETH out.
///   price = E / T, so the price multiple after R real ETH is ((E0 + R) / E0)^2 — the token
///   side cancels, and how much money it takes to 10x is a fact about E0 alone.
///   Bonding at multiple m needs R = E0 * (sqrt(m) - 1). At m = 10 that is 2.162 * E0.
///
/// THE SOLVENCY INVARIANT, which is the only thing standing between this and other people's
/// money: E >= E0 at all times, therefore everything ever paid out is bounded by what came in.
/// E falls only on a sell, and a sell can only push E down toward E0 while T climbs toward T0.
/// So the whole of solvency rests on T never exceeding T0 — i.e. the curve never buying back
/// more than it sold. `sold` is tracked for exactly that reason and `sell` refuses above it.
/// Without that check a holder who got tokens somewhere else — the launcher holds the entire
/// supply the moment a Snooze token exists — could sell into the curve and drain it.
contract SnoozeCurve {
    /// The virtual ETH reserve. Sets BOTH how deep the book feels and how much real money it
    /// takes to graduate; they are one dial and not two. 0.1 ETH into a 3 ETH curve moves the
    /// price 3.3% and bonding takes 6.5 ETH; into a 25 ETH curve it moves 0.4% and bonding
    /// takes 54 ETH. There is no setting that is both deep and quick.
    uint256 public immutable virtualEth;
    /// Tokens the curve is allowed to sell. Not the total supply.
    uint256 public immutable curveSupply;
    /// Real ETH that must arrive before the token can bond.
    uint256 public immutable bondTarget;
    /// Charged on the way in and on the way out, in basis points, and kept in ETH.
    uint256 public immutable feeBps;
    /// Where the fee goes. Immutable, because a fee address that can be repointed later is an
    /// admin key with a different name.
    address public immutable feeTo;
    address public immutable token;

    /// WHERE GRADUATION GOES, fixed at construction and readable by anybody before a single
    /// buy. The first version took `pool` as an argument to bond(): "chosen at call time
    /// because the pool does not exist until now". It does not need to — a V2 pair's address is
    /// a function of the factory and the two tokens, so it can be created here, in the
    /// constructor, before the curve has sold anything. That closes the hole the argument
    /// opened, which was that the first stranger to call bond() after the target named
    /// themselves and received the whole raise. Now nobody names anything: bond() is still
    /// permissionless, and all it can do is the one thing it says.
    address public immutable factory;
    address public immutable weth;
    /// The pair, created by this constructor if the factory had none. Register it as a pool on
    /// the token (setPool) before freeze(), or sells into it are outside both rules forever.
    address public immutable pair;
    /// Who receives the LP tokens. The dead address burns them, which is what "LP burned"
    /// means on every launch page that says it; the fee address keeps the pool's trading fees.
    address public immutable lpTo;

    uint256 public constant MAX_FEE_BPS = 500;   // 5%. Above this it is not a fee.

    // ---------------------------------------------------------------------------- the gate
    //
    // "You need SNOOZE to bid on LAPTOP at launch." The dynamics are worth stating because they
    // are not all in the direction they look:
    //
    //   It works on the way in. Every launch creates demand for the gate token before it, from
    //   people who want the early window. That is the loop.
    //
    //   It fights itself on the way out. Snooze Rule 1 burns the excess over the 24-hour
    //   average, and gate demand is exactly what pushes a price above its own average. So the
    //   people who buy SNOOZE to get in and sell straight after are taxed hardest, precisely
    //   because they all did it at once. That is the intended shape — it pays holders and not
    //   renters — but it means the gate is a worse deal than it looks for anyone treating it
    //   as a toll, and the page has to say so rather than let them find out.
    //
    //   It is checkable but not unfakeable. A balance at a moment can be borrowed for that
    //   moment. A lock would fix it and a lock is the thing that turns the gate into a trap,
    //   so this takes the weaker check on purpose. What it buys is not exclusion, it is that
    //   the cheapest way in is to already hold some.
    //
    //   And it expires. After gateUntil anybody buys. A permanent gate is a permanent tax on
    //   the token's own liquidity, and the launch window is the only part worth gating.
    address public immutable gateToken;    // 0 = no gate
    uint256 public immutable gateMin;      // base units of gateToken the buyer must hold
    uint64  public immutable gateUntil;    // unix seconds; after this the gate is off

    /// Tokens the curve has sold, net of what it has bought back. The solvency bound.
    uint256 public sold;
    /// Real ETH held for the curve, i.e. excluding fees already paid out.
    uint256 public reserveEth;
    bool public bonded;

    event Bought(address indexed who, uint256 ethIn, uint256 fee, uint256 tokensOut,
                 uint256 newReserve);
    event Sold(address indexed who, uint256 tokensIn, uint256 ethOut, uint256 fee,
               uint256 newReserve);
    event Bonded(address indexed by, address indexed pair, uint256 ethToPool,
                 uint256 tokensToPool, uint256 leftover, uint256 liquidity);

    error BadConfig();
    error AlreadyBonded();
    error NotBondable();
    error NothingIn();
    error TooLittleOut();
    error MoreThanWasSold();
    error GateClosed();
    error TransferFailed();

    constructor(address _token, uint256 _virtualEth, uint256 _curveSupply,
                uint256 _bondTarget, uint256 _feeBps, address _feeTo,
                address _gateToken, uint256 _gateMin, uint64 _gateUntil,
                address _factory, address _weth, address _lpTo) {
        if (_token == address(0) || _virtualEth == 0 || _curveSupply == 0) revert BadConfig();
        if (_bondTarget == 0) revert BadConfig();
        if (_feeBps > MAX_FEE_BPS) revert BadConfig();
        if (_feeBps > 0 && _feeTo == address(0)) revert BadConfig();
        if (_factory == address(0) || _weth == address(0) || _lpTo == address(0)) revert BadConfig();
        token = _token;
        virtualEth = _virtualEth;
        curveSupply = _curveSupply;
        bondTarget = _bondTarget;
        feeBps = _feeBps;
        feeTo = _feeTo;
        factory = _factory;
        weth = _weth;
        lpTo = _lpTo;
        // Created now, so the address is a fact before the first buy rather than a promise at
        // the last one. A factory with no code at it makes this revert in the constructor,
        // which is the cheapest possible moment to find out. If somebody already created the
        // pair, it is used: anything they put in it is priced against the raise on the way in.
        address p = IUniswapV2Factory(_factory).getPair(_token, _weth);
        if (p == address(0)) p = IUniswapV2Factory(_factory).createPair(_token, _weth);
        pair = p;
        // A gate token with no minimum, or a minimum with no token, is a gate that gates
        // nothing while looking on the explorer like one that does.
        if ((_gateToken == address(0)) != (_gateMin == 0)) revert BadConfig();
        if (_gateMin > 0 && _gateUntil <= block.timestamp) revert BadConfig();
        gateToken = _gateToken;
        gateMin = _gateMin;
        gateUntil = _gateUntil;
    }

    /// @notice Whether the early window is still closed to people who hold none of the gate
    ///         token. False once it has expired, and false if there was never a gate.
    function gateOpen() public view returns (bool) {
        return gateMin > 0 && block.timestamp < gateUntil;
    }

    /// @notice Whether `who` could buy right now. A page can call this before anybody pays gas.
    function canBuy(address who) public view returns (bool ok_, uint256 held, uint256 needed) {
        if (!gateOpen()) return (true, 0, 0);
        held = IERC20(gateToken).balanceOf(who);
        return (held >= gateMin, held, gateMin);
    }

    // ------------------------------------------------------------------ reading the curve

    /// @notice The two reserves the constant product is held against.
    function reserves() public view returns (uint256 e, uint256 t) {
        e = virtualEth + reserveEth;
        t = curveSupply - sold;
    }

    /// @notice Wei per whole token at the margin, for an 18-decimal token.
    /// @dev (e * 1e18) / t is wei per base unit scaled by 1e18, which for 18 decimals is wei
    ///      per whole token. A marginal price, not a quote: it is what an infinitesimal trade
    ///      would pay, and every real trade pays worse. Use quoteBuy/quoteSell for a number
    ///      somebody is going to act on.
    function spot() public view returns (uint256) {
        (uint256 e, uint256 t) = reserves();
        return t == 0 ? 0 : (e * 1e18) / t;
    }

    /// @notice How far the price has moved since the first block, in basis points of the start.
    /// @dev ((E0+R)/E0)^2, in bps. 10_000 is where it started; 100_000 is a 10x.
    function priceMultipleBps() public view returns (uint256) {
        uint256 e = virtualEth + reserveEth;
        return (e * e * 10_000) / (virtualEth * virtualEth);
    }

    /// @notice What a buy of `ethIn` gets, and what it costs in fee, without sending anything.
    function quoteBuy(uint256 ethIn) public view returns (uint256 tokensOut, uint256 fee) {
        fee = (ethIn * feeBps) / 10_000;
        uint256 net = ethIn - fee;
        (uint256 e, uint256 t) = reserves();
        if (net == 0 || t == 0) return (0, fee);
        tokensOut = t - (e * t) / (e + net);
        if (tokensOut > t) tokensOut = t;
    }

    /// @notice What a sell of `tokensIn` returns, after the fee.
    /// @dev `tokensIn` is what ARRIVES. If the token takes a haircut on the way in, quote the
    ///      delivered amount, not the amount you sent — see `sell`.
    function quoteSell(uint256 tokensIn) public view returns (uint256 ethOut, uint256 fee) {
        (uint256 e, uint256 t) = reserves();
        if (tokensIn == 0) return (0, 0);
        if (tokensIn > sold) return (0, 0);          // the curve does not buy what it never sold
        uint256 gross = e - (e * t) / (t + tokensIn);
        fee = (gross * feeBps) / 10_000;
        ethOut = gross - fee;
    }

    /// @notice Whether anybody may call `bond()` right now.
    function bondable() public view returns (bool) {
        return !bonded && reserveEth >= bondTarget;
    }

    /// @notice What `bond()` would hand the pool, and what would be left over.
    /// @dev The leftover is exactly curveSupply/m at a bond of multiple m, for every m. It is
    ///      the only revenue this design produces that is not a fee.
    function bondPreview() public view returns (uint256 ethToPool, uint256 tokensToPool,
                                                uint256 leftover) {
        (uint256 e, uint256 t) = reserves();
        ethToPool = reserveEth;
        // Seed at the curve's CLOSING price so the pool does not open below where the last
        // buyer paid. tokens = eth / price, price = e/t.
        tokensToPool = t == 0 ? 0 : (ethToPool * t) / e;
        if (tokensToPool > t) tokensToPool = t;
        leftover = t - tokensToPool;
    }

    // ------------------------------------------------------------------------------ trading

    /// @notice Buy on the curve. Anyone, any size, no allowlist.
    function buy(uint256 minOut, address to) public payable returns (uint256 out) {
        if (bonded) revert AlreadyBonded();
        if (msg.value == 0) revert NothingIn();
        // The holder checked is the RECIPIENT, not the payer, so a router or a friend paying on
        // a holder's behalf works and a holder cannot be bypassed by routing around them. The
        // reverse — buying tokens "for" somebody who did not ask — costs the buyer money and
        // gives the recipient tokens, so there is nothing there to grief with.
        if (gateOpen() && IERC20(gateToken).balanceOf(to) < gateMin) revert GateClosed();
        uint256 fee;
        (out, fee) = quoteBuy(msg.value);
        if (out == 0) revert NothingIn();
        if (out < minOut) revert TooLittleOut();

        // Effects before interactions, and the fee leaves the accounting immediately so
        // reserveEth is only ever the curve's own money.
        sold += out;
        reserveEth += msg.value - fee;
        if (!IERC20(token).transfer(to, out)) revert TransferFailed();
        if (fee > 0) {
            (bool ok, ) = feeTo.call{value: fee}("");
            if (!ok) revert TransferFailed();
        }
        emit Bought(msg.sender, msg.value, fee, out, reserveEth);
    }

    /// @notice The shape PooledLaunchBuy calls. Same buy, different signature.
    /// @dev This is the whole reason the launchpad's router/pool conflation stops being a
    ///      problem: the curve really is both, so one address can honestly be both.
    function swapExactETHForTokens(address _token, uint256 minOut, address to)
        external payable returns (uint256)
    {
        if (_token != token) revert BadConfig();
        return buy(minOut, to);
    }

    /// @notice Sell back to the curve. Pull-based, so the haircut lands before we measure.
    /// @dev The caller approves, we pull, and we price on the DELIVERED amount — the balance
    ///      this contract actually gained. A token that burns part of a sale on its way into a
    ///      pool (which is what Snooze Rule 1 does) delivers less than was sent, and pricing on
    ///      the sent amount would pay the seller for tokens that no longer exist and would put
    ///      the constant product out by exactly the burn.
    function sell(uint256 amount, uint256 minEthOut) external returns (uint256 ethOut) {
        if (bonded) revert AlreadyBonded();
        if (amount == 0) revert NothingIn();

        uint256 before = IERC20(token).balanceOf(address(this));
        if (!IERC20(token).transferFrom(msg.sender, address(this), amount))
            revert TransferFailed();
        uint256 delivered = IERC20(token).balanceOf(address(this)) - before;
        if (delivered == 0) revert NothingIn();
        // THE SOLVENCY BOUND. Tokens exist outside this curve — on a Snooze launch the launcher
        // holds the entire supply from block one — so without this a holder who never bought
        // here could push T above T0, drive E below E0, and be owed ETH that never arrived.
        if (delivered > sold) revert MoreThanWasSold();

        uint256 fee;
        (ethOut, fee) = quoteSell(delivered);
        if (ethOut < minEthOut) revert TooLittleOut();
        uint256 gross = ethOut + fee;

        sold -= delivered;
        reserveEth -= gross;
        if (fee > 0) {
            (bool okF, ) = feeTo.call{value: fee}("");
            if (!okF) revert TransferFailed();
        }
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        if (!ok) revert TransferFailed();
        emit Sold(msg.sender, delivered, ethOut, fee, reserveEth);
    }

    // --------------------------------------------------------------------------- graduation

    /// @notice Retire the curve into the real pool. Permissionless once the target is reached.
    /// @dev Permissionless on purpose: graduation must not wait on anybody being awake. And it
    ///      takes NO ARGUMENT, on purpose: the first version took `pool` and handed the whole
    ///      raise to whatever the caller named, which made "permissionless" mean "a race the
    ///      first stranger wins". Every destination here is immutable and was public before
    ///      the first buy — the pair from the constructor, lpTo from the constructor.
    ///
    ///      The pair is fed directly and mint() is called on it, rather than going through the
    ///      router: addLiquidityETH refunds excess ETH to msg.sender, and this contract's
    ///      receive() reverts, so a router path could have reverted graduation on a pair
    ///      somebody pre-seeded at a different price. Feeding the pair takes whatever is there
    ///      as it is; a pre-seeder's contribution is repriced against the raise and their LP
    ///      share is what they paid for.
    ///
    ///      The token transfer to the pair runs through Snooze._move with the curve as sender.
    ///      setPool(curve) made the curve capExempt, so neither rule fires on it — which is
    ///      also why the curve must be registered before anything is sent to it (step 5).
    function bond() external returns (uint256 ethToPool, uint256 tokensToPool) {
        if (bonded) revert AlreadyBonded();
        if (reserveEth < bondTarget) revert NotBondable();

        uint256 leftover;
        (ethToPool, tokensToPool, leftover) = bondPreview();
        bonded = true;
        sold += tokensToPool;          // those tokens have left the curve's book
        reserveEth = 0;

        if (leftover > 0 && !IERC20(token).transfer(feeTo, leftover)) revert TransferFailed();
        if (tokensToPool > 0 && !IERC20(token).transfer(pair, tokensToPool))
            revert TransferFailed();
        IWETH(weth).deposit{value: ethToPool}();
        if (!IWETH(weth).transfer(pair, ethToPool)) revert TransferFailed();
        uint256 liquidity = IUniswapV2Pair(pair).mint(lpTo);
        emit Bonded(msg.sender, pair, ethToPool, tokensToPool, leftover, liquidity);
    }

    /// Nothing else may send ETH here. A stranger's transfer would be counted by nobody and
    /// recoverable by nobody, which is worse than refusing it.
    receive() external payable { revert NothingIn(); }
}
