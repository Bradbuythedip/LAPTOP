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
/// What remains is code risk, not counterparty risk. That is a real reduction and it is not
/// zero: an unaudited contract holding pooled funds is how people lose everything, and this
/// one has been compiled and executed against an in-process EVM only. It has never been on a
/// testnet, never been audited, and must not hold real money on that basis.
contract PooledLaunchBuy {
    /// Immutable, because a parameter someone can change after deposits open is a parameter
    /// that will be changed after deposits open.
    ILaunchRouter public immutable router;
    address public immutable token;
    uint64  public immutable executeAfter;   // no buy before this
    uint64  public immutable refundAfter;    // depositors may walk from here, unconditionally
    uint256 public immutable minDeposit;
    uint256 public immutable exitFeeBps;     // charged only on EARLY exit, never on refund
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
        uint256 _exitFeeBps
    ) {
        // A refund deadline at or before the execute time would let depositors refund out of a
        // round that is still live, and a 100% exit fee is confiscation.
        if (_refundAfter <= _executeAfter) revert BadConfig();
        if (_exitFeeBps >= 10_000) revert BadConfig();
        if (address(_router) == address(0) || _token == address(0)) revert BadConfig();
        router = _router;
        token = _token;
        executeAfter = _executeAfter;
        refundAfter = _refundAfter;
        minDeposit = _minDeposit;
        exitFeeBps = _exitFeeBps;
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
    /// @param minOut the caller's slippage bound, in tokens, for the entire pooled size.
    /// @dev Permissionless on purpose. If only the operator could call it, the operator could
    ///      sit on everyone's money until it suited them, which is the arrangement this
    ///      contract exists to avoid. The trade-off is that a griefer can execute at a bad
    ///      moment, so `minOut` is a floor the caller must satisfy and the whole call reverts
    ///      beneath it.
    function execute(uint256 minOut) external {
        if (executed) revert AlreadyDone();
        if (block.timestamp < executeAfter) revert NotYet();
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
        uint256 reported = router.swapExactETHForTokens{value: amount}(token, minOut, address(this));
        uint256 actual = IERC20(token).balanceOf(address(this)) - before;

        // Trust the balance, not the return value. A token with a transfer tax delivers less
        // than the router reports, and crediting the reported figure would let the last
        // claimers find the cupboard bare.
        if (actual == 0 || actual < minOut) revert SwapFailed();
        tokensReceived = actual < reported ? actual : reported;
        if (tokensReceived > actual) tokensReceived = actual;

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

    /// @notice Rejects bare ETH so nobody's send is silently unaccounted for.
    receive() external payable { revert NothingHere(); }
}
