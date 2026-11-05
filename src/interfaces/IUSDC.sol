// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IUSDC
/// @notice Minimal interface for Circle's USDC (FiatTokenV2.2) — the EIP-3009
///         receive flow and plain transfer that ReceiptSettler needs.
/// @dev Signatures verified against the deployed, verified FiatTokenV2_2
///      implementation behind the testnet USDC proxies
///      (Ethereum Sepolia 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,
///       Base Sepolia    0x036CbD53842c5426634e7929541eC2318f3dCF7e).
///      The EIP-712 domain on these testnets is name "USDC", version "2".
interface IUSDC {
    /// @notice Settle a signed payment where the caller is the payee.
    /// @dev The bytes-signature overload (V2.2): `signature` is a 65-byte ECDSA
    ///      signature for EOAs or an EIP-1271 signature for contract wallets. The
    ///      token enforces `to == msg.sender`, so the settler must pass itself as
    ///      `to`. Valid only while validAfter < block.timestamp < validBefore; the
    ///      (authorizer, nonce) pair is consumed exactly once.
    /// @param from The payer (authorizer).
    /// @param to The payee; must equal msg.sender.
    /// @param value The USDC amount (6 decimals).
    /// @param validAfter Unix time after which the authorization is valid.
    /// @param validBefore Unix time before which the authorization is valid.
    /// @param nonce Unique 32-byte authorization nonce chosen by the signer.
    /// @param signature EOA (65-byte) or EIP-1271 signature over the authorization.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    /// @notice Whether an authorization nonce has been used or canceled.
    /// @param authorizer The payer who signed the authorization.
    /// @param nonce The authorization nonce.
    /// @return used True if the nonce has already been used or canceled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool used);

    /// @notice Transfer USDC from the caller to `to`.
    /// @param to The recipient.
    /// @param value The USDC amount (6 decimals).
    /// @return success True on success.
    function transfer(address to, uint256 value) external returns (bool success);
}
