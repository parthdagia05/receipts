// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {
    MockIdentityRegistry,
    MockReceiptSettler,
    MockReputationRegistry,
    ReviewGatewayHarness
} from "./ReviewGateway.t.sol";

/// @title NullifierRegistryTest
/// @notice The shared one-human-one-review ledger, and the migration behaviour
///         it exists to fix.
/// @dev The predecessor-chaining design this replaced was correct for exactly
///      one migration. `_consumeNullifier` only wrote on success, so a gateway
///      that *rejected* a nullifier never recorded it, and the generation after
///      that saw an unused nullifier and accepted it. The A -> B -> C tests
///      below are the ones that caught it; they are the reason this contract
///      holds the mapping instead of the gateway.
contract NullifierRegistryTest is Test {
    NullifierRegistry internal registry;
    MockReceiptSettler internal settler;
    MockReputationRegistry internal rep;
    MockIdentityRegistry internal id;

    address internal gateway = makeAddr("gateway");
    address internal otherGateway = makeAddr("otherGateway");
    address internal eoa = makeAddr("eoa");

    uint256 internal constant AGENT_ID = 1;
    bytes32 internal constant NULLIFIER = keccak256("nullifier-1");

    event NullifierConsumed(uint256 indexed agentId, bytes32 indexed nullifier, address indexed gateway);

    function setUp() public {
        settler = new MockReceiptSettler();
        rep = new MockReputationRegistry();
        id = new MockIdentityRegistry();
        registry = new NullifierRegistry(address(settler));
        settler.setReviewGateway(gateway);
    }

    // --- construction ---

    function test_Constructor_BindsTheSettler() public view {
        assertEq(address(registry.receiptSettler()), address(settler), "settler bound");
    }

    function test_Constructor_RejectsZeroSettler() public {
        vm.expectRevert("settler is zero");
        new NullifierRegistry(address(0));
    }

    function test_Constructor_RejectsCodelessSettler() public {
        vm.expectRevert("settler has no code");
        new NullifierRegistry(eoa);
    }

    // --- consumption ---

    function test_Consume_FirstUseSucceeds() public {
        assertFalse(registry.isUsed(AGENT_ID, NULLIFIER), "unused before");

        vm.prank(gateway);
        registry.consume(AGENT_ID, NULLIFIER);

        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER), "recorded");
    }

    function test_Consume_EmitsTheConsumption() public {
        vm.expectEmit(true, true, true, true);
        emit NullifierConsumed(AGENT_ID, NULLIFIER, gateway);

        vm.prank(gateway);
        registry.consume(AGENT_ID, NULLIFIER);
    }

    function test_Consume_DuplicateFails() public {
        vm.prank(gateway);
        registry.consume(AGENT_ID, NULLIFIER);

        vm.prank(gateway);
        vm.expectRevert("nullifier used");
        registry.consume(AGENT_ID, NULLIFIER);

        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER), "still recorded once");
    }

    function test_Consume_ZeroNullifierFails() public {
        vm.prank(gateway);
        vm.expectRevert("zero nullifier");
        registry.consume(AGENT_ID, bytes32(0));

        assertFalse(registry.isUsed(AGENT_ID, bytes32(0)), "nothing recorded");
    }

    function test_Consume_SameNullifierDifferentAgentAllowed() public {
        vm.startPrank(gateway);
        registry.consume(AGENT_ID, NULLIFIER);
        registry.consume(AGENT_ID + 1, NULLIFIER);
        vm.stopPrank();

        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER), "agent 1");
        assertTrue(registry.isUsed(AGENT_ID + 1, NULLIFIER), "agent 2");
    }

    // --- write authorization is derived, never granted ---

    function test_Consume_NonActiveGatewayRejected() public {
        vm.prank(otherGateway);
        vm.expectRevert("not active gateway");
        registry.consume(AGENT_ID, NULLIFIER);

        assertFalse(registry.isUsed(AGENT_ID, NULLIFIER), "nothing recorded");
    }

    function test_Consume_EoaRejected() public {
        vm.prank(eoa);
        vm.expectRevert("not active gateway");
        registry.consume(AGENT_ID, NULLIFIER);

        assertFalse(registry.isUsed(AGENT_ID, NULLIFIER), "nothing recorded");
    }

    function test_Consume_RejectedBeforeAnyGatewayIsNamed() public {
        // A fresh settler names nobody; msg.sender can never be address(0), so
        // the registry is closed until it is wired.
        MockReceiptSettler fresh = new MockReceiptSettler();
        NullifierRegistry unwired = new NullifierRegistry(address(fresh));

        vm.prank(gateway);
        vm.expectRevert("not active gateway");
        unwired.consume(AGENT_ID, NULLIFIER);
    }

    function test_Consume_FailsClosedWhenTheSettlerReverts() public {
        // Not interpreted as "no active gateway": the read reverting must take
        // the consumption down with it, never wave it through.
        settler.setRevertOnGatewayRead(true);

        vm.prank(gateway);
        vm.expectRevert("settler unavailable");
        registry.consume(AGENT_ID, NULLIFIER);

        settler.setRevertOnGatewayRead(false);
        assertFalse(registry.isUsed(AGENT_ID, NULLIFIER), "nothing recorded");
    }

    function test_Consume_FollowsTheSettlerWhenTheGatewayChanges() public {
        vm.prank(gateway);
        registry.consume(AGENT_ID, NULLIFIER);

        settler.setReviewGateway(otherGateway);

        // The old gateway loses write access in the same storage write that
        // grants it to the new one. No window, no allowlist, no owner.
        vm.prank(gateway);
        vm.expectRevert("not active gateway");
        registry.consume(AGENT_ID, keccak256("nullifier-2"));

        vm.prank(otherGateway);
        registry.consume(AGENT_ID, keccak256("nullifier-2"));
        assertTrue(registry.isUsed(AGENT_ID, keccak256("nullifier-2")), "new gateway wrote");
    }

    function test_Registry_HasNoAdministrativeSurface() public {
        // No owner, no allowlist: the only mutating entry point is consume().
        vm.prank(eoa);
        (bool ok,) = address(registry).call(abi.encodeWithSignature("setGateway(address)", eoa));
        assertFalse(ok, "no setter exists");

        vm.prank(eoa);
        (ok,) = address(registry).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "no owner exists");
    }
}

