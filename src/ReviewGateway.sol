// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IReputationRegistry} from "./interfaces/IReputationRegistry.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";
import {IReceiptSettler} from "./interfaces/IReceiptSettler.sol";
import {INullifierRegistry} from "./interfaces/INullifierRegistry.sol";

/// @title ReviewGateway
/// @notice Turnstile for ERC-8004 reviews. Implements Record Server attestation
///         verification, on-chain nullifier tracking, and both free
///         (human-verified) and paid (receipt-verified) review submission.
/// @dev EIP-712 and ECDSA are hand-rolled to avoid any external dependency.
contract ReviewGateway {
    /// @notice A Record Server statement authorizing one exact review: a distinct
    ///         human (nullifier) may post a specific rating and evidence for a
    ///         specific agent, via a specific path, valid until `expiry`.
    /// @param agentId The agent the proof is bound to.
    /// @param nullifier The World ID nullifier for (human, action=review-agent-<id>).
    /// @param reviewer The human's wallet (the World ID signal).
    /// @param expiry Unix time after which the attestation is invalid.
    /// @param value The authorized rating, 0..100.
    /// @param valueDecimals The authorized rating decimals (must be 0).
    /// @param feedbackHash The authorized off-chain evidence hash.
    /// @param feedbackURI The authorized off-chain evidence URI. Signed, so the
    ///        pointer published to ERC-8004 is the one the Record Server attested
    ///        to and cannot be substituted by whoever relays the transaction.
    /// @param reviewType 0 = free (World ID human-verified), 1 = paid
    ///        (receipt-verified), 2 = wallet-verified (NOT a personhood claim).
    /// @param receiptId The receipt to consume for a paid review; 0 for a free review.
    /// @param signature The Record Server's EIP-712 signature over the other fields.
    struct Attestation {
        uint256 agentId;
        bytes32 nullifier;
        address reviewer;
        uint64 expiry;
        int128 value;
        uint8 valueDecimals;
        bytes32 feedbackHash;
        string feedbackURI;
        uint8 reviewType;
        bytes32 receiptId;
        bytes signature;
    }

    /// @notice Emitted after a review is recorded in the ERC-8004 registry.
    /// @dev Self-contained on purpose. ERC-8004 attributes feedback to
    ///      `msg.sender`, which is this gateway rather than the human, so the
    ///      reviewer appears in no other log; and receipt consumption is silent,
    ///      so nothing else ties a review to the payment that authorised it.
    ///      Reconstructing a review previously meant joining this gateway's
    ///      transaction across three contracts and relying on an undocumented
    ///      log ordering. One log now carries the whole association.
    ///
    ///      Emitted last, after `giveFeedback` returns, so it always describes a
    ///      review that was actually recorded rather than one attempted.
    /// @param agentId The agent reviewed.
    /// @param reviewer The human the attestation named.
    /// @param nullifier The World ID nullifier spent on this review.
    /// @param reviewType 0 = free (World ID human-verified), 1 = paid
    ///        (receipt-verified), 2 = wallet-verified (NOT a personhood claim).
    /// @param receiptId The receipt consumed; zero for a free review.
    /// @param feedbackHash The off-chain evidence hash the review commits to.
    event ReviewSubmitted(
        uint256 indexed agentId,
        address indexed reviewer,
        bytes32 indexed nullifier,
        uint8 reviewType,
        bytes32 receiptId,
        bytes32 feedbackHash
    );

    /// @dev reviewType values.
    uint8 private constant _REVIEW_FREE = 0;
    uint8 private constant _REVIEW_PAID = 1;
    uint8 private constant _REVIEW_WALLET = 2;

    /// @dev Domain separator for wallet-review nullifiers.
    ///
    ///      A wallet review has no World ID nullifier, so uniqueness is derived
    ///      from the reviewer address instead. Hashing it with this domain does
    ///      two things: it keeps the one-review-per-identity guard in the same
    ///      shared registry, and it makes a collision with a World ID nullifier
    ///      infeasible. A World ID nullifier is a field element produced by the
    ///      Portal; this is keccak256 over a distinct tagged preimage.
    ///
    ///      Crucially the gateway RECOMPUTES this rather than trusting the
    ///      attestation. If the Record Server supplied the nullifier, a bug or a
    ///      compromised server could hand a second, different nullifier for the
    ///      same wallet and that wallet could review the same agent twice.
    bytes32 private constant _WALLET_NULLIFIER_DOMAIN = keccak256("ReceiptsWalletReview(v1)");

    /// @notice The nullifier a wallet review for `reviewer` must carry.
    /// @dev Exposed so the Record Server and any indexer derive the same value
    ///      the gateway enforces, rather than reimplementing the preimage.
    function walletNullifier(address reviewer) public pure returns (bytes32) {
        return keccak256(abi.encode(_WALLET_NULLIFIER_DOMAIN, reviewer));
    }

    /// @notice The trusted Record Server signer whose attestations are accepted.
    address public immutable recordServerSigner;

    /// @notice The ERC-8004 Reputation Registry this gateway writes feedback to.
    IReputationRegistry public immutable reputationRegistry;

    /// @notice The ERC-8004 Identity Registry used for the owner/operator check.
    IIdentityRegistry public immutable identityRegistry;

    /// @notice The ReceiptSettler whose receipts gate paid reviews.
    IReceiptSettler public immutable receiptSettler;

    /// @notice Minimum payment (USDC, 6 decimals) a receipt must carry for a
    ///         paid review to count.
    uint256 public immutable minPayment;

    /// @notice How long after settlement a receipt may still be reviewed.
    uint256 public constant REVIEW_WINDOW = 30 days;

    /// @notice The shared one-human-one-review ledger.
    /// @dev Held outside this contract so the guard survives gateway
    ///      replacement. A local mapping reset on every migration.
    INullifierRegistry public immutable nullifierRegistry;

    /// @notice Whether a nullifier has been used to review a given agent.
    /// @dev Reads through to the shared registry, so the external view callers
    ///      already depend on keeps working across a replacement.
    function usedNullifier(uint256 agentId, bytes32 nullifier) external view returns (bool used) {
        return nullifierRegistry.isUsed(agentId, nullifier);
    }

    /// @dev Reentrancy guard states and status.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    /// @dev EIP-712 domain typehash.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev Attestation typehash; the signature covers every field except `signature`.
    bytes32 private constant _ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 agentId,bytes32 nullifier,address reviewer,uint64 expiry,int128 value,uint8 valueDecimals,bytes32 feedbackHash,string feedbackURI,uint8 reviewType,bytes32 receiptId)"
    );

    bytes32 private constant _NAME_HASH = keccak256(bytes("ReceiptsReviewGateway"));
    bytes32 private constant _VERSION_HASH = keccak256(bytes("1"));

    /// @dev Upper bound for a low-`s` ECDSA signature (secp256k1n / 2), to reject
    ///      the malleable high-`s` counterpart.
    uint256 private constant _LOW_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @param recordServerSigner_ The trusted Record Server signer address (EOA).
    /// @param reputationRegistry_ The ERC-8004 Reputation Registry.
    /// @param identityRegistry_ The ERC-8004 Identity Registry.
    /// @param receiptSettler_ The ReceiptSettler gating paid reviews.
    /// @param nullifierRegistry_ The shared one-human-one-review ledger.
    /// @param minPayment_ The minimum receipt amount for a paid review.
    constructor(
        address recordServerSigner_,
        address reputationRegistry_,
        address identityRegistry_,
        address receiptSettler_,
        address nullifierRegistry_,
        uint256 minPayment_
    ) {
        require(recordServerSigner_ != address(0), "signer is zero");
        // ecrecover supports EOA (ECDSA) signatures only, not EIP-1271 contract
        // wallets, so a contract signer could never produce a valid attestation.
        require(recordServerSigner_.code.length == 0, "signer must be EOA");
        require(reputationRegistry_ != address(0), "reputation is zero");
        require(reputationRegistry_.code.length > 0, "reputation has no code");
        require(identityRegistry_ != address(0), "identity is zero");
        require(identityRegistry_.code.length > 0, "identity has no code");
        require(receiptSettler_ != address(0), "settler is zero");
        require(receiptSettler_.code.length > 0, "settler has no code");
        require(nullifierRegistry_ != address(0), "registry is zero");
        require(nullifierRegistry_.code.length > 0, "registry has no code");
        // A registry pointed at a different settler would take its write
        // authorization from a pointer this gateway does not answer to.
        require(INullifierRegistry(nullifierRegistry_).receiptSettler() == receiptSettler_, "registry settler mismatch");
        require(minPayment_ > 0, "minPayment is zero");

        recordServerSigner = recordServerSigner_;
        reputationRegistry = IReputationRegistry(reputationRegistry_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        receiptSettler = IReceiptSettler(receiptSettler_);
        nullifierRegistry = INullifierRegistry(nullifierRegistry_);
        minPayment = minPayment_;
        _status = _NOT_ENTERED;
    }

    /// @dev Reject reentrant entry into review submission.
    modifier nonReentrant() {
        require(_status != _ENTERED, "reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    /// @notice The EIP-712 domain separator, computed live so it binds the current
    ///         chain id and this contract address (replay-proof across both).
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    /// @notice The EIP-712 digest for an attestation (its signature is excluded).
    function _digest(Attestation calldata att) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                _ATTESTATION_TYPEHASH,
                att.agentId,
                att.nullifier,
                att.reviewer,
                att.expiry,
                att.value,
                att.valueDecimals,
                att.feedbackHash,
                // EIP-712 encodes a dynamic string as the hash of its contents.
                keccak256(bytes(att.feedbackURI)),
                att.reviewType,
                att.receiptId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// @notice Verify a Record Server attestation; reverts if anything is wrong.
    /// @dev Checks freshness and non-zero fields first, then recovers the EIP-712
    ///      signer and requires it to equal the configured Record Server signer.
    ///      Does NOT consume nullifiers or write any state — verification only.
    /// @param att The attestation to verify.
    function _verifyAttestation(Attestation calldata att) internal view {
        // Both entry points reach here, so a replaced gateway refuses free and
        // paid reviews alike. The settler's pointer is the single source of
        // truth, and it moves in one write, so two gateways are never active.
        require(receiptSettler.reviewGateway() == address(this), "gateway not active");
        require(block.timestamp <= att.expiry, "attestation expired");
        require(att.reviewer != address(0), "zero reviewer");
        require(att.nullifier != bytes32(0), "zero nullifier");

        address signer = _recoverStrict(_digest(att), att.signature);
        require(signer == recordServerSigner, "bad attestation signer");
    }

    /// @notice Mark a nullifier as used for an agent, enforcing one review per
    ///         (agent, human). Reverts if the nullifier is zero or already used.
    /// @dev The one-voice guard, shared by free and paid reviews and now by every
    ///      generation of this gateway. The registry performs the same checks in
    ///      the same order; the write still precedes the registry feedback call,
    ///      so a later revert rolls the consumption back.
    /// @param agentId The agent being reviewed.
    /// @param nullifier The World ID nullifier for (human, action).
    function _consumeNullifier(uint256 agentId, bytes32 nullifier) internal {
        nullifierRegistry.consume(agentId, nullifier);
    }

    /// @notice Submit a free, human-verified review (no payment receipt required).
    /// @dev The attested `att.reviewer` is the reviewer identity, so relayers may
    ///      submit on a human's behalf. Order: range-check the rating, verify the
    ///      attestation, reject owner/operator self-reviews, consume the nullifier,
    ///      then write one ERC-8004 feedback entry. The nullifier is consumed before
    ///      the external registry call, so a registry revert rolls the mark back.
    /// @param att The Record Server attestation (carries the signed rating,
    ///        evidence hash, evidence URI, review type and receiptId).
    function submitFreeReview(Attestation calldata att) external nonReentrant {
        require(att.reviewType == _REVIEW_FREE, "not a free review");
        require(att.receiptId == bytes32(0), "free: receiptId must be zero");
        require(att.value >= 0 && att.value <= 100, "value out of range");
        require(att.valueDecimals == 0, "decimals must be 0");

        _verifyAttestation(att);
        require(!identityRegistry.isAuthorizedOrOwner(att.reviewer, att.agentId), "reviewer is owner/operator");

        _consumeNullifier(att.agentId, att.nullifier);

        _writeFreeFeedback(att.agentId, att.value, att.valueDecimals, att.feedbackURI, att.feedbackHash);

        emit ReviewSubmitted(att.agentId, att.reviewer, att.nullifier, att.reviewType, att.receiptId, att.feedbackHash);
    }

    /// @dev Write one free (human-verified) feedback entry to ERC-8004. Isolated in
    ///      its own frame to keep the many-argument external call off the caller's
    ///      stack. tag1 = "quality", tag2 = "human-verified", endpoint = "".
    function _writeFreeFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        reputationRegistry.giveFeedback(
            agentId, value, valueDecimals, "quality", "human-verified", "", feedbackURI, feedbackHash
        );
    }

    /// @notice Submit a paid, receipt-verified review.
    /// @dev Like submitFreeReview but additionally consumes a ReceiptSettler
    ///      receipt bound to (reviewer, agent) and enforces the minimum payment
    ///      and 30-day review window. The attested `att.reviewer` is the reviewer
    ///      identity, so relayers may submit. Order: range-check, verify attestation,
    ///      owner/operator check, consume the receipt, check amount and window,
    ///      consume the nullifier, then write feedback. Receipt consumption and the
    ///      nullifier mark precede the registry write, so any later revert rolls both
    ///      back — the receipt stays unspent and the nullifier unused.
    /// @param att The Record Server attestation (carries the signed rating,
    ///        evidence hash, evidence URI, review type and the receiptId to consume).
    function submitPaidReview(Attestation calldata att) external nonReentrant {
        require(att.reviewType == _REVIEW_PAID, "not a paid review");
        require(att.receiptId != bytes32(0), "paid: receiptId required");
        require(att.value >= 0 && att.value <= 100, "value out of range");
        require(att.valueDecimals == 0, "decimals must be 0");

        _verifyAttestation(att);
        require(!identityRegistry.isAuthorizedOrOwner(att.reviewer, att.agentId), "reviewer is owner/operator");

        IReceiptSettler.Receipt memory r = receiptSettler.consume(att.receiptId, att.reviewer, att.agentId);
        require(r.amount >= minPayment, "payment below minimum");
        require(block.timestamp <= uint256(r.settledAt) + REVIEW_WINDOW, "review window passed");

        _consumeNullifier(att.agentId, att.nullifier);

        _writePaidFeedback(att.agentId, att.value, att.valueDecimals, att.feedbackURI, att.feedbackHash);

        emit ReviewSubmitted(att.agentId, att.reviewer, att.nullifier, att.reviewType, att.receiptId, att.feedbackHash);
    }

    /// @notice Submit a wallet-verified review.
    ///
    /// @dev The accessible fallback for reviewers without an Orb-issued World ID
    ///      Proof of Human credential. It is a STRICTLY WEAKER claim and is
    ///      recorded as such: ERC-8004 tag2 is "wallet-verified", never
    ///      "human-verified". A wallet is not a person — one human can hold any
    ///      number of them — so this path establishes that a specific address
    ///      authorised a specific review, and nothing about uniqueness of the
    ///      human behind it. Anything consuming these reviews must weight them
    ///      accordingly; the reputation engine keeps them in a separate bucket.
    ///
    ///      Uniqueness is one review per WALLET per agent, enforced on-chain:
    ///      the nullifier is recomputed here from the reviewer address, so the
    ///      attestation cannot smuggle in a second nullifier for the same wallet.
    ///      It shares the registry with World ID nullifiers, which is safe
    ///      because of the domain separation in `walletNullifier`.
    ///
    ///      Order matches the other two paths: range-check, verify attestation,
    ///      owner/operator check, consume the nullifier, then write feedback, so
    ///      a later revert rolls the nullifier mark back.
    /// @param att The Record Server attestation. `receiptId` must be zero and
    ///        `nullifier` must equal `walletNullifier(att.reviewer)`.
    function submitWalletReview(Attestation calldata att) external nonReentrant {
        require(att.reviewType == _REVIEW_WALLET, "not a wallet review");
        require(att.receiptId == bytes32(0), "wallet: receiptId must be zero");
        require(att.value >= 0 && att.value <= 100, "value out of range");
        require(att.valueDecimals == 0, "decimals must be 0");
        require(att.nullifier == walletNullifier(att.reviewer), "wallet: bad nullifier");

        _verifyAttestation(att);
        require(!identityRegistry.isAuthorizedOrOwner(att.reviewer, att.agentId), "reviewer is owner/operator");

        _consumeNullifier(att.agentId, att.nullifier);

        _writeWalletFeedback(att.agentId, att.value, att.valueDecimals, att.feedbackURI, att.feedbackHash);

        emit ReviewSubmitted(att.agentId, att.reviewer, att.nullifier, att.reviewType, att.receiptId, att.feedbackHash);
    }

    /// @dev Write one wallet-verified feedback entry to ERC-8004. Isolated in its
    ///      own frame to keep the many-argument external call off the caller's
    ///      stack. tag1 = "quality", tag2 = "wallet-verified", endpoint = "".
    ///
    ///      The tag is the whole point: it is the permanent, on-chain statement
    ///      of what was actually proven. Reusing "human-verified" here would
    ///      make every consumer of ERC-8004 feedback believe a wallet signature
    ///      established personhood.
    function _writeWalletFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        reputationRegistry.giveFeedback(
            agentId, value, valueDecimals, "quality", "wallet-verified", "", feedbackURI, feedbackHash
        );
    }

    /// @dev Write one paid (receipt-verified) feedback entry to ERC-8004. Isolated
    ///      in its own frame to keep the many-argument external call off the
    ///      caller's stack. tag1 = "quality", tag2 = "receipt-verified", endpoint = "".
    function _writePaidFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) internal {
        reputationRegistry.giveFeedback(
            agentId, value, valueDecimals, "quality", "receipt-verified", "", feedbackURI, feedbackHash
        );
    }

    /// @notice Strict ECDSA recovery: exact 65-byte length, low-`s`, canonical `v`,
    ///         and a nonzero recovered address.
    function _recoverStrict(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "bad signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        require(uint256(s) <= _LOW_S_MAX, "invalid signature s");
        require(v == 27 || v == 28, "invalid signature v");

        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signer");
        return signer;
    }
}
