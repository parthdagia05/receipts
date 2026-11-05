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

    /// @notice Validate a payment's parameters before any token interaction.
    /// @dev View-only preflight: performs the cheap reverts in order and resolves
    ///      the agent wallet, but does NOT consume the authorization, move tokens,
    ///      write a receipt, or emit an event. settle() uses the returned nonce
    ///      and wallet after this passes.
    /// @param payer The address that signed and will pay.
    /// @param agentId The agent being paid.
    /// @param orderId The caller-supplied order identifier used to derive the nonce.
    /// @param amount The USDC amount to be paid.
    /// @param signedNonce The nonce carried in the signed authorization.
    /// @return nonce The validated nonce (equals the computed nonce / receipt ID).
    /// @return agentWallet The agent's nonzero payment wallet.
    function _validate(address payer, uint256 agentId, bytes32 orderId, uint256 amount, bytes32 signedNonce)
        internal
        view
        returns (bytes32 nonce, address agentWallet)
    {
        require(payer != address(0), "payer is zero");
        require(amount >= minPayment, "amount below minimum");

        nonce = _computeNonce(agentId, orderId);
        require(signedNonce == nonce, "nonce mismatch");

        agentWallet = identityRegistry.getAgentWallet(agentId);
        require(agentWallet != address(0), "agent wallet unset");
        require(agentWallet != address(this), "agent wallet is settler");

        require(receipts[nonce].payer == address(0), "receipt exists");
    }

    /// @notice Settle a signed USDC payment to an agent and record its receipt.
    /// @dev The caller may be a relayer; `payer` is the EIP-3009 signer. Flow:
    ///      validate, record the receipt, pull funds via receiveWithAuthorization
    ///      (to == this settler, as USDC requires), forward the exact amount to
    ///      the agent wallet, then emit. The receipt is written before the token
    ///      calls; if either call reverts the whole transaction reverts, so no
    ///      receipt persists and no funds move — the flow is atomic.
    /// @param payer The address that signed the USDC authorization.
    /// @param agentId The agent being paid.
    /// @param orderId The caller-supplied order identifier; the (agentId, orderId)
    ///        pair must be unique across payers using this settler.
    /// @param amount The USDC amount to pay (>= minPayment).
    /// @param validAfter EIP-3009 validity window start.
    /// @param validBefore EIP-3009 validity window end.
    /// @param signedNonce The nonce carried in the signed authorization.
    /// @param signature The payer's EOA or EIP-1271 signature.
    /// @return receiptId The receipt ID (equals the authorization nonce).
    function settle(
        address payer,
        uint256 agentId,
        bytes32 orderId,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 signedNonce,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 receiptId) {
        // 1-2. Validate inputs; obtain the validated nonce and agent wallet.
        (bytes32 nonce, address agentWallet) = _validate(payer, agentId, orderId, amount, signedNonce);
        receiptId = nonce;

        // 3. Record the receipt before any external token interaction. A later
        //    revert rolls this back, so a persisted receipt always implies a
        //    completed payment.
        receipts[receiptId] = Receipt({
            payer: payer,
            agentId: agentId,
            amount: amount,
            settledAt: uint64(block.timestamp),
            spent: false,
            orderId: orderId
        });

        // 4. Pull funds from the payer into this settler. USDC requires
        //    `to == msg.sender`, so `to` is address(this). The receipt ID is the
        //    authorization nonce.
        usdc.receiveWithAuthorization(payer, address(this), amount, validAfter, validBefore, receiptId, signature);

        // 5-6. Forward the exact amount to the agent wallet; revert if the token
        //      reports failure (some ERC-20s return false instead of reverting).
        bool ok = usdc.transfer(agentWallet, amount);
        require(ok, "usdc transfer failed");

        // 7-8. Record the settlement and return the receipt ID.
        emit ReceiptSettled(receiptId, payer, agentId, amount, agentWallet);
        return receiptId;
    }

    /// @notice Consume a receipt on behalf of the ReviewGateway, marking it spent.
    /// @dev Gateway-only, single source of truth for receipt consumption. Verifies
    ///      existence, unused status, and the expected payer/agent, then sets
    ///      spent = true before returning. Makes no external calls. Amount and
    ///      review-window checks are intentionally left to the gateway, which reads
    ///      them from the returned receipt.
    /// @param receiptId The receipt to consume.
    /// @param expectedPayer The payer the gateway expects (the attested reviewer).
    /// @param expectedAgentId The agent the gateway expects.
    /// @return r The consumed receipt, with spent == true.
    function consume(bytes32 receiptId, address expectedPayer, uint256 expectedAgentId)
        external
        onlyGateway
        returns (Receipt memory r)
    {
        Receipt storage rp = receipts[receiptId];
        require(rp.payer != address(0), "unknown receipt");
        require(!rp.spent, "receipt spent");
        require(rp.payer == expectedPayer, "payer mismatch");
        require(rp.agentId == expectedAgentId, "agent mismatch");

        rp.spent = true;
        return rp;
    }
}