/// @title NullifierMigrationTest
/// @notice Nullifier continuity across gateway generations.
/// @dev Each gateway is real, deployed against the same registry, and made
///      active through the settler exactly as a migration would.
contract NullifierMigrationTest is Test {
    NullifierRegistry internal registry;
    MockReceiptSettler internal settler;
    MockReputationRegistry internal rep;
    MockIdentityRegistry internal id;

    address internal signer;
    uint256 internal signerKey;

    uint256 internal constant MIN_PAYMENT = 1_000_000;
    uint256 internal constant AGENT_ID = 1;
    bytes32 internal constant NULLIFIER_X = keccak256("nullifier-X");
    address internal reviewer = makeAddr("reviewer");

    ReviewGatewayHarness internal gwA;
    ReviewGatewayHarness internal gwB;
    ReviewGatewayHarness internal gwC;

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("recordServer");
        settler = new MockReceiptSettler();
        rep = new MockReputationRegistry();
        id = new MockIdentityRegistry();
        registry = new NullifierRegistry(address(settler));

        gwA = _deploy();
        gwB = _deploy();
        gwC = _deploy();

        settler.setReviewGateway(address(gwA));
        vm.warp(1_700_000_000);
    }

    function _deploy() internal returns (ReviewGatewayHarness) {
        return
            new ReviewGatewayHarness(
                signer, address(rep), address(id), address(settler), address(registry), MIN_PAYMENT
            );
    }

    /// @dev A signed free attestation for `gw`'s domain.
    function _att(ReviewGatewayHarness gw, bytes32 nullifier)
        internal
        view
        returns (ReviewGateway.Attestation memory a)
    {
        a.agentId = AGENT_ID;
        a.nullifier = nullifier;
        a.reviewer = reviewer;
        a.expiry = uint64(block.timestamp + 1 hours);
        a.value = 80;
        a.valueDecimals = 0;
        a.feedbackHash = keccak256("evidence");
        a.feedbackURI = "ipfs://evidence";
        a.reviewType = 0;
        a.receiptId = bytes32(0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, gw.digestOf(a));
        a.signature = abi.encodePacked(r, s, v);
    }

    function _migrateTo(ReviewGatewayHarness gw) internal {
        settler.setReviewGateway(address(gw));
    }

    // --- the sequence that broke predecessor chaining ---

    /// @notice A -> B -> C: X consumed on A must still be refused by C.
    /// @dev Under predecessor chaining C checked only B, and B never recorded X
    ///      because B *rejected* it — a rejection reverts, so nothing is
    ///      written. C therefore saw X as unused and accepted a second review
    ///      from one human. One shared ledger has no such hole.
    function test_Migration_AtoBtoC_RefusesANullifierConsumedOnA() public {
        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));
        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER_X), "consumed on A");

        _migrateTo(gwB);
        ReviewGateway.Attestation memory att1 = _att(gwB, NULLIFIER_X);
        vm.expectRevert("nullifier used");
        gwB.submitFreeReview(att1);

        _migrateTo(gwC);
        ReviewGateway.Attestation memory att2 = _att(gwC, NULLIFIER_X);
        vm.expectRevert("nullifier used");
        gwC.submitFreeReview(att2);

        assertEq(rep.callCount(), 1, "exactly one review ever written");
    }

    /// @notice The precise failure: rejection on B must not erase X for C.
    function test_Migration_RejectionOnBDoesNotUnprotectOnC() public {
        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));

        _migrateTo(gwB);
        ReviewGateway.Attestation memory att3 = _att(gwB, NULLIFIER_X);
        vm.expectRevert("nullifier used");
        gwB.submitFreeReview(att3);

        // The registry still holds X even though B recorded nothing itself.
        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER_X), "still protected");

        _migrateTo(gwC);
        ReviewGateway.Attestation memory att4 = _att(gwC, NULLIFIER_X);
        vm.expectRevert("nullifier used");
        gwC.submitFreeReview(att4);
        assertEq(rep.callCount(), 1, "no second review");
    }

    function test_Migration_ProtectsAcrossFourGenerations() public {
        ReviewGatewayHarness gwD = _deploy();

        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));
        for (uint256 i = 0; i < 3; i++) {
            ReviewGatewayHarness next = i == 0 ? gwB : (i == 1 ? gwC : gwD);
            _migrateTo(next);
            ReviewGateway.Attestation memory att5 = _att(next, NULLIFIER_X);
            vm.expectRevert("nullifier used");
            next.submitFreeReview(att5);
        }

        assertEq(rep.callCount(), 1, "one review across four generations");
    }

    function test_Migration_NewNullifiersStillWorkAfterMigrations() public {
        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));

        _migrateTo(gwB);
        gwB.submitFreeReview(_att(gwB, keccak256("nullifier-Y")));

        _migrateTo(gwC);
        gwC.submitFreeReview(_att(gwC, keccak256("nullifier-Z")));

        assertEq(rep.callCount(), 3, "three distinct humans");
    }

    /// @notice The reverse order the one-way predecessor check missed entirely.
    function test_Migration_ConsumedOnNewIsRefusedOnOld() public {
        _migrateTo(gwB);
        gwB.submitFreeReview(_att(gwB, NULLIFIER_X));

        // Point back at A. Even granted active status again, A shares the
        // ledger and sees X as consumed.
        _migrateTo(gwA);
        ReviewGateway.Attestation memory att6 = _att(gwA, NULLIFIER_X);
        vm.expectRevert("nullifier used");
        gwA.submitFreeReview(att6);

        assertEq(rep.callCount(), 1, "no second review");
    }

    // --- an obsolete gateway is inert on both paths ---

    function test_OldGateway_CannotSubmitFreeReviewAfterMigration() public {
        _migrateTo(gwB);

        ReviewGateway.Attestation memory att7 = _att(gwA, NULLIFIER_X);
        vm.expectRevert("gateway not active");
        gwA.submitFreeReview(att7);

        assertEq(rep.callCount(), 0, "nothing written");
        assertFalse(registry.isUsed(AGENT_ID, NULLIFIER_X), "nullifier untouched");
    }

    function test_OldGateway_CannotSubmitPaidReviewAfterMigration() public {
        bytes32 receiptId = keccak256("receipt-1");
        settler.setReceipt(receiptId, reviewer, AGENT_ID, 5_000_000, uint64(block.timestamp));

        ReviewGateway.Attestation memory a = _att(gwA, NULLIFIER_X);
        a.reviewType = 1;
        a.receiptId = receiptId;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, gwA.digestOf(a));
        a.signature = abi.encodePacked(r, s, v);

        _migrateTo(gwB);

        vm.expectRevert("gateway not active");
        gwA.submitPaidReview(a);

        assertEq(rep.callCount(), 0, "nothing written");
        (,,,, bool spent,) = settler.receipts(receiptId);
        assertFalse(spent, "receipt unspent");
    }

    function test_OldGateway_WasWorkingBeforeMigration() public {
        // Without this the two tests above could pass for the wrong reason.
        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));
        assertEq(rep.callCount(), 1, "A worked while active");
    }

    function test_NewGateway_AcceptsImmediatelyAfterMigration() public {
        _migrateTo(gwB);

        gwB.submitFreeReview(_att(gwB, NULLIFIER_X));
        assertEq(rep.callCount(), 1, "B works");
    }

    function test_Gateway_RejectsWhenNoGatewayIsActive() public {
        settler.setReviewGateway(address(0));

        ReviewGateway.Attestation memory att8 = _att(gwA, NULLIFIER_X);
        vm.expectRevert("gateway not active");
        gwA.submitFreeReview(att8);
    }

    // --- atomicity ---

    function test_FailedFeedbackRollsBackTheConsumption() public {
        rep.setRevert(true);

        ReviewGateway.Attestation memory att9 = _att(gwA, NULLIFIER_X);
        vm.expectRevert("registry revert");
        gwA.submitFreeReview(att9);

        // The registry write happens before the ERC-8004 call, so the revert
        // must take it with it or the human would be silently burned.
        assertFalse(registry.isUsed(AGENT_ID, NULLIFIER_X), "consumption rolled back");

        rep.setRevert(false);
        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));
        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER_X), "usable afterwards");
    }

    // --- wiring ---

    function test_Gateway_RejectsARegistryBoundToAnotherSettler() public {
        MockReceiptSettler otherSettler = new MockReceiptSettler();
        NullifierRegistry foreign = new NullifierRegistry(address(otherSettler));

        vm.expectRevert("registry settler mismatch");
        new ReviewGatewayHarness(signer, address(rep), address(id), address(settler), address(foreign), MIN_PAYMENT);
    }

    function test_Gateway_RejectsZeroAndCodelessRegistry() public {
        vm.expectRevert("registry is zero");
        new ReviewGatewayHarness(signer, address(rep), address(id), address(settler), address(0), MIN_PAYMENT);

        vm.expectRevert("registry has no code");
        new ReviewGatewayHarness(
            signer, address(rep), address(id), address(settler), makeAddr("notARegistry"), MIN_PAYMENT
        );
    }

    function test_Gateway_ReadsThroughToTheSharedLedger() public {
        gwA.submitFreeReview(_att(gwA, NULLIFIER_X));

        // The gateway keeps its usedNullifier view, now answered by the registry.
        assertTrue(gwA.usedNullifier(AGENT_ID, NULLIFIER_X), "gateway view");
        assertTrue(registry.isUsed(AGENT_ID, NULLIFIER_X), "registry");

        _migrateTo(gwB);
        assertTrue(gwB.usedNullifier(AGENT_ID, NULLIFIER_X), "successor sees it too");
    }
}
