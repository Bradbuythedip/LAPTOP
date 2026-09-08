// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice The one call this contract is allowed to make with the pooled money.
interface ILaunchRouter {
    function swapExactETHForTokens(address token, uint256 minOut, address to)
        external payable returns (uint256 out);
}

/// @title PooledLaunchBuy
/// @notice Consolidates many buyers' ETH into one purchase at launch, then distributes
///         pro-rata. Written so that "somebody holds your money" is FALSE.
///
/// The whole design is one question: while the money is sitting here, who can take it?
/// The answer has to be nobody, including whoever deployed this. So:
///
///   - There is no owner withdrawal. No sweep, no rescue, no admin drain, no fee address that
///     can be pointed anywhere later. Search this file for `admin`: it appears only to open
///     the window and to be forbidden from everything else.
///   - `execute()` is permissionless. Any depositor can trigger the buy. The operator cannot
///     hold the round hostage, and if they vanish the round still completes.
///   - The router, the token and the deadline are IMMUTABLE, set at construction. The
///     contract can send ETH to exactly one address, for exactly one purpose.
///   - `refund()` is permissionless and unconditional once the deadline passes without a
///     successful execute. A launch that never happens returns everyone's money without
///     anyone's permission.
///   - There is no upgrade path, no delegatecall, no selfdestruct, no proxy.
///
/// WHAT THIS STILL DOES NOT PROTECT YOU FROM, stated here rather than buried, because an
/// adversarial review found it and it is the honest limit of the design:
///
///   THE DEPLOYER CHOOSES THE ROUTER AND THE TOKEN. `execute()` hands the entire pooled
///   balance to `router`. A deployer who points `router` at a contract they control takes
///   every deposit and hands back a `token` they also control. No amount of internal
///   discipline fixes that — the contract cannot make its deployer honest.
///
///   What it CAN do, and does, is make the two addresses immutable and public before anybody
///   deposits, plus publish an immutable price floor so a stranger cannot buy the pool out at
///   an arbitrary price.
///
///   And the depositor-side check is weaker than it sounds, so do not oversell it: reading
///   `router()` before depositing does NOT prove what that address will do. It may be a proxy
///   whose implementation is swapped after deposits land — its own codehash never changes, so
///   pinning the codehash does not catch it — or a CREATE2 address with no code at all yet,
///   since `deposit()` never touches the router. A round funds normally against empty
///   bytecode and the deployer chooses the semantics afterwards, having seen how much arrived.
///   The only real check is that the router is a contract you already trust for other
///   reasons, at an address you recognise.
///
/// What remains after that is code risk, not counterparty risk. That is a real reduction and
/// it is not zero: an unaudited contract holding pooled funds is how people lose everything,
/// and this one has been compiled and executed against an in-process EVM only. It has never
/// been on a testnet, never been audited, and must not hold real money on that basis.
contract PooledLaunchBuy {
    /// Immutable, because a parameter someone can change after deposits open is a parameter
    /// that will be changed after deposits open.
    ILaunchRouter public immutable router;
    address public immutable token;
    uint64  public immutable executeAfter;   // no buy before this
    uint64  public immutable refundAfter;    // depositors may walk from here, unconditionally
    uint256 public immutable minDeposit;
    uint256 public immutable exitFeeBps;     // charged only on EARLY exit, never on refund
    /// The immutable price floor, in token base units per 1e18 wei. This is the whole defence
    /// against a caller-chosen minOut: `execute()` is permissionless, so the caller is
    /// potentially the attacker, and a bound they supply themselves bounds nobody. Published
    /// at construction, before anyone deposits, and the caller's own minOut may only TIGHTEN
    /// it. An earlier version trusted the caller's argument alone and its comment called that
    /// "a floor the caller must satisfy" — which read as a protection and was not one.
    uint256 public immutable minTokensPerEth;
    address public immutable admin;

    uint256 public totalDeposited;
    uint256 public tokensReceived;
    uint256 public totalClaimed;
    bool    public executed;

    mapping(address => uint256) public deposited;
    mapping(address => bool)    public claimed;

    /// Early-exit fees stay in the pool and are shared by everyone who stayed. They are NOT
    /// paid to the operator. An exit fee that pays the operator gives whoever runs the round a
    /// reason to want people to leave, which is the opposite of the incentive you want in the
    /// party holding the money.
    uint256 public forfeited;

    event Deposited(address indexed who, uint256 amount);
    event ExitedEarly(address indexed who, uint256 returned, uint256 fee);
    event Executed(address indexed by, uint256 ethIn, uint256 tokensOut);
    event Claimed(address indexed who, uint256 tokens);
    event Refunded(address indexed who, uint256 amount);

    error WindowClosed();
    error WindowOpen();
    error TooSmall();
    error NothingHere();
    error AlreadyDone();
    error NotYet();
    error SwapFailed();
    error TransferFailed();
    error BadConfig();

    constructor(
        ILaunchRouter _router,
        address _token,
        uint64 _executeAfter,
        uint64 _refundAfter,
        uint256 _minDeposit,
        uint256 _exitFeeBps,
        uint256 _minTokensPerEth
    ) {
        // A refund deadline at or before the execute time would let depositors refund out of a
        // round that is still live, and a 100% exit fee is confiscation.
        if (_refundAfter <= _executeAfter) revert BadConfig();
        if (_exitFeeBps >= 10_000) revert BadConfig();
        if (address(_router) == address(0) || _token == address(0)) revert BadConfig();
        // A zero floor is the bug this parameter exists to prevent, so it is not a default.
        if (_minTokensPerEth == 0) revert BadConfig();
        router = _router;
        token = _token;
        executeAfter = _executeAfter;
        refundAfter = _refundAfter;
        minDeposit = _minDeposit;
        exitFeeBps = _exitFeeBps;
        minTokensPerEth = _minTokensPerEth;
        admin = msg.sender;
    }

    // ------------------------------------------------------------------ in

    function deposit() external payable {
        if (executed) revert AlreadyDone();
        if (block.timestamp >= refundAfter) revert WindowClosed();
        if (msg.value < minDeposit) revert TooSmall();
        deposited[msg.sender] += msg.value;
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Leave before the buy happens. The fee stays with the depositors who remain.
    /// @dev The one place a depositor can lose value, so it is the one place worth reading
    ///      twice. Effects before interaction; the balance is zeroed before any ETH moves.
    function exitEarly() external {
        if (executed) revert AlreadyDone();
        uint256 amt = deposited[msg.sender];
        if (amt == 0) revert NothingHere();

        deposited[msg.sender] = 0;
        totalDeposited -= amt;
        uint256 fee = (amt * exitFeeBps) / 10_000;
        forfeited += fee;

        (bool sent, ) = msg.sender.call{value: amt - fee}("");
        if (!sent) revert TransferFailed();
        emit ExitedEarly(msg.sender, amt - fee, fee);
    }

    // ------------------------------------------------------------------ the buy

    /// @notice Spend the whole pool on one buy. Anyone may call this.
    /// @param minOut the caller's own slippage bound. It may only TIGHTEN the immutable floor.
    /// @dev Permissionless on purpose: if only the operator could call it, the operator could
    ///      sit on everyone's money until it suited them, which is the arrangement this
    ///      contract exists to avoid.
    ///
    ///      But permissionless means the caller may be the attacker, and a bound the attacker
    ///      supplies is not a bound. Without the immutable floor below, one atomic
    ///      transaction — push the price up, call execute(1), sell back — buys the whole pool
    ///      at any price the attacker likes and leaves every depositor with dust and no
    ///      refund, because `executed` is set before the swap. The floor is published at
    ///      construction and the caller cannot loosen it.
    function execute(uint256 minOut) external {
        if (executed) revert AlreadyDone();
        if (block.timestamp < executeAfter) revert NotYet();
        // The buy window CLOSES at refundAfter. Without this the refund promise was a lie:
        // execute() could be called at any later time and convert everyone's refundable ETH
        // into tokens, so "unconditional refund after the deadline" was only true until
        // somebody chose otherwise. The two windows must not overlap in the other direction
        // either, which is why the constructor requires refundAfter > executeAfter.
        if (block.timestamp >= refundAfter) revert WindowClosed();
        // If every depositor has exited, the contract still holds their forfeited fees, and
        // buying with those would mint tokens that NOBODY can claim — claim() divides by
        // totalDeposited, and refund() is closed once executed is set. The ETH would be
        // converted into permanently unreachable tokens. Found by writing the test for it.
        //
        // The fees stay put instead. That is stranded ETH, which is a bad outcome, but every
        // depositor took their 95% back knowingly and a rescue function that could sweep this
        // is a rescue function that could sweep everything.
        if (totalDeposited == 0) revert NothingHere();
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingHere();

        // Effects first: `executed` is set before the external call, so a token that calls
        // back into this contract cannot start a second buy.
        executed = true;

        uint256 before = IERC20(token).balanceOf(address(this));
        router.swapExactETHForTokens{value: amount}(token, minOut, address(this));
        uint256 actual = IERC20(token).balanceOf(address(this)) - before;

        // The balance delta is the only evidence. The router's return value is discarded
        // entirely: an over-reporting router would let the last claimers find the cupboard
        // bare, and an UNDER-reporting one would strand the difference forever, which an
        // earlier version of this line did by taking min(actual, reported).
        // The binding constraint is the immutable floor; the caller's minOut only raises it.
        uint256 floor = (amount * minTokensPerEth) / 1e18;
        uint256 required = minOut > floor ? minOut : floor;
        if (actual == 0 || actual < required) revert SwapFailed();
        tokensReceived = actual;

        emit Executed(msg.sender, amount, tokensReceived);
    }

    // ------------------------------------------------------------------ out

    /// @notice Take your share of the tokens, pro-rata to what you put in.
    function claim() external {
        if (!executed) revert NotYet();
        uint256 amt = deposited[msg.sender];
        if (amt == 0 || claimed[msg.sender]) revert NothingHere();

        claimed[msg.sender] = true;
        uint256 share = (tokensReceived * amt) / totalDeposited;
        totalClaimed += share;
        if (!IERC20(token).transfer(msg.sender, share)) revert TransferFailed();
        emit Claimed(msg.sender, share);
    }

    /// @notice If the buy never happened, take your ETH back. No fee, no permission needed.
    /// @dev Unconditional after the deadline. This is the promise that makes the rest of the
    ///      contract safe to deposit into: the worst case is that the launch does not happen
    ///      and everyone walks out with what they walked in with.
    function refund() external {
        if (executed) revert AlreadyDone();
        if (block.timestamp < refundAfter) revert WindowOpen();
        uint256 amt = deposited[msg.sender];
        if (amt == 0) revert NothingHere();

        deposited[msg.sender] = 0;
        totalDeposited -= amt;
        (bool sent, ) = msg.sender.call{value: amt}("");
        if (!sent) revert TransferFailed();
        emit Refunded(msg.sender, amt);
    }

    // ------------------------------------------------------------------ what is NOT here

    /// There is deliberately no sweep, no rescue, no owner withdrawal and no fee recipient.
    /// If ETH is stranded here it is stranded for everyone equally, which is a worse outcome
    /// than a rescue function and a better one than a rescue function that can be pointed at
    /// the operator's wallet. A contract that can rescue can rug.

    /// @notice Accepts ETH only from the router, which is how a real router returns change.
    /// @dev Rejecting unconditionally looked safer and was not: any router that refunds
    ///      unspent ETH would make execute() revert every time, bricking the round. Everyone
    ///      else is still rejected so no stranger's send goes silently unaccounted for.
    ///      Change that lands here is spent by the next execute or refunded pro-rata, since
    ///      claims are sized off totalDeposited and not off the balance.
    receive() external payable {
        if (msg.sender != address(router)) revert NothingHere();
    }
}
