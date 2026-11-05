// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {MockIdentityRegistry, MockUSDC} from "./ReceiptSettler.t.sol";
import {MockReputationRegistry, ReviewGatewayHarness} from "./ReviewGateway.t.sol";

/// @title GatewayMigrationTest
/// @notice End-to-end gateway replacement against the real ReceiptSettler.
/// @dev Nothing here is mocked except the two external registries and USDC. The
///      settler, the nullifier registry and the gateways are the production
///      contracts, and the pointer moves through the real `setReviewGateway`.
///
///      `ReviewGatewayHarness` is used only because signing needs `digestOf`;
///      it subclasses ReviewGateway and changes no behaviour under test.
contract GatewayMigrationTest is Test {
    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal rep;
    ReceiptSettler internal settler;
    NullifierRegistry internal nullifiers;

    ReviewGatewayHarness internal gwA;
    ReviewGatewayHarness internal gwB;

    address internal signerA;
    uint256 internal signerKeyA;
    address internal signerB;
    uint256 internal signerKeyB;

    address internal reviewer = makeAddr("reviewer");
    address internal agentWallet = makeAddr("agentWallet");
    address internal relayer = makeAddr("relayer");

    uint256 internal constant AGENT_ID = 7;
    uint256 internal constant MIN_PAYMENT = 1_000_000;
    uint256 internal constant AMOUNT = 5_000_000;
    bytes32 internal constant NULLIFIER = keccak256("nullifier-1");

    function setUp() public {
        (signerA, signerKeyA) = makeAddrAndKey("recordServerA");
        (signerB, signerKeyB) = makeAddrAndKey("recordServerB");

        usdc = new MockUSDC();
        identity = new MockIdentityRegistry();
        rep = new MockReputationRegistry();

        // 1. Settler first: everything else is built against it.
        settler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        // 2. Registry, bound to that settler.
        nullifiers = new NullifierRegistry(address(settler));
        // 3. Gateways, bound to both.
        gwA = _deployGateway(signerA);
        gwB = _deployGateway(signerB);
        // 4. Name the initial gateway.
        settler.setReviewGateway(address(gwA));

        identity.setWallet(AGENT_ID, agentWallet);
        usdc.mint(reviewer, 100_000_000);
        vm.warp(1_700_000_000);
    }

    function _deployGateway(address signer) internal returns (ReviewGatewayHarness) {
        return new ReviewGatewayHarness(
            signer, address(rep), address(identity), address(settler), address(nullifiers), MIN_PAYMENT
        );
    }

    /// @dev Settle a real receipt through the real settler.
    function _settle(bytes32 orderId) internal returns (bytes32 receiptId) {
        bytes32 nonce = keccak256(abi.encode(AGENT_ID, orderId, block.chainid, address(settler)));
        vm.prank(relayer);
        return settler.settle(reviewer, AGENT_ID, orderId, AMOUNT, 0, type(uint256).max, nonce, "");
    }

    /// @dev An attestation signed by `key` for `gw`'s domain.
    function _att(ReviewGatewayHarness gw, uint256 key, bytes32 nullifier, bytes32 receiptId)
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
        a.feedbackURI = "https://receipts.test/reviews/0xevidence";
        a.reviewType = receiptId == bytes32(0) ? 0 : 1;
        a.receiptId = receiptId;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, gw.digestOf(a));
        a.signature = abi.encodePacked(r, s, v);
    }

    function _spent(bytes32 receiptId) internal view returns (bool spent) {
        (,,,, spent,) = settler.receipts(receiptId);
    }

    // --- the deployment wires up as documented ---

    function test_Deployment_PointerAndDependencies() public view {
        assertEq(settler.reviewGateway(), address(gwA), "active pointer");
        assertEq(address(nullifiers.receiptSettler()), address(settler), "registry -> settler");
        assertEq(address(gwA.receiptSettler()), address(settler), "gateway -> settler");
        assertEq(address(gwA.nullifierRegistry()), address(nullifiers), "gateway -> registry");
        assertEq(gwA.recordServerSigner(), signerA, "gateway signer");
        assertEq(gwA.minPayment(), MIN_PAYMENT, "min payment");
    }

    function test_Deployment_FailsClosedBeforeTheGatewayIsNamed() public {
        // A settler that was never wired: every path is refused, loudly and
        // symmetrically, rather than only the paid one.
        ReceiptSettler fresh = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        NullifierRegistry freshReg = new NullifierRegistry(address(fresh));
        ReviewGatewayHarness orphan = new ReviewGatewayHarness(
            signerA, address(rep), address(identity), address(fresh), address(freshReg), MIN_PAYMENT
        );

        ReviewGateway.Attestation memory a = _att(orphan, signerKeyA, NULLIFIER, bytes32(0));
        vm.expectRevert("gateway not active");
        orphan.submitFreeReview(a);
    }

    /// @notice The real deployment path cannot produce a gateway that reports
    ///         this settler but a foreign nullifier ledger.
    /// @dev Which contract enforces this matters. ReceiptSettler validates
    ///      registry *continuity* only when replacing an incumbent, so on first
    ///      wiring it is the ReviewGateway constructor that forbids the
    ///      combination — it requires `registry.receiptSettler()` to equal its
    ///      own settler. No such gateway can be constructed, so there is nothing
    ///      for the settler to re-check and no redundant call is added to
    ///      `setReviewGateway`.
    ///
    ///      The limit of that guarantee, stated plainly: it binds real
    ///      ReviewGateways, not arbitrary contracts. A hand-written stub
    ///      reporting this settler and a foreign registry would be accepted as a
    ///      first gateway — but only the configurator can wire one, and a
    ///      configurator installing a non-gateway is indistinguishable from
    ///      installing nothing at all.
    function test_Deployment_GatewayCannotBeBuiltWithAForeignRegistry() public {
        ReceiptSettler otherSettler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        NullifierRegistry foreignLedger = new NullifierRegistry(address(otherSettler));
        assertEq(address(foreignLedger.receiptSettler()), address(otherSettler), "ledger is foreign");

        vm.expectRevert("registry settler mismatch");
        new ReviewGatewayHarness(
            signerA, address(rep), address(identity), address(settler), address(foreignLedger), MIN_PAYMENT
        );

        assertEq(settler.reviewGateway(), address(gwA), "pointer untouched");
    }

    // --- migration ---

    function test_Migration_AWorksBeforeReplacement() public {
        gwA.submitFreeReview(_att(gwA, signerKeyA, NULLIFIER, bytes32(0)));

        bytes32 receiptId = _settle(bytes32(uint256(1)));
        gwA.submitPaidReview(_att(gwA, signerKeyA, keccak256("n2"), receiptId));

        assertEq(rep.callCount(), 2, "both paths worked while A was active");
    }

    function test_Migration_ARejectsBothPathsAfterReplacement() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        ReviewGateway.Attestation memory free = _att(gwA, signerKeyA, NULLIFIER, bytes32(0));
        vm.expectRevert("gateway not active");
        gwA.submitFreeReview(free);

        ReviewGateway.Attestation memory paid = _att(gwA, signerKeyA, keccak256("n2"), receiptId);
        vm.expectRevert("gateway not active");
        gwA.submitPaidReview(paid);

        assertEq(rep.callCount(), 0, "nothing written");
        assertFalse(_spent(receiptId), "receipt unspent");
        assertFalse(nullifiers.isUsed(AGENT_ID, NULLIFIER), "nullifier untouched");
    }

    function test_Migration_BAcceptsBothPathsAfterReplacement() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        gwB.submitFreeReview(_att(gwB, signerKeyB, NULLIFIER, bytes32(0)));
        gwB.submitPaidReview(_att(gwB, signerKeyB, keccak256("n2"), receiptId));

        assertEq(rep.callCount(), 2, "both paths work on B");
        assertTrue(_spent(receiptId), "receipt consumed by B");
    }

    function test_Migration_ACannotConsumeReceiptsAfterReplacement() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        // Straight at the settler, bypassing the gateway's own check.
        vm.prank(address(gwA));
        vm.expectRevert("not gateway");
        settler.consume(receiptId, reviewer, AGENT_ID);

        assertFalse(_spent(receiptId), "receipt unspent");
    }

    function test_Migration_BConsumesAReceiptSettledBeforeReplacement() public {
        // The receipt predates the migration entirely.
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        (, uint256 agentId, uint256 amount, uint64 settledAt,,) = settler.receipts(receiptId);
        assertEq(agentId, AGENT_ID, "receipt agent");
        assertEq(amount, AMOUNT, "receipt amount");

        settler.setReviewGateway(address(gwB));

        gwB.submitPaidReview(_att(gwB, signerKeyB, NULLIFIER, receiptId));

        assertTrue(_spent(receiptId), "older receipt still usable");
        assertEq(rep.lastTag2(), "receipt-verified", "paid review recorded");
        assertGt(settledAt, 0, "settled before migration");
    }

    function test_Migration_NullifierHistorySurvivesAtoBtoC() public {
        ReviewGatewayHarness gwC = _deployGateway(signerA);

        gwA.submitFreeReview(_att(gwA, signerKeyA, NULLIFIER, bytes32(0)));

        settler.setReviewGateway(address(gwB));
        ReviewGateway.Attestation memory onB = _att(gwB, signerKeyB, NULLIFIER, bytes32(0));
        vm.expectRevert("nullifier used");
        gwB.submitFreeReview(onB);

        settler.setReviewGateway(address(gwC));
        ReviewGateway.Attestation memory onC = _att(gwC, signerKeyA, NULLIFIER, bytes32(0));
        vm.expectRevert("nullifier used");
        gwC.submitFreeReview(onC);

        assertEq(rep.callCount(), 1, "one review across three generations");
    }

    function test_Migration_FailedFeedbackRollsBackReceiptAndNullifier() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        rep.setRevert(true);

        ReviewGateway.Attestation memory a = _att(gwA, signerKeyA, NULLIFIER, receiptId);
        vm.expectRevert("registry revert");
        gwA.submitPaidReview(a);

        // Both are consumed before the ERC-8004 call, so both must roll back.
        assertFalse(_spent(receiptId), "receipt unspent");
        assertFalse(nullifiers.isUsed(AGENT_ID, NULLIFIER), "nullifier unused");

        rep.setRevert(false);
        gwA.submitPaidReview(_att(gwA, signerKeyA, NULLIFIER, receiptId));
        assertTrue(_spent(receiptId), "usable afterwards");
    }

    /// @notice A replacement carrying a fresh ledger is refused outright.
    /// @dev Before this check the settler accepted it: the candidate referenced
    ///      the right settler, and its registry referenced the right settler
    ///      too, so nothing caught that the ledger was empty. One migration
    ///      would have silently restored every consumed nullifier.
    function test_Migration_RejectsAReplacementWithAFreshRegistry() public {
        gwA.submitFreeReview(_att(gwA, signerKeyA, NULLIFIER, bytes32(0)));
        assertTrue(nullifiers.isUsed(AGENT_ID, NULLIFIER), "consumed on A");

        NullifierRegistry emptyLedger = new NullifierRegistry(address(settler));
        ReviewGatewayHarness rogue = new ReviewGatewayHarness(
            signerB, address(rep), address(identity), address(settler), address(emptyLedger), MIN_PAYMENT
        );

        vm.expectRevert("nullifier registry mismatch");
        settler.setReviewGateway(address(rogue));

        // The incumbent is untouched, and the history it guards is intact.
        assertEq(settler.reviewGateway(), address(gwA), "pointer unchanged");
        assertTrue(nullifiers.isUsed(AGENT_ID, NULLIFIER), "history intact");
        assertFalse(emptyLedger.isUsed(AGENT_ID, NULLIFIER), "the fresh ledger was indeed empty");
    }

    function test_Migration_ConsumedNullifierSurvivesAValidReplacement() public {
        gwA.submitFreeReview(_att(gwA, signerKeyA, NULLIFIER, bytes32(0)));

        settler.setReviewGateway(address(gwB));

        assertTrue(nullifiers.isUsed(AGENT_ID, NULLIFIER), "still consumed");
        assertTrue(gwB.usedNullifier(AGENT_ID, NULLIFIER), "successor sees it");

        ReviewGateway.Attestation memory a = _att(gwB, signerKeyB, NULLIFIER, bytes32(0));
        vm.expectRevert("nullifier used");
        gwB.submitFreeReview(a);
    }

    function test_Migration_AllGenerationsShareOneRegistry() public {
        ReviewGatewayHarness gwC = _deployGateway(signerA);

        settler.setReviewGateway(address(gwB));
        settler.setReviewGateway(address(gwC));

        assertEq(address(gwA.nullifierRegistry()), address(nullifiers), "A");
        assertEq(address(gwB.nullifierRegistry()), address(nullifiers), "B");
        assertEq(address(gwC.nullifierRegistry()), address(nullifiers), "C");
    }

    // --- recovery from a compromised signer ---

    function test_Recovery_ReplacementGatewayUsesTheNewSigner() public {
        settler.setReviewGateway(address(gwB));

        assertEq(gwB.recordServerSigner(), signerB, "new signer");
        gwB.submitFreeReview(_att(gwB, signerKeyB, NULLIFIER, bytes32(0)));
        assertEq(rep.callCount(), 1, "replacement signer works");
    }

    function test_Recovery_OldSignerCannotSignForTheReplacement() public {
        settler.setReviewGateway(address(gwB));

        // The compromised key, against the live gateway.
        ReviewGateway.Attestation memory a = _att(gwB, signerKeyA, NULLIFIER, bytes32(0));
        vm.expectRevert("bad attestation signer");
        gwB.submitFreeReview(a);

        assertEq(rep.callCount(), 0, "nothing written");
        assertFalse(nullifiers.isUsed(AGENT_ID, NULLIFIER), "nullifier untouched");
    }

    function test_Recovery_OldSignerCannotUseTheOldGatewayEither() public {
        settler.setReviewGateway(address(gwB));

        // The old gateway still trusts the compromised key — and is inert.
        assertEq(gwA.recordServerSigner(), signerA, "A still trusts the old key");
        ReviewGateway.Attestation memory a = _att(gwA, signerKeyA, NULLIFIER, bytes32(0));
        vm.expectRevert("gateway not active");
        gwA.submitFreeReview(a);

        assertEq(rep.callCount(), 0, "nothing written");
    }

    function test_Recovery_NoSignerRotationSetterExists() public {
        // Recovery is a redeployment plus a repoint, never an in-place rotation.
        (bool ok,) = address(gwA).call(abi.encodeWithSignature("setRecordServerSigner(address)", signerB));
        assertFalse(ok, "no signer setter on the gateway");

        (ok,) = address(nullifiers).call(abi.encodeWithSignature("setReviewGateway(address)", address(gwB)));
        assertFalse(ok, "no gateway setter on the registry");
    }

    // --- receipt rules survive migration unchanged ---

    function test_Receipts_ReviewWindowStillEnforcedAfterMigration() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        vm.warp(block.timestamp + 30 days + 1);

        ReviewGateway.Attestation memory a = _att(gwB, signerKeyB, NULLIFIER, receiptId);
        vm.expectRevert("review window passed");
        gwB.submitPaidReview(a);

        assertFalse(_spent(receiptId), "receipt unspent");
    }

    function test_Receipts_AcceptedAtTheWindowBoundaryAfterMigration() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        vm.warp(block.timestamp + 30 days);

        gwB.submitPaidReview(_att(gwB, signerKeyB, NULLIFIER, receiptId));
        assertTrue(_spent(receiptId), "accepted at the boundary");
    }

    function test_Receipts_PayerBindingStillEnforcedAfterMigration() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        ReviewGateway.Attestation memory a = _att(gwB, signerKeyB, NULLIFIER, receiptId);
        a.reviewer = makeAddr("someoneElse");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeyB, gwB.digestOf(a));
        a.signature = abi.encodePacked(r, s, v);

        vm.expectRevert("payer mismatch");
        gwB.submitPaidReview(a);

        assertFalse(_spent(receiptId), "receipt unspent");
    }

    function test_Receipts_AgentBindingStillEnforcedAfterMigration() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));
        settler.setReviewGateway(address(gwB));

        ReviewGateway.Attestation memory a = _att(gwB, signerKeyB, NULLIFIER, receiptId);
        a.agentId = AGENT_ID + 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKeyB, gwB.digestOf(a));
        a.signature = abi.encodePacked(r, s, v);

        vm.expectRevert("agent mismatch");
        gwB.submitPaidReview(a);

        assertFalse(_spent(receiptId), "receipt unspent");
    }

    function test_Receipts_MinimumPaymentStillEnforcedAfterMigration() public {
        // Settle exactly the minimum, then raise the bar on the replacement.
        bytes32 orderId = bytes32(uint256(9));
        bytes32 nonce = keccak256(abi.encode(AGENT_ID, orderId, block.chainid, address(settler)));
        vm.prank(relayer);
        bytes32 receiptId = settler.settle(reviewer, AGENT_ID, orderId, MIN_PAYMENT, 0, type(uint256).max, nonce, "");

        ReviewGatewayHarness strict = new ReviewGatewayHarness(
            signerB, address(rep), address(identity), address(settler), address(nullifiers), MIN_PAYMENT * 10
        );
        settler.setReviewGateway(address(strict));

        ReviewGateway.Attestation memory a = _att(strict, signerKeyB, NULLIFIER, receiptId);
        vm.expectRevert("payment below minimum");
        strict.submitPaidReview(a);

        assertFalse(_spent(receiptId), "receipt unspent");
    }

    function test_Receipts_CannotBeConsumedTwiceAcrossMigration() public {
        bytes32 receiptId = _settle(bytes32(uint256(1)));

        gwA.submitPaidReview(_att(gwA, signerKeyA, NULLIFIER, receiptId));
        assertTrue(_spent(receiptId), "spent on A");

        settler.setReviewGateway(address(gwB));

        // A different human, so the nullifier is not what stops this.
        ReviewGateway.Attestation memory a = _att(gwB, signerKeyB, keccak256("another-human"), receiptId);
        vm.expectRevert("receipt spent");
        gwB.submitPaidReview(a);

        assertEq(rep.callCount(), 1, "one paid review only");
    }
}
