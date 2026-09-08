// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @title SnoozeGate
/// @notice Why you need $SNOOZE to get LAPTOP, in the only form that is checkable: an
///         allocation of the new token, claimable in proportion to the $SNOOZE you held at one
///         block that was fixed in advance.
///
/// WHAT IT IS NOT. It is not a lock, a stake, a deposit or a vault. It never takes custody of
/// anybody's $SNOOZE and there is no function here that could. Gating access behind a token
/// that is expensive to exit is a trap, and $SNOOZE is expensive to exit exactly when it has
/// run — so the gate reads a balance at a block and asks for nothing.
///
/// THE HONEST WEAKNESS, stated because it is the first thing an attacker looks for. A snapshot
/// of a balance can be gamed by borrowing: hold nothing, borrow a great deal for one block,
/// claim, give it back. Nothing on chain distinguishes that from holding. The mitigations are
/// (a) do not announce the block, which this contract supports by taking the root and not the
/// block, and (b) accept it, because the alternative — a lock — is the trap above. This design
/// picks (b) and says so.
///
/// The root is a Merkle root over (address, amount) leaves computed off chain from the
/// snapshot. Publishing the leaf list is what makes the claim auditable; a root with no
/// published list is a promise, not a proof.
contract SnoozeGate {
    /// The token being handed out.
    address public immutable token;
    /// Merkle root over keccak256(abi.encodePacked(account, amount)) leaves.
    bytes32 public immutable root;
    /// The block whose balances the root was computed from. Recorded so the claim can be
    /// checked against chain history rather than against a screenshot.
    uint256 public immutable snapshotBlock;
    /// After this, anything unclaimed can be swept ONCE, to a destination fixed at deployment.
    uint64 public immutable claimUntil;
    /// Where the unclaimed goes. Immutable, because a sweep destination that can be repointed
    /// later is an owner withdrawal wearing a deadline.
    address public immutable unclaimedTo;

    mapping(address => bool) public claimed;
    uint256 public totalClaimed;
    bool public swept;

    event Claimed(address indexed who, uint256 amount);
    event Swept(uint256 amount);

    error BadConfig();
    error AlreadyClaimed();
    error BadProof();
    error TooEarly();
    error TooLate();
    error TransferFailed();

    constructor(address _token, bytes32 _root, uint256 _snapshotBlock, uint64 _claimUntil,
                address _unclaimedTo) {
        if (_token == address(0) || _root == bytes32(0)) revert BadConfig();
        if (_unclaimedTo == address(0)) revert BadConfig();
        if (_claimUntil <= block.timestamp) revert BadConfig();
        token = _token; root = _root; snapshotBlock = _snapshotBlock;
        claimUntil = _claimUntil; unclaimedTo = _unclaimedTo;
    }

    /// @notice Check an allocation without spending anything. A page can call this.
    function verify(address who, uint256 amount, bytes32[] calldata proof)
        public view returns (bool)
    {
        bytes32 node = keccak256(abi.encodePacked(who, amount));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            node = node < p ? keccak256(abi.encodePacked(node, p))
                            : keccak256(abi.encodePacked(p, node));
        }
        return node == root;
    }

    /// @notice Take your allocation. Yours only — there is no claim(address).
    /// @dev Deliberately self-service. A claim function that anybody can call on anybody's
    ///      behalf is a griefing vector (it forces delivery to an address that may not want
    ///      it) and it is not needed: nobody's allocation expires except at claimUntil, which
    ///      is published.
    function claim(uint256 amount, bytes32[] calldata proof) external {
        if (block.timestamp >= claimUntil) revert TooLate();
        if (claimed[msg.sender]) revert AlreadyClaimed();
        if (!verify(msg.sender, amount, proof)) revert BadProof();
        claimed[msg.sender] = true;
        totalClaimed += amount;
        if (!IERC20(token).transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Once, after the deadline, send what nobody came for to the published address.
    /// @dev Permissionless. The destination cannot be chosen at call time, so there is nothing
    ///      to gain by being the caller and nothing to lose by not being.
    function sweepUnclaimed() external {
        if (block.timestamp < claimUntil) revert TooEarly();
        if (swept) revert AlreadyClaimed();
        swept = true;
        uint256 left = IERC20(token).balanceOf(address(this));
        if (left > 0 && !IERC20(token).transfer(unclaimedTo, left)) revert TransferFailed();
        emit Swept(left);
    }
}
