// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, Vm} from "forge-std/Test.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {MockIdentityRegistry, MockUSDC} from "./ReceiptSettler.t.sol";
import {MockReputationRegistry, ReviewGatewayHarness} from "./ReviewGateway.t.sol";

/// @dev Submits several reviews in one transaction.
///      `nonReentrant` blocks nested calls but not sequential ones, so a
///      batching contract is reachable in production. It is the case that made
///      the previous cross-contract correlation fragile: one transaction then
///      carried N NullifierConsumed and N feedback logs, pairable only by log
///      order. ReviewSubmitted is meant to make that irrelevant.
contract ReviewBatcher {
    function submitFree(ReviewGateway gateway, ReviewGateway.Attestation[] calldata atts) external {
        for (uint256 i = 0; i < atts.length; i++) {
            gateway.submitFreeReview(atts[i]);
        }
    }

    function submitMixed(
        ReviewGateway gateway,
        ReviewGateway.Attestation[] calldata free,
        ReviewGateway.Attestation[] calldata paid
    ) external {
        for (uint256 i = 0; i < free.length; i++) {
            gateway.submitFreeReview(free[i]);
        }
        for (uint256 i = 0; i < paid.length; i++) {
            gateway.submitPaidReview(paid[i]);
        }
    }
}

/// @title ReviewSubmittedEventTest
/// @notice F-04: the single log that makes a review reconstructable on its own.
contract ReviewSubmittedEventTest is Test {
    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal rep;
    ReceiptSettler internal settler;
    NullifierRegistry internal nullifiers;
    ReviewGatewayHarness internal gw;
    ReviewBatcher internal batcher;

    address internal signer;
    uint256 internal signerKey;

    address internal reviewer = makeAddr("reviewer");
    address internal agentWallet = makeAddr("agentWallet");
    address internal relayer = makeAddr("relayer");

    uint256 internal constant AGENT_ID = 7;
    uint256 internal constant MIN_PAYMENT = 1_000_000;
    uint256 internal constant AMOUNT = 5_000_000;
    bytes32 internal constant NULLIFIER = keccak256("nullifier-1");
    bytes32 internal constant FEEDBACK_HASH = keccak256("evidence");

    event ReviewSubmitted(
        uint256 indexed agentId,
        address indexed reviewer,
        bytes32 indexed nullifier,
        uint8 reviewType,
        bytes32 receiptId,
        bytes32 feedbackHash
    );

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("recordServer");

        usdc = new MockUSDC();
        identity = new MockIdentityRegistry();
        rep = new MockReputationRegistry();
        settler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        nullifiers = new NullifierRegistry(address(settler));
        gw = new ReviewGatewayHarness(
            signer, address(rep), address(identity), address(settler), address(nullifiers), MIN_PAYMENT
        );
        settler.setReviewGateway(address(gw));
        batcher = new ReviewBatcher();

        identity.setWallet(AGENT_ID, agentWallet);
        usdc.mint(reviewer, 100_000_000);
        vm.warp(1_700_000_000);
    }

    function _settle(bytes32 orderId) internal returns (bytes32) {
        bytes32 nonce = keccak256(abi.encode(AGENT_ID, orderId, block.chainid, address(settler)));
        vm.prank(relayer);
        return settler.settle(reviewer, AGENT_ID, orderId, AMOUNT, 0, type(uint256).max, nonce, "");
    }

    function _att(address rev, bytes32 nullifier, bytes32 receiptId, bytes32 feedbackHash)
        internal
        view
        returns (ReviewGateway.Attestation memory a)
    {
        a.agentId = AGENT_ID;
        a.nullifier = nullifier;
        a.reviewer = rev;
        a.expiry = uint64(block.timestamp + 1 hours);
        a.value = 80;
        a.valueDecimals = 0;
        a.feedbackHash = feedbackHash;
        a.feedbackURI = "https://receipts.test/reviews/0xevidence";
        a.reviewType = receiptId == bytes32(0) ? 0 : 1;
        a.receiptId = receiptId;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, gw.digestOf(a));
        a.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Decoded ReviewSubmitted logs emitted by the gateway, in order.
    struct Decoded {
        uint256 agentId;
        address reviewer;
        bytes32 nullifier;
        uint8 reviewType;
        bytes32 receiptId;
        bytes32 feedbackHash;
    }

    function _collect() internal view returns (Decoded[] memory out) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("ReviewSubmitted(uint256,address,bytes32,uint8,bytes32,bytes32)");

        uint256 n;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig && logs[i].emitter == address(gw)) n++;
        }

        out = new Decoded[](n);
        uint256 k;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != sig || logs[i].emitter != address(gw)) continue;
            (uint8 reviewType, bytes32 receiptId, bytes32 feedbackHash) =
                abi.decode(logs[i].data, (uint8, bytes32, bytes32));
            out[k++] = Decoded({
                agentId: uint256(logs[i].topics[1]),
                reviewer: address(uint160(uint256(logs[i].topics[2]))),
                nullifier: logs[i].topics[3],
                reviewType: reviewType,
                receiptId: receiptId,
                feedbackHash: feedbackHash
            });
        }
    }

    // --- the event itself ---

    function test_FreeReview_EmitsTheExpectedEvent() public {
        vm.expectEmit(true, true, true, true, address(gw));
        emit ReviewSubmitted(AGENT_ID, reviewer, NULLIFIER, 0, bytes32(0), FEEDBACK_HASH);

        gw.submitFreeReview(_att(reviewer, NULLIFIER, bytes32(0), FEEDBACK_HASH));
    }

    function test_PaidReview_EmitsTheExpectedEventWithTheRealReceiptId() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));

        vm.expectEmit(true, true, true, true, address(gw));
        emit ReviewSubmitted(AGENT_ID, reviewer, NULLIFIER, 1, receiptId, FEEDBACK_HASH);

        gw.submitPaidReview(_att(reviewer, NULLIFIER, receiptId, FEEDBACK_HASH));
    }

    function test_FreeEvent_CarriesAZeroReceiptId() public {
        vm.recordLogs();
        gw.submitFreeReview(_att(reviewer, NULLIFIER, bytes32(0), FEEDBACK_HASH));

        Decoded[] memory events = _collect();
        assertEq(events.length, 1, "one event");
        assertEq(events[0].receiptId, bytes32(0), "zero receipt id");
        assertEq(events[0].reviewType, 0, "free");
    }

    function test_PaidEvent_CarriesTheConsumedReceiptId() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));

        vm.recordLogs();
        gw.submitPaidReview(_att(reviewer, NULLIFIER, receiptId, FEEDBACK_HASH));

        Decoded[] memory events = _collect();
        assertEq(events.length, 1, "one event");
        assertEq(events[0].receiptId, receiptId, "the receipt actually consumed");
        assertEq(events[0].reviewType, 1, "paid");

        // The receipt named in the log is the one the settler marked spent.
        (,,,, bool spent,) = settler.receipts(events[0].receiptId);
        assertTrue(spent, "log names the spent receipt");
    }

    function test_Event_IsSelfContained() public {
        // Everything an indexer needs, from one log, with no cross-contract join.
        bytes32 receiptId = _settle(bytes32(uint256(1)));

        vm.recordLogs();
        gw.submitPaidReview(_att(reviewer, NULLIFIER, receiptId, FEEDBACK_HASH));

        Decoded[] memory events = _collect();
        assertEq(events[0].agentId, AGENT_ID, "agentId");
        assertEq(events[0].reviewer, reviewer, "reviewer");
        assertEq(events[0].nullifier, NULLIFIER, "nullifier");
        assertEq(events[0].reviewType, 1, "reviewType");
        assertEq(events[0].receiptId, receiptId, "receiptId");
        assertEq(events[0].feedbackHash, FEEDBACK_HASH, "feedbackHash");
    }

    // --- the event means "recorded", not "attempted" ---

    function test_FailedRegistryCall_LeavesNoEvent() public {
        rep.setRevert(true);

        vm.recordLogs();
        ReviewGateway.Attestation memory a = _att(reviewer, NULLIFIER, bytes32(0), FEEDBACK_HASH);
        vm.expectRevert("registry revert");
        gw.submitFreeReview(a);

        assertEq(_collect().length, 0, "no event survives the revert");
    }

    function test_FailedRegistryCall_PaidPathLeavesNoEvent() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        rep.setRevert(true);

        vm.recordLogs();
        ReviewGateway.Attestation memory a = _att(reviewer, NULLIFIER, receiptId, FEEDBACK_HASH);
        vm.expectRevert("registry revert");
        gw.submitPaidReview(a);

        assertEq(_collect().length, 0, "no event survives the revert");
    }

    function test_FailedRegistryCall_RollbackBehaviourUnchanged() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        rep.setRevert(true);

        ReviewGateway.Attestation memory a = _att(reviewer, NULLIFIER, receiptId, FEEDBACK_HASH);
        vm.expectRevert("registry revert");
        gw.submitPaidReview(a);

        // Exactly as before F-04: both consumptions roll back.
        (,,,, bool spent,) = settler.receipts(receiptId);
        assertFalse(spent, "receipt unspent");
        assertFalse(nullifiers.isUsed(AGENT_ID, NULLIFIER), "nullifier unused");

        rep.setRevert(false);
        gw.submitPaidReview(_att(reviewer, NULLIFIER, receiptId, FEEDBACK_HASH));
        (,,,, spent,) = settler.receipts(receiptId);
        assertTrue(spent, "usable afterwards");
    }

    function test_RejectedSubmission_LeavesNoEvent() public {
        // A rejection before the registry call must also leave nothing behind.
        vm.recordLogs();
        ReviewGateway.Attestation memory a = _att(reviewer, NULLIFIER, bytes32(0), FEEDBACK_HASH);
        a.value = 101; // out of range, rejected up front
        vm.expectRevert("value out of range");
        gw.submitFreeReview(a);

        assertEq(_collect().length, 0, "no event");
    }

    /// @notice ReviewSubmitted is emitted after the state changes it describes.
    /// @dev Partial by necessity. A revert discards logs either way, so "emitted
    ///      before giveFeedback" and "emitted after" are indistinguishable from
    ///      outside — moving the emit earlier breaks no test here, and the mock
    ///      registry emits nothing to order against. What this does pin is that
    ///      the log comes after NullifierConsumed, so a refactor that hoisted it
    ///      to the top of the function would be caught. The rest of the
    ///      guarantee is structural: the emit is the final statement in both
    ///      paths.
    function test_Event_FollowsTheStateChangesItDescribes() public {
        vm.recordLogs();
        gw.submitFreeReview(_att(reviewer, NULLIFIER, bytes32(0), FEEDBACK_HASH));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 submitted = keccak256("ReviewSubmitted(uint256,address,bytes32,uint8,bytes32,bytes32)");
        bytes32 consumed = keccak256("NullifierConsumed(uint256,bytes32,address)");

        uint256 submittedAt = type(uint256).max;
        uint256 consumedAt = type(uint256).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == submitted) submittedAt = i;
            if (logs[i].topics[0] == consumed) consumedAt = i;
        }

        assertTrue(consumedAt != type(uint256).max, "nullifier consumption logged");
        assertTrue(submittedAt != type(uint256).max, "review logged");
        assertGt(submittedAt, consumedAt, "review log follows the consumption");
    }

    // --- several reviews in one transaction ---

    function test_Batched_EachReviewEmitsItsOwnCorrectEvent() public {
        address r2 = makeAddr("reviewer2");
        address r3 = makeAddr("reviewer3");

        ReviewGateway.Attestation[] memory atts = new ReviewGateway.Attestation[](3);
        atts[0] = _att(reviewer, keccak256("n1"), bytes32(0), keccak256("e1"));
        atts[1] = _att(r2, keccak256("n2"), bytes32(0), keccak256("e2"));
        atts[2] = _att(r3, keccak256("n3"), bytes32(0), keccak256("e3"));

        vm.recordLogs();
        batcher.submitFree(gw, atts);

        Decoded[] memory events = _collect();
        assertEq(events.length, 3, "three events in one transaction");

        // Each log is checked against the attestation it belongs to, matched by
        // nullifier rather than by position — the association must hold without
        // relying on ordering or on the transaction alone.
        for (uint256 i = 0; i < 3; i++) {
            uint256 found = type(uint256).max;
            for (uint256 j = 0; j < 3; j++) {
                if (events[j].nullifier == atts[i].nullifier) found = j;
            }
            assertTrue(found != type(uint256).max, "a log for this nullifier");

            assertEq(events[found].agentId, atts[i].agentId, "agentId");
            assertEq(events[found].reviewer, atts[i].reviewer, "reviewer");
            assertEq(events[found].reviewType, atts[i].reviewType, "reviewType");
            assertEq(events[found].receiptId, atts[i].receiptId, "receiptId");
            assertEq(events[found].feedbackHash, atts[i].feedbackHash, "feedbackHash");
        }
    }

    function test_Batched_MixedFreeAndPaidStayDistinguishable() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        address r2 = makeAddr("reviewer2");

        ReviewGateway.Attestation[] memory free = new ReviewGateway.Attestation[](1);
        free[0] = _att(r2, keccak256("free-n"), bytes32(0), keccak256("free-e"));

        ReviewGateway.Attestation[] memory paid = new ReviewGateway.Attestation[](1);
        paid[0] = _att(reviewer, keccak256("paid-n"), receiptId, keccak256("paid-e"));

        vm.recordLogs();
        batcher.submitMixed(gw, free, paid);

        Decoded[] memory events = _collect();
        assertEq(events.length, 2, "two events");

        for (uint256 i = 0; i < 2; i++) {
            if (events[i].nullifier == keccak256("free-n")) {
                assertEq(events[i].reviewType, 0, "free");
                assertEq(events[i].receiptId, bytes32(0), "free has no receipt");
                assertEq(events[i].reviewer, r2, "free reviewer");
            } else {
                assertEq(events[i].nullifier, keccak256("paid-n"), "paid nullifier");
                assertEq(events[i].reviewType, 1, "paid");
                assertEq(events[i].receiptId, receiptId, "paid carries its receipt");
                assertEq(events[i].reviewer, reviewer, "paid reviewer");
            }
        }
    }

    function test_Batched_APartialFailureEmitsNothingAtAll() public {
        // The second review reuses the first's nullifier, so the batch reverts
        // as a whole and neither log survives.
        ReviewGateway.Attestation[] memory atts = new ReviewGateway.Attestation[](2);
        atts[0] = _att(reviewer, NULLIFIER, bytes32(0), keccak256("e1"));
        atts[1] = _att(makeAddr("r2"), NULLIFIER, bytes32(0), keccak256("e2"));

        vm.recordLogs();
        vm.expectRevert("nullifier used");
        batcher.submitFree(gw, atts);

        assertEq(_collect().length, 0, "all-or-nothing");
        assertFalse(nullifiers.isUsed(AGENT_ID, NULLIFIER), "nullifier unused");
    }
}
