// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IUSDC} from "./interfaces/IUSDC.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReviewGateway} from "./interfaces/IReviewGateway.sol";

/// @title ReceiptSettler
/// @notice Settles an EIP-3009 USDC payment to an ERC-8004 agent and records a
///         receipt that ReviewGateway later consumes. A review is only possible
///         if a receipt exists, so this contract is the payment half of Receipts.
/// @dev settle() consumes the EIP-3009 USDC authorization and forwards funds to
///      the agent wallet atomically, recording a receipt keyed by the nonce.
contract ReceiptSettler {
    /// @notice The USDC token used for payments.
    IUSDC public immutable usdc;

    /// @notice The ERC-8004 Identity Registry used to resolve agent wallets.
    IIdentityRegistry public immutable identityRegistry;

    /// @notice Minimum payment (USDC, 6 decimals) required for a valid receipt.
    uint256 public immutable minPayment;

    /// @dev Reentrancy guard states.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /// @dev Reentrancy guard status; set in the constructor.
    uint256 private _status;

    /// @notice The ReviewGateway allowed to consume receipts; 0 until first set.
    /// @dev The deployment's single source of truth for which gateway is live.
    ///      The gateway and NullifierRegistry both read it, so replacing it
    ///      deactivates the old gateway everywhere in one storage write.
    address public reviewGateway;

    /// @dev The deployer; the only address permitted to set or replace the gateway.
    address private immutable _configurator;

    /// @notice A record that a payer paid an agent; the basis for one review.
    /// @param payer The address that paid.
    /// @param agentId The agent that was paid.
    /// @param amount The USDC amount paid.
    /// @param settledAt The block timestamp at settlement.
    /// @param spent Whether the receipt has been consumed by a review.
    /// @param orderId The caller-supplied order identifier; the (agentId, orderId)
    ///        pair must be unique across payers using this settler.
    struct Receipt {
        address payer;
        uint256 agentId;
        uint256 amount;
        uint64 settledAt;
        bool spent;
        bytes32 orderId;
    }

    /// @notice Receipts keyed by receipt ID (the EIP-3009 authorization nonce).
    mapping(bytes32 => Receipt) public receipts;

    /// @notice Emitted when a payment is settled and a receipt is recorded.
    /// @param receiptId The receipt ID (the authorization nonce).
    /// @param payer The address that paid.
    /// @param agentId The agent that was paid.
    /// @param amount The USDC amount paid.
    /// @param agentWallet The wallet the funds were forwarded to.
    event ReceiptSettled(
        bytes32 indexed receiptId, address indexed payer, uint256 indexed agentId, uint256 amount, address agentWallet
    );

    /// @notice Emitted whenever the active ReviewGateway changes.
    /// @param gateway The address now permitted to consume receipts.
    /// @param previous The address that held it before; zero on first wiring.
    event ReviewGatewaySet(address indexed gateway, address indexed previous);

    /// @notice Wire the settler to USDC and the Identity Registry.
    /// @param usdc_ The USDC token address.
    /// @param identityRegistry_ The ERC-8004 Identity Registry address.
    /// @param minPayment_ The minimum payment required (USDC, 6 decimals).
    constructor(address usdc_, address identityRegistry_, uint256 minPayment_) {
        require(usdc_ != address(0), "usdc is zero");
        require(identityRegistry_ != address(0), "identityRegistry is zero");
        require(minPayment_ > 0, "minPayment is zero");

        usdc = IUSDC(usdc_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        minPayment = minPayment_;
        _status = _NOT_ENTERED;
        _configurator = msg.sender;
    }

    /// @notice Reject reentrant entry. The bytes-signature USDC overload can call
    ///         an EIP-1271 wallet during settlement, so settle() is guarded.
    modifier nonReentrant() {
        require(_status != _ENTERED, "reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    /// @dev Restrict to the configured ReviewGateway.
    modifier onlyGateway() {
        require(msg.sender == reviewGateway, "not gateway");
        _;
    }

    /// @notice Name the ReviewGateway that may consume receipts, replacing any
    ///         previous one. Deployer-only.
    /// @dev This pointer is the deployment's single source of truth for which
    ///      gateway is live. The gateway reads it to refuse submissions once it
    ///      has been replaced, and NullifierRegistry reads it to decide who may
    ///      write — so one storage write deactivates the old gateway and
    ///      activates the new one, on every path, with no interval in which both
    ///      are live.
    ///
    ///      Replacement, not one-time, is what makes recovery possible at all: a
    ///      compromised signer or a flawed gateway is answered by deploying a
    ///      replacement and repointing here, which is also why no separate signer
    ///      rotation mechanism exists. A pointer that could be set only once left
    ///      every unspent receipt stranded and the signing key unrotatable.
    ///
    ///      Single transaction rather than propose/accept: nothing on the
    ///      gateway could meaningfully accept, so a second step would add a
    ///      window in which a proposal is pending without proving anything the
    ///      handshake below does not already prove.
    /// @param gateway The ReviewGateway to make active.
    function setReviewGateway(address gateway) external {
        require(msg.sender == _configurator, "not configurator");
        require(gateway != address(0), "zero gateway");
        require(gateway.code.length > 0, "gateway has no code");
        require(gateway != reviewGateway, "gateway unchanged");
        // The candidate must point back here. Catches a typo, an unrelated
        // contract, or a gateway built against another settler — before it
        // becomes the live pointer rather than after.
        require(IReviewGateway(gateway).receiptSettler() == address(this), "gateway settler mismatch");

        // Read unconditionally, so every gateway that ever becomes active is
        // known to expose a readable ledger. Skipping this on first wiring
        // would let a gateway without the getter in, and the first replacement
        // would then be unable to read its predecessor at all.
        address candidateRegistry = IReviewGateway(gateway).nullifierRegistry();
        require(candidateRegistry != address(0), "gateway registry is zero");

        address previous = reviewGateway;
        // Continuity: a successor must keep writing to the same ledger. The
        // settler check above does not cover this — a fresh registry bound to
        // this same settler satisfies it while starting empty, which would
        // reset one-human-one-review on every migration.
        if (previous != address(0)) {
            require(candidateRegistry == IReviewGateway(previous).nullifierRegistry(), "nullifier registry mismatch");
        }

        reviewGateway = gateway;
        emit ReviewGatewaySet(gateway, previous);
    }

    /// @notice Compute the EIP-3009 nonce that binds an authorization to a
    ///         specific agent, order, chain and this settler.
    /// @dev Uses abi.encode (fixed-width, collision-safe) — never encodePacked.
    ///      The signer must use the same formula, so a signature made for one
    ///      (agent, order) cannot be replayed against another.
    /// @param agentId The agent being paid.
    /// @param orderId The caller-supplied order identifier. The (agentId, orderId)
    ///        pair must be unique across all payers using this settler: the nonce
    ///        (and thus the receipt ID) is derived from (agentId, orderId, chainid,
    ///        settler) and does NOT include the payer, so two payers reusing the
    ///        same (agentId, orderId) collide on one receipt.
    /// @return nonce The authorization nonce / receipt ID.
    function _computeNonce(uint256 agentId, bytes32 orderId) internal view returns (bytes32 nonce) {
        return keccak256(abi.encode(agentId, orderId, block.chainid, address(this)));
    }

