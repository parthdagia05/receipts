// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IReceiptSettler
/// @notice Minimal interface for the ReceiptSettler consume path used by
///         ReviewGateway. The Receipt struct mirrors ReceiptSettler.Receipt
///         exactly (same field order and types) so the returned tuple decodes.
interface IReceiptSettler {
    struct Receipt {
        address payer;
        uint256 agentId;
        uint256 amount;
        uint64 settledAt;
        bool spent;
        bytes32 orderId;
    }

    /// @notice The gateway currently permitted to consume receipts.
    /// @dev The single source of truth for which ReviewGateway is active. The
    ///      gateway reads it to refuse submissions once it has been replaced,
    ///      and the NullifierRegistry reads it to decide who may write.
    /// @return gateway The active ReviewGateway, or address(0) before wiring.
    function reviewGateway() external view returns (address gateway);

    /// @notice Consume a receipt, marking it spent; gateway-only in the settler.
    /// @param receiptId The receipt to consume.
    /// @param expectedPayer The payer the gateway expects (the attested reviewer).
    /// @param expectedAgentId The agent the gateway expects.
    /// @return r The consumed receipt, with spent == true.
    function consume(bytes32 receiptId, address expectedPayer, uint256 expectedAgentId)
        external
        returns (Receipt memory r);
}
