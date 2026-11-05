// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title INullifierRegistry
/// @notice The shared one-human-one-review ledger ReviewGateway writes to.
/// @dev Declared separately so the gateway can hold it as an immutable
///      dependency without importing the implementation.
interface INullifierRegistry {
    /// @notice The ReceiptSettler this registry takes its active gateway from.
    /// @dev The gateway checks this matches its own settler, so a registry wired
    ///      to a different deployment cannot be installed by mistake.
    function receiptSettler() external view returns (address settler);

    /// @notice Whether `nullifier` has already reviewed `agentId`.
    function isUsed(uint256 agentId, bytes32 nullifier) external view returns (bool used);

    /// @notice Record `nullifier` as having reviewed `agentId`.
    /// @dev Callable only by the settler's currently active gateway. Reverts on a
    ///      zero or already-consumed nullifier.
    function consume(uint256 agentId, bytes32 nullifier) external;
}
