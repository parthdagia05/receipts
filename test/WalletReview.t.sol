// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {MockIdentityRegistry, MockReceiptSettler, MockReputationRegistry} from "./ReviewGateway.t.sol";

/// @dev The wallet-verified review path.
///
/// A wallet review is the accessible fallback for reviewers without an
/// Orb-issued World ID credential. It proves that an address authorised a
/// review and NOTHING about the uniqueness of the human behind it, so the
/// tests below are mostly about making sure that weaker claim cannot be
/// dressed up as a stronger one:
///
///   - it is tagged "wallet-verified" on chain, never "human-verified";
///   - one wallet gets one review per agent, enforced by the gateway rather
///     than trusted from the attestation;
///   - every guard the free path has still applies.
contract WalletReviewTest is Test {
    ReviewGateway internal gw;

    address internal signer;
    uint256 internal signerKey;

    MockReputationRegistry internal rep;
    MockIdentityRegistry internal id;
    MockReceiptSettler internal settler;
    NullifierRegistry internal nullifiers;

    uint256 internal constant AGENT_ID = 1;
    uint256 internal constant OTHER_AGENT = 2;
    uint256 internal constant MIN_PAYMENT = 1_000_000;

    address internal reviewer = makeAddr("walletReviewer");
    address internal otherReviewer = makeAddr("otherWalletReviewer");
    address internal relayer = makeAddr("relayer");

    uint64 internal constant FUTURE = 1 hours;
    bytes32 internal constant HASH = keccak256("wallet-evidence");
    string internal constant URI = "ipfs://wallet";
    int128 internal constant VALUE = 75;

    uint8 internal constant REVIEW_FREE = 0;
    uint8 internal constant REVIEW_PAID = 1;
    uint8 internal constant REVIEW_WALLET = 2;

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("recordServer");
        rep = new MockReputationRegistry();
        id = new MockIdentityRegistry();
        settler = new MockReceiptSettler();
        nullifiers = new NullifierRegistry(address(settler));
        gw = new ReviewGateway(signer, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT);
        settler.setReviewGateway(address(gw));
    }

    // --- helpers -----------------------------------------------------------

    function _sign(uint256 key, ReviewGateway.Attestation memory a) internal view {
        bytes32 digest = _digest(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        a.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Rebuilds the gateway's EIP-712 digest. Written out rather than read
    ///      from the contract so a change to the typehash breaks these tests
    ///      instead of silently signing whatever the contract now expects.
    function _digest(ReviewGateway.Attestation memory a) internal view returns (bytes32) {
        return _digestOnChain(a, block.chainid);
    }

    /// @dev The digest as it would be signed on `chainId`. Taking the chain id
    ///      as a parameter rather than reaching for `vm.chainId` matters: that
    ///      cheatcode is a no-op here (block.chainid stays put), so a test built
    ///      on it signs and verifies on the SAME chain and can never fail. This
    ///      form tests the real property — a signature whose EIP-712 domain
    ///      names another chain must be rejected.
    function _digestOnChain(ReviewGateway.Attestation memory a, uint256 chainId) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("ReceiptsReviewGateway")),
                keccak256(bytes("1")),
                chainId,
                address(gw)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Attestation(uint256 agentId,bytes32 nullifier,address reviewer,uint64 expiry,int128 value,uint8 valueDecimals,bytes32 feedbackHash,string feedbackURI,uint8 reviewType,bytes32 receiptId)"
                ),
                a.agentId,
                a.nullifier,
                a.reviewer,
                a.expiry,
                a.value,
                a.valueDecimals,
                a.feedbackHash,
                keccak256(bytes(a.feedbackURI)),
                a.reviewType,
                a.receiptId
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _walletAtt(uint256 agentId, address rev) internal view returns (ReviewGateway.Attestation memory a) {
        a.agentId = agentId;
        a.nullifier = gw.walletNullifier(rev);
        a.reviewer = rev;
        a.expiry = uint64(block.timestamp) + FUTURE;
        a.value = VALUE;
        a.valueDecimals = 0;
        a.feedbackHash = HASH;
        a.feedbackURI = URI;
        a.reviewType = REVIEW_WALLET;
        a.receiptId = bytes32(0);
        _sign(signerKey, a);
    }

    // --- the happy path ----------------------------------------------------

    function test_WalletReview_Succeeds() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.prank(relayer);
        gw.submitWalletReview(a);

        assertTrue(gw.usedNullifier(AGENT_ID, gw.walletNullifier(reviewer)), "nullifier not consumed");
        assertEq(rep.callCount(), 1, "feedback not written");
    }

    /// The whole reason this path needed a new contract: the on-chain tag is
    /// the permanent statement of what was actually proven.
    function test_WalletReview_IsTaggedWalletVerified_NotHumanVerified() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.prank(relayer);
        gw.submitWalletReview(a);

        assertEq(rep.lastTag2(), "wallet-verified", "wallet review must not claim human verification");
        assertEq(rep.lastTag1(), "quality");
    }

    function test_WalletReview_EmitsReviewTypeTwo() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.expectEmit(true, true, true, true);
        emit ReviewGateway.ReviewSubmitted(
            AGENT_ID, reviewer, gw.walletNullifier(reviewer), REVIEW_WALLET, bytes32(0), HASH
        );
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    // --- one wallet, one review per agent ----------------------------------

    function test_Rejects_DuplicateWalletForSameAgent() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.prank(relayer);
        gw.submitWalletReview(a);

        // A fresh, validly signed attestation for the same wallet and agent.
        ReviewGateway.Attestation memory again = _walletAtt(AGENT_ID, reviewer);
        vm.expectRevert(bytes("nullifier used"));
        vm.prank(relayer);
        gw.submitWalletReview(again);
    }

    /// Replay of the identical bytes, not merely a second review.
    function test_Rejects_ReplayOfTheSameAttestation() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.prank(relayer);
        gw.submitWalletReview(a);

        vm.expectRevert(bytes("nullifier used"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_SameWalletMayReviewADifferentAgent() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.prank(relayer);
        gw.submitWalletReview(a);

        ReviewGateway.Attestation memory b = _walletAtt(OTHER_AGENT, reviewer);
        vm.prank(relayer);
        gw.submitWalletReview(b);

        assertEq(rep.callCount(), 2, "second agent should accept the same wallet");
    }

    function test_DifferentWalletsMayReviewTheSameAgent() public {
        vm.prank(relayer);
        gw.submitWalletReview(_walletAtt(AGENT_ID, reviewer));
        vm.prank(relayer);
        gw.submitWalletReview(_walletAtt(AGENT_ID, otherReviewer));

        assertEq(rep.callCount(), 2);
    }

    /// The guard that makes the uniqueness claim real: the gateway recomputes
    /// the nullifier, so an attestation naming a different one is refused even
    /// though the Record Server signed it.
    function test_Rejects_NullifierNotDerivedFromTheReviewer() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.nullifier = keccak256("a nullifier of my choosing");
        _sign(signerKey, a);

        vm.expectRevert(bytes("wallet: bad nullifier"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    /// Without this, one wallet could review twice by borrowing another
    /// wallet's nullifier.
    function test_Rejects_NullifierOfAnotherWallet() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.nullifier = gw.walletNullifier(otherReviewer);
        _sign(signerKey, a);

        vm.expectRevert(bytes("wallet: bad nullifier"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    // --- signature and authorisation ---------------------------------------

    function test_Rejects_InvalidSigner() public {
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        _sign(impostorKey, a);

        vm.expectRevert(bytes("bad attestation signer"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_Rejects_TamperedValueAfterSigning() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.value = 100; // raise the rating without re-signing
        vm.expectRevert(bytes("bad attestation signer"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_Rejects_ExpiredAttestation() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.warp(block.timestamp + FUTURE + 1);

        vm.expectRevert(bytes("attestation expired"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    /// A signature is bound to one chain by the EIP-712 domain. Re-signing on
    /// another chain id must not produce a digest this gateway accepts.
    function test_Rejects_SignatureFromAnotherChain() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);

        // Re-sign the identical attestation against a different chain id.
        bytes32 foreign = _digestOnChain(a, block.chainid + 1);
        (uint8 v, bytes32 r, bytes32 s2) = vm.sign(signerKey, foreign);
        a.signature = abi.encodePacked(r, s2, v);

        // Sanity: the two digests really do differ, so this test can fail.
        assertTrue(foreign != _digest(a), "domain does not bind the chain id");

        vm.expectRevert(bytes("bad attestation signer"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    /// The domain binds the verifying contract too: a signature for one gateway
    /// must not be replayable against a replacement deployed later.
    function test_Rejects_SignatureForAnotherGateway() public {
        ReviewGateway other =
            new ReviewGateway(signer, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT);
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);

        settler.setReviewGateway(address(other));
        vm.expectRevert(bytes("bad attestation signer"));
        vm.prank(relayer);
        other.submitWalletReview(a);
    }

    /// Signed for agent 1, submitted against agent 1 but with the struct's
    /// agentId changed afterwards.
    function test_Rejects_WrongAgentId() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.agentId = OTHER_AGENT;
        vm.expectRevert(bytes("bad attestation signer"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_Rejects_WhenReviewerOwnsTheAgent() public {
        id.setAuthorized(reviewer, AGENT_ID, true);
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);

        vm.expectRevert(bytes("reviewer is owner/operator"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    // --- field validation ---------------------------------------------------

    function test_Rejects_RatingAbove100() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.value = 101;
        _sign(signerKey, a);

        vm.expectRevert(bytes("value out of range"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_Rejects_NegativeRating() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.value = -1;
        _sign(signerKey, a);

        vm.expectRevert(bytes("value out of range"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_Rejects_NonZeroDecimals() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.valueDecimals = 2;
        _sign(signerKey, a);

        vm.expectRevert(bytes("decimals must be 0"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    function test_Rejects_ReceiptIdOnTheWalletPath() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.receiptId = keccak256("some-receipt");
        _sign(signerKey, a);

        vm.expectRevert(bytes("wallet: receiptId must be zero"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    // --- the paths must not be interchangeable -----------------------------

    function test_Rejects_FreeTypeOnTheWalletEntryPoint() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        a.reviewType = REVIEW_FREE;
        _sign(signerKey, a);

        vm.expectRevert(bytes("not a wallet review"));
        vm.prank(relayer);
        gw.submitWalletReview(a);
    }

    /// The important direction: a wallet attestation must not be submittable
    /// through the free entry point, where it would be tagged human-verified.
    function test_Rejects_WalletTypeOnTheFreeEntryPoint() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.expectRevert(bytes("not a free review"));
        vm.prank(relayer);
        gw.submitFreeReview(a);
    }

    function test_Rejects_WalletTypeOnThePaidEntryPoint() public {
        ReviewGateway.Attestation memory a = _walletAtt(AGENT_ID, reviewer);
        vm.expectRevert(bytes("not a paid review"));
        vm.prank(relayer);
        gw.submitPaidReview(a);
    }

    // --- the shared registry is shared -------------------------------------

    /// A World ID nullifier and a wallet nullifier live in the same registry.
    /// Domain separation keeps them from colliding, and a wallet review must
    /// not consume a World ID holder's slot or vice versa.
    function test_WalletNullifierIsDomainSeparated() public view {
        assertTrue(
            gw.walletNullifier(reviewer) != keccak256(abi.encode(reviewer)),
            "wallet nullifier must not be a bare hash of the address"
        );
        assertTrue(gw.walletNullifier(reviewer) != gw.walletNullifier(otherReviewer));
        assertTrue(gw.walletNullifier(reviewer) != bytes32(0));
    }

    function test_WalletReviewDoesNotBlockAWorldIdReviewOfTheSameAgent() public {
        vm.prank(relayer);
        gw.submitWalletReview(_walletAtt(AGENT_ID, reviewer));

        // A World ID review by the same person, carrying a Portal nullifier.
        ReviewGateway.Attestation memory free;
        free.agentId = AGENT_ID;
        free.nullifier = keccak256("a world id nullifier");
        free.reviewer = reviewer;
        free.expiry = uint64(block.timestamp) + FUTURE;
        free.value = 80;
        free.valueDecimals = 0;
        free.feedbackHash = keccak256("free-evidence");
        free.feedbackURI = "ipfs://free";
        free.reviewType = REVIEW_FREE;
        free.receiptId = bytes32(0);
        _sign(signerKey, free);

        vm.prank(relayer);
        gw.submitFreeReview(free);

        assertEq(rep.callCount(), 2, "the two paths share a registry but not a slot");
    }
}
