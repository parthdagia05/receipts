// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {MockIdentityRegistry, MockReceiptSettler, MockReputationRegistry} from "./ReviewGateway.t.sol";

/// @title RecordServerAcceptance
/// @notice Proves the real ReviewGateway accepts an attestation produced by the
///         real TypeScript Record Server signer.
/// @dev The values below are a golden vector emitted by `createAttestationSigner`
///      and recorded in `server/test/attestationVector.ts`. The signature is NOT
///      recreated here with `vm.sign`: doing so would only prove Solidity agrees
///      with itself. It is the exact 65 bytes the server produced, so this test
///      fails if either language's EIP-712 encoding changes.
///
///      `server/test/attestationVector.test.ts` guards the other direction, by
///      asserting the TypeScript signer still emits precisely these bytes.
contract RecordServerAcceptanceTest is Test {
    /// @dev The server signed under this domain, so the gateway must live at
    ///      this address on this chain. `_domainSeparator()` reads
    ///      `block.chainid` and `address(this)` at call time, so setting both
    ///      is sufficient.
    uint256 internal constant VECTOR_CHAIN_ID = 11155111;
    address internal constant VECTOR_GATEWAY = 0x2222222222222222222222222222222222222222;

    /// @dev Derived from the test-only key `0xa1…a1` in the fixture.
    address internal constant VECTOR_SIGNER = 0x5d5c99EdF529335160FF180fA141Dd4967fc00D2;

    // The nine signed fields, exactly as the server signed them.
    uint256 internal constant V_AGENT_ID = 9007199254740993; // 2**53 + 1
    bytes32 internal constant V_NULLIFIER = 0x00000000000000000000004393fb25a23480e82908ce2957cfb667d751c67eea;
    address internal constant V_REVIEWER = 0x3333333333333333333333333333333333333333;
    uint64 internal constant V_EXPIRY = 1800000000;
    int128 internal constant V_VALUE = 73;
    uint8 internal constant V_VALUE_DECIMALS = 0;
    bytes32 internal constant V_FEEDBACK_HASH = 0x5441718c0a105af12067d69f5efdb50b1a6ad0ea5cba93fdf81f76bf821e085d;
    /// @dev Derived by the Record Server from V_FEEDBACK_HASH, and signed.
    string internal constant V_FEEDBACK_URI =
        "https://receipts.test/reviews/0x5441718c0a105af12067d69f5efdb50b1a6ad0ea5cba93fdf81f76bf821e085d";
    uint8 internal constant V_REVIEW_TYPE = 0;
    bytes32 internal constant V_RECEIPT_ID = bytes32(0);

    /// @dev The Record Server's signature over the nine fields above.
    bytes internal constant V_SIGNATURE =
        hex"c7abfb85551eb5b166c1bbfa3d7c8612b52777bd1a6c83bd7749585326f1549a3f2a7e69140cdcf637034b6dec2111a1fbcfcc62ca2738313fb2236198030bdd1b";

    uint256 internal constant MIN_PAYMENT = 1_000_000;

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

        // The attestation is valid until V_EXPIRY; stay inside that window.
        vm.warp(1_700_000_000);
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

    // --- acceptance ---

    function test_Accepts_RecordServerAttestation() public {
        gateway.submitFreeReview(_attestation());

        assertTrue(rep.called(), "feedback written");
        assertEq(rep.callCount(), 1, "one feedback entry");
    }

    function test_Accepts_WritesTheExpectedErc8004Feedback() public {
        gateway.submitFreeReview(_attestation());

        assertEq(rep.lastAgentId(), V_AGENT_ID, "agentId");
        assertEq(rep.lastValue(), V_VALUE, "value");
        assertEq(rep.lastValueDecimals(), V_VALUE_DECIMALS, "valueDecimals");
        assertEq(rep.lastTag1(), "quality", "tag1");
        assertEq(rep.lastTag2(), "human-verified", "tag2");
        assertEq(rep.lastEndpoint(), "", "endpoint");
        assertEq(rep.lastFeedbackURI(), V_FEEDBACK_URI, "feedbackURI");
        assertEq(rep.lastFeedbackHash(), V_FEEDBACK_HASH, "feedbackHash");
    }

    function test_Accepts_PreservesAgentIdBeyondDoublePrecision() public {
        // 2**53 + 1 would arrive as ...992 if anything in the chain had routed
        // it through a floating-point number.
        gateway.submitFreeReview(_attestation());

        assertEq(rep.lastAgentId(), 9007199254740993, "agentId exact");
    }

    function test_Accepts_ConsumesTheNullifier() public {
        assertFalse(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "unused before");

        gateway.submitFreeReview(_attestation());

        assertTrue(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "consumed after");
    }

    function test_Rejects_ReplayOfTheSameNullifier() public {
        gateway.submitFreeReview(_attestation());

        vm.expectRevert("nullifier used");
        gateway.submitFreeReview(_attestation());

        assertEq(rep.callCount(), 1, "still one feedback entry");
    }

    // --- the signature actually binds the fields ---

    function test_Rejects_TamperedFeedbackHash() public {
        // One signed field changed, the server's signature left alone.
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackHash = bytes32(uint256(0xdead));

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);
    }

    function test_Rejects_TamperedValue() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.value = 100;

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);
    }

    function test_Rejects_TamperedReviewer() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.reviewer = address(0x9999);

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);
    }

    function test_Rejects_TamperedAgentId() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.agentId = V_AGENT_ID + 1;

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);
    }

    function test_Rejects_TamperedNullifier() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.nullifier = keccak256("not the signed nullifier");

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);
    }

    function test_Rejects_TamperedExpiry() public {
        ReviewGateway.Attestation memory a = _attestation();
        a.expiry = V_EXPIRY + 1;

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);
    }

    // --- the domain actually binds the deployment ---

    function test_Rejects_OnADifferentChain() public {
        // The same bytes, a different chain id: the domain separator moves, so
        // recovery yields someone else.
        vm.chainId(VECTOR_CHAIN_ID + 1);

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(_attestation());
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
        ReviewGateway(elsewhere).submitFreeReview(_attestation());
    }

    // --- the gateway's own rules still apply to a server attestation ---

    function test_Rejects_WhenReviewerOwnsTheAgent() public {
        // The Record Server does not check this; the gateway does.
        id.setOwner(V_AGENT_ID, V_REVIEWER);

        vm.expectRevert("reviewer is owner/operator");
        gateway.submitFreeReview(_attestation());
    }

    function test_Rejects_AfterTheAttestationExpires() public {
        vm.warp(uint256(V_EXPIRY) + 1);

        vm.expectRevert("attestation expired");
        gateway.submitFreeReview(_attestation());
    }

    function test_Accepts_AtTheExactExpiry() public {
        // The gateway's check is inclusive: block.timestamp <= expiry.
        vm.warp(uint256(V_EXPIRY));

        gateway.submitFreeReview(_attestation());
        assertEq(rep.callCount(), 1, "accepted at the boundary");
    }

    function test_Rejects_OnThePaidPath() public {
        // reviewType 0 was signed, so the paid entry point must refuse it.
        vm.expectRevert("not a paid review");
        gateway.submitPaidReview(_attestation());
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

        // The exact frozen signature, pointed somewhere the Record Server never
        // saw. Previously accepted; now recovery lands on another address.
        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);

        assertEq(rep.callCount(), 0, "nothing written");
        assertFalse(gateway.usedNullifier(V_AGENT_ID, V_NULLIFIER), "nullifier unused");
    }

    function test_Rejects_EmptyFeedbackUri() public {
        // Emptying the field is just another mutation of it.
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackURI = "";

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);

        assertEq(rep.callCount(), 0, "nothing written");
    }

    function test_Accepts_OnlyTheSignedFeedbackUri() public {
        // The positive half: the derived URI is accepted, and the registry
        // receives exactly it — there is no second place a URI could come from.
        gateway.submitFreeReview(_attestation());

        assertEq(rep.callCount(), 1, "accepted");
        assertEq(rep.lastFeedbackURI(), V_FEEDBACK_URI, "registry got the signed URI");
        assertEq(rep.lastFeedbackHash(), V_FEEDBACK_HASH, "and the signed hash");
    }

    function test_Rejects_TamperedFeedbackHashWithTheSignedUri() public {
        // feedbackHash remains independently signed: the URI being bound does
        // not let a changed hash through.
        ReviewGateway.Attestation memory a = _attestation();
        a.feedbackHash = keccak256("different evidence");

        vm.expectRevert("bad attestation signer");
        gateway.submitFreeReview(a);

        assertEq(rep.callCount(), 0, "nothing written");
    }
}
