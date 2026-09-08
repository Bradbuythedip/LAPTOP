// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
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

    uint256 public constant MAX_FEE_BPS = 500;   // 5%. Above this it is not a fee.

    /// Tokens the curve has sold, net of what it has bought back. The solvency bound.
    uint256 public sold;
    /// Real ETH held for the curve, i.e. excluding fees already paid out.
    uint256 public reserveEth;
    bool public bonded;

    event Bought(address indexed who, uint256 ethIn, uint256 fee, uint256 tokensOut,
                 uint256 newReserve);
    event Sold(address indexed who, uint256 tokensIn, uint256 ethOut, uint256 fee,
               uint256 newReserve);
    event Bonded(address indexed by, uint256 ethToPool, uint256 tokensToPool, uint256 leftover);

    error BadConfig();
    error AlreadyBonded();
    error NotBondable();
    error NothingIn();
    error TooLittleOut();
    error MoreThanWasSold();
    error TransferFailed();

    constructor(address _token, uint256 _virtualEth, uint256 _curveSupply,
                uint256 _bondTarget, uint256 _feeBps, address _feeTo) {
        if (_token == address(0) || _virtualEth == 0 || _curveSupply == 0) revert BadConfig();
        if (_bondTarget == 0) revert BadConfig();
        if (_feeBps > MAX_FEE_BPS) revert BadConfig();
        if (_feeBps > 0 && _feeTo == address(0)) revert BadConfig();
        token = _token;
        virtualEth = _virtualEth;
        curveSupply = _curveSupply;
        bondTarget = _bondTarget;
        feeBps = _feeBps;
        feeTo = _feeTo;
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

    /// @notice Retire the curve into a real pool. Permissionless once the target is reached.
    /// @dev Permissionless on purpose: graduation must not wait on anybody being awake, and
    ///      there is nothing to gain by calling it — the caller receives nothing and cannot
    ///      choose the price, which is fixed by the curve's own closing state.
    /// @param pool the address the ETH and tokens are handed to. Chosen at call time rather
    ///        than fixed at construction ONLY because the pool does not exist until now; a
    ///        deployment wires this through a launchpad that pins it. That is a real trust
    ///        edge and it is stated rather than hidden.
    function bond(address pool) external returns (uint256 ethToPool, uint256 tokensToPool) {
        if (bonded) revert AlreadyBonded();
        if (reserveEth < bondTarget) revert NotBondable();
        if (pool == address(0)) revert BadConfig();

        uint256 leftover;
        (ethToPool, tokensToPool, leftover) = bondPreview();
        bonded = true;
        sold += tokensToPool;          // those tokens have left the curve's book
        reserveEth = 0;

        if (tokensToPool > 0 && !IERC20(token).transfer(pool, tokensToPool))
            revert TransferFailed();
        if (leftover > 0 && !IERC20(token).transfer(feeTo, leftover)) revert TransferFailed();
        (bool ok, ) = pool.call{value: ethToPool}("");
        if (!ok) revert TransferFailed();
        emit Bonded(msg.sender, ethToPool, tokensToPool, leftover);
    }

    /// Nothing else may send ETH here. A stranger's transfer would be counted by nobody and
    /// recoverable by nobody, which is worse than refusing it.
    receive() external payable { revert NothingIn(); }
}
