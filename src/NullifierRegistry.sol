// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IReceiptSettler} from "./interfaces/IReceiptSettler.sol";

/// @title NullifierRegistry
/// @notice The one-human-one-review ledger, held outside ReviewGateway so it
///         survives gateway replacement.
/// @dev Keeping this mapping inside the gateway made it generational: a
///      replacement gateway started with an empty set, and a predecessor check
///      only reached back one hop — a nullifier rejected by one generation was
///      never recorded by it, so the generation after that accepted it again.
///      One shared ledger removes the concept of generations entirely.
///
///      There is deliberately no owner and no allowlist. Write access is
///      derived live from `settler.reviewGateway()`, so replacing the gateway
///      re-authorizes the new one and de-authorizes the old one in the same
///      single storage write, with no window in which both can write and no
///      privileged role to compromise.
contract NullifierRegistry {
    /// @notice The ReceiptSettler that names the active gateway.
    IReceiptSettler public immutable receiptSettler;

    /// @notice Whether a nullifier has been used to review a given agent.
    mapping(uint256 => mapping(bytes32 => bool)) private _used;

    /// @notice Emitted when a nullifier is consumed for an agent.
    /// @param agentId The agent reviewed.
    /// @param nullifier The World ID nullifier that reviewed it.
    /// @param gateway The gateway that recorded it.
    event NullifierConsumed(uint256 indexed agentId, bytes32 indexed nullifier, address indexed gateway);

    /// @param receiptSettler_ The ReceiptSettler whose `reviewGateway()` gates writes.
    constructor(address receiptSettler_) {
        require(receiptSettler_ != address(0), "settler is zero");
        require(receiptSettler_.code.length > 0, "settler has no code");
        receiptSettler = IReceiptSettler(receiptSettler_);
    }

    /// @dev Restrict to whichever gateway the settler currently names.
    ///
    ///      `reviewGateway()` is a plain external call: if the settler is not a
    ///      settler, or the call reverts for any reason, this modifier reverts
    ///      with it and the consumption fails closed. It is never interpreted as
    ///      "no active gateway", which would let anyone through.
    ///
    ///      Before the settler is wired the pointer is zero, and `msg.sender`
    ///      can never be zero, so the registry is closed until configured.
    modifier onlyActiveGateway() {
        require(msg.sender == receiptSettler.reviewGateway(), "not active gateway");
        _;
    }

    /// @notice Whether `nullifier` has already reviewed `agentId`.
    function isUsed(uint256 agentId, bytes32 nullifier) external view returns (bool used) {
        return _used[agentId][nullifier];
    }

    /// @notice Record `nullifier` as having reviewed `agentId`.
    /// @dev The same checks the gateway's local version performed, in the same
    ///      order. The write happens before the caller's remaining work, so a
    ///      later revert anywhere in the transaction rolls it back and the
    ///      nullifier stays unconsumed.
    /// @param agentId The agent being reviewed.
    /// @param nullifier The World ID nullifier for (human, action).
    function consume(uint256 agentId, bytes32 nullifier) external onlyActiveGateway {
        require(nullifier != bytes32(0), "zero nullifier");
        require(!_used[agentId][nullifier], "nullifier used");

        _used[agentId][nullifier] = true;
        emit NullifierConsumed(agentId, nullifier, msg.sender);
    }
}
