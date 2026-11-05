// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {
    MockIdentityRegistry,
    MockReceiptSettler,
    MockReputationRegistry,
    ReviewGatewayHarness
} from "./ReviewGateway.t.sol";

/// @title PaidRecordServerAcceptance
/// @notice Proves the real ReviewGateway accepts the paid attestation produced by
///         the real TypeScript Record Server signer.
/// @dev Companion to RecordServerAcceptanceTest, which does the same for the free
///      path. The values below are the golden paid vector emitted by
///      `createAttestationSigner` and frozen in
///      `server/test/paidAttestationVector.ts`. Nothing here is recomputed: the
///      signature is the exact 65 bytes the server produced and the digest is the
///      exact 32 bytes it hashed, so this test fails if either language's EIP-712
///      encoding moves.
///
///      `server/test/paidAttestationVector.test.ts` guards the other direction, by
///      asserting the TypeScript signer still emits precisely these bytes.
contract PaidRecordServerAcceptanceTest is Test {
    /// @dev The server signed under this domain, so the gateway must live at this
    ///      address on this chain. `_domainSeparator()` reads `block.chainid` and
    ///      `address(this)` at call time, so setting both is sufficient.
    uint256 internal constant VECTOR_CHAIN_ID = 11155111;
    address internal constant VECTOR_GATEWAY = 0x2222222222222222222222222222222222222222;

    /// @dev Derived from the test-only key `0xa1…a1` in the fixture.
    address internal constant VECTOR_SIGNER = 0x5d5c99EdF529335160FF180fA141Dd4967fc00D2;

    // The nine signed fields, exactly as the server signed them.
    uint256 internal constant V_AGENT_ID = 18446744073709551617; // 2**64 + 1
    bytes32 internal constant V_NULLIFIER = 0x0000000000000000000000157ee2de15fd7333af23d76e19c99051cfd1fd3f17;
    address internal constant V_REVIEWER = 0x4444444444444444444444444444444444444444;
    uint64 internal constant V_EXPIRY = 1850000000;
    int128 internal constant V_VALUE = 91;
    uint8 internal constant V_VALUE_DECIMALS = 0;
    bytes32 internal constant V_FEEDBACK_HASH = 0x7c43dd8a842b6b95a9b1e0d43296a4948d6719d0e2e2f6350d3266124173232c;
    /// @dev Derived by the Record Server from V_FEEDBACK_HASH, and signed.
    string internal constant V_FEEDBACK_URI =
        "https://receipts.test/reviews/0x7c43dd8a842b6b95a9b1e0d43296a4948d6719d0e2e2f6350d3266124173232c";
    uint8 internal constant V_REVIEW_TYPE = 1; // paid
    bytes32 internal constant V_RECEIPT_ID = 0x3841de09140455934c197fe8f768c7ea23d15c63cfc07e4ecd893f60bbab3405;

    /// @dev The EIP-712 digest the server hashed, and its signature over it.
    bytes32 internal constant V_DIGEST = 0xff84cbcc6e9211dd1d02b381d2d46a72b1bf2e598a987a0f497e793e961f3d31;
    bytes internal constant V_SIGNATURE =
        hex"8bb0ad28dc011cd063c8e440dc5ab79d3fc04ab2b5f5012c293812ee7cc4cefd17c8bbccb47ee641202409ae068ab75a6a1889b15d6f3989db7682126abbf88f1b";

    uint256 internal constant MIN_PAYMENT = 1_000_000; // 1 USDC
    uint256 internal constant PAID_AMOUNT = 5_000_000; // 5 USDC

    /// @dev Inside the attestation's validity window, and inside the receipt's.
    uint256 internal constant REVIEW_TIME = 1_800_000_000;
    uint64 internal constant SETTLED_AT = uint64(REVIEW_TIME - 1 days);

    ReviewGateway internal gateway;
    MockReputationRegistry internal rep;
    MockIdentityRegistry internal id;
    MockReceiptSettler internal settler;
    NullifierRegistry internal nullifiers;

    function setUp() public {
        // The signed domain binds this chain id.
        vm.chainId(VECTOR_CHAIN_ID);

        rep = new MockReputationRegistry();
        id = new MockIdentityRegistry();
        settler = new MockReceiptSettler();
        nullifiers = new NullifierRegistry(address(settler));

        // Place the gateway at the address the server signed for. deployCodeTo
        // runs the creation code at `where`, so the constructor's requires and
        // immutables behave exactly as a normal deployment.
        deployCodeTo(
            "ReviewGateway.sol:ReviewGateway",
            abi.encode(VECTOR_SIGNER, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT),
            VECTOR_GATEWAY
        );
        gateway = ReviewGateway(VECTOR_GATEWAY);
        // The settler names the active gateway; submissions are refused otherwise.
        settler.setReviewGateway(VECTOR_GATEWAY);

        vm.warp(REVIEW_TIME);

        // The receipt the signed receiptId points at: paid by the attested
        // reviewer, for the attested agent, recently enough to still review.
        settler.setReceipt(V_RECEIPT_ID, V_REVIEWER, V_AGENT_ID, PAID_AMOUNT, SETTLED_AT);
    }

    /// @notice Build the struct from the vector, optionally with one field changed.
    function _attestation() internal pure returns (ReviewGateway.Attestation memory a) {
        a = ReviewGateway.Attestation({
            agentId: V_AGENT_ID,
            nullifier: V_NULLIFIER,
            reviewer: V_REVIEWER,
            expiry: V_EXPIRY,
            value: V_VALUE,
            valueDecimals: V_VALUE_DECIMALS,
            feedbackHash: V_FEEDBACK_HASH,
            feedbackURI: V_FEEDBACK_URI,
            reviewType: V_REVIEW_TYPE,
            receiptId: V_RECEIPT_ID,
            signature: V_SIGNATURE
        });
    }

    function _receiptSpent(bytes32 receiptId) internal view returns (bool spent) {
        (,,,, spent,) = settler.receipts(receiptId);
    }

    /// @dev Every rejection must leave all three pieces of state untouched. A
    ///      revert alone would not prove that: the gateway marks the nullifier and
    ///      spends the receipt before writing feedback, so a rejection that failed
    ///      to roll those back would still revert while leaking a consumed receipt.
    function _assertNothingConsumed() internal view {
        assertEq(rep.callCount(), 0, "no feedback written");
        assertFalse(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "nullifier still unused");
        assertFalse(_receiptSpent(V_RECEIPT_ID), "receipt still unspent");
    }

    // --- the deployment the vector assumes ---

    function test_Setup_GatewayIsAtTheSignedAddress() public view {
        assertEq(address(gateway), VECTOR_GATEWAY, "gateway address");
        assertGt(VECTOR_GATEWAY.code.length, 0, "gateway deployed");
    }

    function test_Setup_ChainIdMatchesTheSignedDomain() public view {
        assertEq(block.chainid, VECTOR_CHAIN_ID, "chain id");
    }

    function test_Setup_SignerIsTheRecordServer() public view {
        assertEq(gateway.recordServerSigner(), VECTOR_SIGNER, "recordServerSigner");
    }

    // --- the digest and the recovered signer ---

    /// @notice The gateway hashes the vector to exactly the digest TypeScript
    ///         hashed, and recovers exactly the signer TypeScript signed with.
    /// @dev The harness subclasses ReviewGateway, so deploying it at the signed
    ///      address reproduces the same domain separator and the same `_digest`.
    ///      This is the only place the two languages' digests are compared
    ///      directly; every other test compares behavior.
    function test_Digest_AndRecoveredSignerMatchTheVector() public {
        deployCodeTo(
            "ReviewGateway.t.sol:ReviewGatewayHarness",
            abi.encode(VECTOR_SIGNER, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT),
            VECTOR_GATEWAY
        );
        ReviewGatewayHarness harness = ReviewGatewayHarness(VECTOR_GATEWAY);

        assertEq(harness.digestOf(_attestation()), V_DIGEST, "digest matches the TypeScript digest");

        // verify() recovers the signature and requires the recovered address to
        // equal recordServerSigner, so returning without reverting is the
        // assertion that recovery landed on VECTOR_SIGNER.
        harness.verify(_attestation());
    }

    /// @dev Put the harness at the signed address, so `digestOf` is computed
    ///      under the production domain separator rather than some other one.
    function _harnessAtSignedAddress() internal returns (ReviewGatewayHarness) {
        deployCodeTo(
            "ReviewGateway.t.sol:ReviewGatewayHarness",
            abi.encode(VECTOR_SIGNER, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT),
            VECTOR_GATEWAY
        );
        return ReviewGatewayHarness(VECTOR_GATEWAY);
    }

    // --- fields the entry point rejects before it ever hashes ---
    // `valueDecimals` must be 0 and `reviewType` must be 1 on the paid path, so
    // every mutation of them is one submitPaidReview() refuses up front — see
    // test_Rejects_InvalidValueDecimals and test_Rejects_FreeReviewTypeOnThePaid-
    // Entrypoint, which still hold. That refusal is correct, but it cannot answer
    // whether the field is inside the signature at all. Hashing directly can.
    // The unmutated baseline is asserted in
    // test_Digest_AndRecoveredSignerMatchTheVector, so these comparisons are
    // anchored to the frozen digest rather than to each other.

    function test_Digest_ChangesWithValueDecimals() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.valueDecimals = 1;

        assertNotEq(_harnessAtSignedAddress().digestOf(a), V_DIGEST, "valueDecimals is a signed field");
    }

    function test_Digest_ChangesWithReviewType() public {
        // 1 -> 0 is the paid/free flip the two entry points distinguish.
        ReviewGateway.Attestation memory a = _attestation();
        a.reviewType = 0;

        assertNotEq(_harnessAtSignedAddress().digestOf(a), V_DIGEST, "reviewType is a signed field");
    }

    // --- acceptance ---

    function test_Accepts_PaidRecordServerAttestation() public {
        gateway.submitPaidReview(_attestation());

        assertTrue(rep.called(), "feedback written");
        assertEq(rep.callCount(), 1, "one feedback entry");
    }

    function test_Accepts_WritesTheExpectedErc8004Feedback() public {
        gateway.submitPaidReview(_attestation());

        assertEq(rep.lastAgentId(), V_AGENT_ID, "agentId");
        assertEq(rep.lastValue(), V_VALUE, "value");
        assertEq(rep.lastValueDecimals(), V_VALUE_DECIMALS, "valueDecimals");
        assertEq(rep.lastTag1(), "quality", "tag1");
        // The paid path's distinguishing mark: a free review writes
        // "human-verified" here.
        assertEq(rep.lastTag2(), "receipt-verified", "tag2");
        assertEq(rep.lastEndpoint(), "", "endpoint");
        assertEq(rep.lastFeedbackURI(), V_FEEDBACK_URI, "feedbackURI");
        assertEq(rep.lastFeedbackHash(), V_FEEDBACK_HASH, "feedbackHash");
    }

    function test_Accepts_PreservesAgentIdBeyondUint64() public {
        // 2**64 + 1 would arrive as 1 if anything in the chain had truncated it
        // to uint64, and as ...616 if it had gone through a double.
        gateway.submitPaidReview(_attestation());

        assertEq(rep.lastAgentId(), 18446744073709551617, "agentId exact");
    }

    function test_Accepts_ConsumesTheReceipt() public {
        assertFalse(_receiptSpent(V_RECEIPT_ID), "unspent before");

        gateway.submitPaidReview(_attestation());

        assertTrue(_receiptSpent(V_RECEIPT_ID), "spent after");
    }

    function test_Accepts_ConsumesTheNullifier() public {
        assertFalse(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "unused before");

        gateway.submitPaidReview(_attestation());

        assertTrue(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "consumed after");
    }

    function test_Accepts_PreservesTheSignedReceiptId() public {
        // The receiptId the server signed is the one consumed: the mock only
        // marks the receipt stored under that exact id.
        gateway.submitPaidReview(_attestation());

        assertTrue(_receiptSpent(V_RECEIPT_ID), "signed receipt consumed");
        assertFalse(_receiptSpent(bytes32(0)), "no other receipt touched");

        (address payer, uint256 agentId_, uint256 amount,,,) = settler.receipts(V_RECEIPT_ID);
        assertEq(payer, V_REVIEWER, "receipt payer is the attested reviewer");
        assertEq(agentId_, V_AGENT_ID, "receipt agent is the attested agent");
        assertEq(amount, PAID_AMOUNT, "receipt amount untouched");
    }

    function test_Accepts_AtTheExactExpiry() public {
        // The gateway's check is inclusive: block.timestamp <= expiry. Move the
        // receipt forward too, so the review window is not what is being tested.
        settler.setReceipt(V_RECEIPT_ID, V_REVIEWER, V_AGENT_ID, PAID_AMOUNT, uint64(uint256(V_EXPIRY) - 1 days));
        vm.warp(uint256(V_EXPIRY));

        gateway.submitPaidReview(_attestation());
        assertEq(rep.callCount(), 1, "accepted at the boundary");
    }

    // --- replay ---

    /// @notice The same paid attestation cannot be submitted twice.
    /// @dev The receipt is consumed before the nullifier, so the settler rejects
    ///      the replay first and "nullifier used" is unreachable on this path with
    ///      a single frozen vector. Both guards are asserted to still hold.
    function test_Rejects_ReplayOfTheSameAttestation() public {
        gateway.submitPaidReview(_attestation());

        vm.expectRevert("receipt spent");
        gateway.submitPaidReview(_attestation());

        assertEq(rep.callCount(), 1, "still one feedback entry");
        assertTrue(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "nullifier stays consumed");
        assertTrue(_receiptSpent(V_RECEIPT_ID), "receipt stays spent");
    }

    // --- the signature binds every signed field ---
    // Each mutates one signed field and leaves the server's signature alone, so
    // recovery lands on a different address. These reach _verifyAttestation,
    // unlike the validation failures further down.

    function test_Rejects_TamperedAgentId() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.agentId = V_AGENT_ID + 1;

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_TamperedNullifier() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.nullifier = keccak256("not the signed nullifier");

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_TamperedReviewer() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.reviewer = address(0x9999);

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_TamperedExpiry() public {
        // Extended, not shortened: shortening it past `now` would trip the
        // freshness check before recovery and prove nothing about the signature.
        ReviewGateway.Attestation memory a = _attestation();
        a.expiry = V_EXPIRY + 1;

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_TamperedValue() public {
        // 92 is still inside 0..100, so the range check passes and the
        // rejection comes from recovery.
        ReviewGateway.Attestation memory a = _attestation();
        a.value = 92;

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_TamperedFeedbackHash() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackHash = bytes32(uint256(0xdead));

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_TamperedReceiptId() public {
        // Points at a second, genuinely valid receipt. Only the signature stops
        // this, which is the point: a reviewer must not redirect an attestation
        // onto someone else's payment.
        bytes32 otherReceipt = keccak256("another-receipt");
        settler.setReceipt(otherReceipt, V_REVIEWER, V_AGENT_ID, PAID_AMOUNT, SETTLED_AT);

        ReviewGateway.Attestation memory a = _attestation();
        a.receiptId = otherReceipt;

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
        assertFalse(_receiptSpent(otherReceipt), "substituted receipt untouched");
    }

    function test_Rejects_TamperedSignature() public {
        ReviewGateway.Attestation memory a = _attestation();
        bytes memory sig = V_SIGNATURE;
        sig[0] = bytes1(uint8(sig[0]) ^ 0xff);
        a.signature = sig;

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    // --- validation that fires before signature recovery ---
    // These fields are rejected by a require() ahead of _verifyAttestation, so
    // the signature is never recovered. The distinct revert strings are what
    // prove the ordering.

    function test_Rejects_InvalidValueDecimals() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.valueDecimals = 1;

        vm.expectRevert("decimals must be 0");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_ValueOutOfRange() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.value = 101;

        vm.expectRevert("value out of range");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_ZeroReceiptIdOnThePaidPath() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.receiptId = bytes32(0);

        vm.expectRevert("paid: receiptId required");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_FreeReviewTypeOnThePaidEntrypoint() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.reviewType = 0;

        vm.expectRevert("not a paid review");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_UnknownReviewTypeOnThePaidEntrypoint() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.reviewType = 2;

        vm.expectRevert("not a paid review");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Rejects_PaidVectorOnTheFreeEntrypoint() public {
        // reviewType 1 was signed, so the free entry point must refuse it. The
        // mirror of RecordServerAcceptanceTest's free-vector-on-paid test.
        vm.expectRevert("not a free review");
        gateway.submitFreeReview(_attestation());

        _assertNothingConsumed();
    }

    // --- the domain binds the deployment ---

    function test_Rejects_OnADifferentChain() public {
        // The same bytes, a different chain id: the domain separator moves, so
        // recovery yields someone else.
        vm.chainId(VECTOR_CHAIN_ID + 1);

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    function test_Rejects_AtADifferentGatewayAddress() public {
        // An identical gateway elsewhere must not accept this attestation.
        address elsewhere = address(0xBEEF);
        deployCodeTo(
            "ReviewGateway.sol:ReviewGateway",
            abi.encode(VECTOR_SIGNER, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT),
            elsewhere
        );
        // Make it active, so the rejection below is the domain separator doing
        // its job rather than the active-gateway check short-circuiting it.
        settler.setReviewGateway(elsewhere);

        vm.expectRevert("bad attestation signer");
        ReviewGateway(elsewhere).submitPaidReview(_attestation());

        _assertNothingConsumed();
        assertFalse(ReviewGateway(elsewhere).usedNullifier(V_AGENT_ID, V_NULLIFIER), "other gateway untouched");
    }

    function test_Rejects_UnderADifferentRecordServerSigner() public {
        // Same domain, same bytes, a gateway configured to trust someone else.
        address otherSigner = address(0xA11CE);
        deployCodeTo(
            "ReviewGateway.sol:ReviewGateway",
            abi.encode(otherSigner, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT),
            VECTOR_GATEWAY
        );
        assertEq(gateway.recordServerSigner(), otherSigner, "signer replaced");

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    // --- the gateway's own rules still apply to a server attestation ---

    function test_Rejects_AfterTheAttestationExpires() public {
        vm.warp(uint256(V_EXPIRY) + 1);

        vm.expectRevert("attestation expired");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    function test_Rejects_WhenReviewerOwnsTheAgent() public {
        // The Record Server does not check this; the gateway does.
        id.setOwner(V_AGENT_ID, V_REVIEWER);

        vm.expectRevert("reviewer is owner/operator");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    function test_Rejects_WhenPaymentIsBelowMinimum() public {
        settler.setReceipt(V_RECEIPT_ID, V_REVIEWER, V_AGENT_ID, MIN_PAYMENT - 1, SETTLED_AT);

        vm.expectRevert("payment below minimum");
        gateway.submitPaidReview(_attestation());

        // consume() marked the receipt spent before the amount check reverted;
        // the rollback is what keeps it usable.
        _assertNothingConsumed();
    }

    function test_Rejects_AfterTheReviewWindowPasses() public {
        settler.setReceipt(
            V_RECEIPT_ID, V_REVIEWER, V_AGENT_ID, PAID_AMOUNT, uint64(REVIEW_TIME - gateway.REVIEW_WINDOW() - 1)
        );

        vm.expectRevert("review window passed");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    function test_Rejects_WhenTheReceiptBelongsToAnotherPayer() public {
        settler.setReceipt(V_RECEIPT_ID, address(0x7777), V_AGENT_ID, PAID_AMOUNT, SETTLED_AT);

        vm.expectRevert("payer mismatch");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    function test_Rejects_WhenTheReceiptIsForAnotherAgent() public {
        settler.setReceipt(V_RECEIPT_ID, V_REVIEWER, V_AGENT_ID + 1, PAID_AMOUNT, SETTLED_AT);

        vm.expectRevert("agent mismatch");
        gateway.submitPaidReview(_attestation());

        _assertNothingConsumed();
    }

    // --- F-01: feedbackURI is inside the signature ---
    // These were proof-of-behavior tests for the finding, when the URI was an
    // unsigned call argument and could be swapped freely. The protocol changed,
    // so their expectations are inverted rather than deleted: the same attacks
    // are still attempted, and now must fail. The entry points no longer take a
    // URI at all, so a substitution is a mutation of a signed field.

    function test_Rejects_SubstitutedFeedbackUri() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackURI = "https://attacker.example/reviews/0xdeadbeef";
        assertNotEq(a.feedbackURI, V_FEEDBACK_URI, "the substitute really is a different URI");

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        // The receipt matters here: previously the substitution succeeded and
        // spent it, lending a fabricated pointer a real payment.
        _assertNothingConsumed();
    }

    function test_Rejects_EmptyFeedbackUri() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackURI = "";

        vm.expectRevert("bad attestation signer");
        gateway.submitPaidReview(a);

        _assertNothingConsumed();
    }

    function test_Accepts_OnlyTheSignedFeedbackUri() public {
        gateway.submitPaidReview(_attestation());

        assertEq(rep.callCount(), 1, "accepted");
        assertEq(rep.lastFeedbackURI(), V_FEEDBACK_URI, "registry got the signed URI");
        assertEq(rep.lastFeedbackHash(), V_FEEDBACK_HASH, "and the signed hash");
    }

    function test_Digest_ChangesWithFeedbackUri() public {
        // Same proof the other signed fields get: the URI is inside the digest,
        // not merely checked alongside it.
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackURI = "https://attacker.example/reviews/0xdeadbeef";

        assertNotEq(_harnessAtSignedAddress().digestOf(a), V_DIGEST, "feedbackURI is a signed field");
    }
}
