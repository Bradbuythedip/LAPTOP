// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SnoozeDeployer
/// @notice Deploys the first token, at an address chosen in advance, and only for one wallet.
///
/// TWO JOBS, and they are the same job. A contract deployed the ordinary way lands at
/// keccak(rlp(sender, nonce)) — you cannot choose it, so you cannot have a vanity address, and
/// anybody who front-runs your nonce changes it. CREATE2 lands at
/// keccak(0xff, deployer, salt, keccak(initCode)), which you CAN choose, by grinding the salt.
/// Grinding is only worth anything if nobody else can use the salt you found, which is why the
/// owner check and the vanity are one mechanism rather than two.
///
/// WHAT `owner` CAN AND CANNOT DO. It can deploy, once, until `sealed_` is set. It cannot
/// deploy to an address somebody else already occupies, cannot redeploy over one, cannot take
/// anything from the contracts it deploys, and cannot stop being the owner — there is no
/// transfer and no renounce, because both are ways for an address you checked to become one you
/// did not. After `seal()` it cannot deploy either.
///
/// THIS IS NOT A LAUNCHPAD. It has one purpose: put the first token where it was promised to
/// be. Opening deployment to everybody is a different contract with a different threat model,
/// and doing it here would mean the owner check protects nothing.
contract SnoozeDeployer {
    /// The only address that may deploy. Immutable: an owner that can be handed on is an owner
    /// you have to keep re-checking.
    address public immutable owner;
    /// Once true, nothing more can be deployed from here, by anybody, ever.
    bool public sealed_;
    /// Every address this has deployed, in order, so the set is enumerable without logs.
    address[] public deployed;

    event Deployed(address indexed addr, bytes32 indexed salt, address indexed by);
    event Sealed();

    error NotOwner();
    error IsSealed();
    error DeployFailed();
    error Occupied();

    constructor(address _owner) {
        if (_owner == address(0)) revert NotOwner();
        owner = _owner;
    }

    function count() external view returns (uint256) { return deployed.length; }

    /// @notice The address a given salt and init code will land on. Pure, free, and the thing
    ///         the vanity grinder searches over.
    /// @dev Anybody can call this, including before anything is deployed, which is the point:
    ///      the address is publishable in advance and checkable by a stranger.
    function addressOf(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    /// @notice Deploy `initCode` at the address `addressOf` promised.
    function deploy(bytes32 salt, bytes memory initCode) external returns (address addr) {
        if (msg.sender != owner) revert NotOwner();
        if (sealed_) revert IsSealed();
        address predicted = addressOf(salt, keccak256(initCode));
        if (predicted.code.length != 0) revert Occupied();
        assembly { addr := create2(0, add(initCode, 0x20), mload(initCode), salt) }
        if (addr == address(0) || addr != predicted) revert DeployFailed();
        deployed.push(addr);
        emit Deployed(addr, salt, msg.sender);
    }

    /// @notice Give up the ability to deploy anything else. One way.
    function seal() external {
        if (msg.sender != owner) revert NotOwner();
        sealed_ = true;
        emit Sealed();
    }
}
