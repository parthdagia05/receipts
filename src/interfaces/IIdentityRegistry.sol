// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IIdentityRegistry
/// @notice Minimal interface for the deployed ERC-8004 Identity Registry.
/// @dev Signatures verified against the deployed, verified implementation
///      0x7274e874ca62410a93bd8bf61c69d8045e399c02 (behind proxy
///      0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 on Ethereum Mainnet; the same
///      bytecode is deployed on the testnet proxy 0x8004A818...BD9e). Only the
///      functions ReceiptSettler / ReviewGateway need are declared here.
interface IIdentityRegistry {
    /// @notice The agent's designated payment-receiving wallet.
    /// @dev Reads the reserved "agentWallet" metadata. Set automatically to the
    ///      registrant on register() and cleared on NFT transfer, so this returns
    ///      address(0) when unset — callers must handle the zero case (there is no
    ///      fallback to the owner).
    /// @param agentId The agent (ERC-721 token id).
    /// @return wallet The agent's payment wallet, or address(0) if unset.
    function getAgentWallet(uint256 agentId) external view returns (address wallet);

    /// @notice The current owner of the agent NFT.
    /// @param agentId The agent (ERC-721 token id).
    /// @return owner The owner address.
    function ownerOf(uint256 agentId) external view returns (address owner);

    /// @notice Whether `spender` is the agent's owner or an approved operator.
    /// @dev Used to reject self-feedback: in Receipts the gateway calls this with
    ///      the human reviewer's address to block an owner/operator reviewing
    ///      their own agent.
    /// @param spender The address to check.
    /// @param agentId The agent (ERC-721 token id).
    /// @return authorized True if `spender` is the owner or an approved operator.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool authorized);
}
