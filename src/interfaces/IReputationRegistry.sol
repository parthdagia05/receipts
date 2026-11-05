// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IReputationRegistry
/// @notice Minimal interface for the deployed ERC-8004 Reputation Registry.
/// @dev Signatures verified against the deployed, verified implementation
///      0x16e0FA7f7C56B9a767E34B192B51f921BE31dA34 (behind proxy
///      0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 on Ethereum Mainnet).
///      Only the functions AttackLab needs are declared here.
interface IReputationRegistry {
    /// @notice Aggregate non-revoked feedback for an agent into an unweighted mean.
    /// @dev `clientAddresses` MUST be non-empty or the call reverts
    ///      ("clientAddresses required"). An empty `tag1`/`tag2` acts as a wildcard;
    ///      a non-empty tag matches entries whose tag is byte-equal. Revoked entries
    ///      are skipped. Returns (0, 0, 0) when no matching feedback exists.
    /// @param agentId The agent (ERC-721 token id in the Identity Registry).
    /// @param clientAddresses The feedback authors to include in the aggregate.
    /// @param tag1 Optional exact-match filter on the first tag ("" = any).
    /// @param tag2 Optional exact-match filter on the second tag ("" = any).
    /// @return count Number of non-revoked entries included.
    /// @return summaryValue The mean value, scaled to `summaryValueDecimals`.
    /// @return summaryValueDecimals Decimal exponent of `summaryValue`.
    function getSummary(uint256 agentId, address[] calldata clientAddresses, string calldata tag1, string calldata tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    /// @notice List every address that has ever authored feedback for an agent.
    /// @dev Append-only; entries are never removed, so revoking feedback does not
    ///      drop the client from this list.
    /// @param agentId The agent to list authors for.
    /// @return clients The feedback author addresses.
    function getClients(uint256 agentId) external view returns (address[] memory clients);

    /// @notice Read individual feedback entries as seven parallel arrays.
    /// @dev An empty `clientAddresses` enumerates all clients from `getClients`.
    ///      Empty `tag1`/`tag2` are wildcards. When `includeRevoked` is false,
    ///      revoked entries are omitted; when true, they are returned and flagged
    ///      in `revokedStatuses`. Index `i` across all arrays describes one entry.
    /// @param agentId The agent to read feedback for.
    /// @param clientAddresses The authors to read; an empty array ([]) means all
    ///        clients (as returned by getClients).
    /// @param tag1 Optional exact-match filter on the first tag ("" = any).
    /// @param tag2 Optional exact-match filter on the second tag ("" = any).
    /// @param includeRevoked Whether to include revoked entries.
    /// @return clients Author address per entry.
    /// @return feedbackIndexes 1-based index of the entry within its author's history.
    /// @return values Signed feedback value per entry.
    /// @return valueDecimals Decimal exponent of each value.
    /// @return tag1s First tag per entry.
    /// @return tag2s Second tag per entry.
    /// @return revokedStatuses Revocation flag per entry.
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2,
        bool includeRevoked
    )
        external
        view
        returns (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        );

    /// @notice Submit one feedback entry for an agent.
    /// @dev The caller (`msg.sender`) is recorded as the feedback author ("client").
    ///      The implementation enforces `valueDecimals <= 18` and `|value| <= 1e38`.
    ///      The self-feedback check (owner/operator cannot review the agent) is applied
    ///      to `msg.sender` — the immediate caller — NOT to any underlying human
    ///      reviewer. In Receipts, ReviewGateway is the immediate caller, so this
    ///      check only guards the gateway address; the gateway must itself verify the
    ///      human reviewer is not the agent's owner/operator.
    ///      `endpoint`, `feedbackURI` and `feedbackHash` are emitted in the event
    ///      only (not stored).
    /// @param agentId The agent being reviewed.
    /// @param value The signed feedback value.
    /// @param valueDecimals Decimal exponent of `value` (<= 18).
    /// @param tag1 First tag.
    /// @param tag2 Second tag.
    /// @param endpoint Optional endpoint string (event-only).
    /// @param feedbackURI Optional off-chain feedback file URI (event-only).
    /// @param feedbackHash Optional hash of the off-chain feedback file (event-only).
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}
