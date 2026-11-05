// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {MockIdentityRegistry, MockUSDC} from "./ReceiptSettler.t.sol";

/// @title ReceiptNonceCollisionTest
/// @notice F-03 reproduction: the receipt id is derived without the payer, so
///         any payer can occupy another payer's (agentId, orderId) slot.
/// @dev This records current behaviour rather than asserting desired behaviour.
///      The nonce formula is unchanged and this adds no production code; it
///      exists so the limitation is demonstrated rather than argued about, and
///      so a future change to the derivation has something to break.
///
///      The headline finding is in `test_Squatting_CannotTouchVictimFunds`:
///      this is a griefing vector, not a theft vector, and it costs the attacker
///      a real payment to the agent they are griefing.
contract ReceiptNonceCollisionTest is Test {
    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;
    ReceiptSettler internal settler;

    address internal victim = makeAddr("victim");
    address internal attacker = makeAddr("attacker");
    address internal agentWallet = makeAddr("agentWallet");

    uint256 internal constant AGENT_ID = 7;
    uint256 internal constant MIN_PAYMENT = 1_000_000; // 1 USDC
    uint256 internal constant AMOUNT = 5_000_000; // 5 USDC
    uint256 internal constant FUNDING = 100_000_000;

    /// @dev Predictable on purpose: a sequential or otherwise guessable order id
    ///      is the precondition the whole attack rests on.
    bytes32 internal constant ORDER_ID = bytes32(uint256(1));

    function setUp() public {
        usdc = new MockUSDC();
        identity = new MockIdentityRegistry();
        settler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);

        identity.setWallet(AGENT_ID, agentWallet);
        usdc.mint(victim, FUNDING);
        usdc.mint(attacker, FUNDING);
    }

    /// @dev The id both payers will derive, independent of who pays.
    function _nonce(uint256 agentId, bytes32 orderId) internal view returns (bytes32) {
        return keccak256(abi.encode(agentId, orderId, block.chainid, address(settler)));
    }

    function _settle(address payer, bytes32 orderId, uint256 amount) internal returns (bytes32) {
        bytes32 nonce = _nonce(AGENT_ID, orderId);
        return settler.settle(payer, AGENT_ID, orderId, amount, 0, type(uint256).max, nonce, "");
    }

    // --- the collision itself ---

    function test_Collision_BothPayersDeriveTheSameReceiptId() public view {
        // The formula takes agentId, orderId, chainid and the settler address.
        // Nothing distinguishes one payer from another.
        bytes32 forVictim = _nonce(AGENT_ID, ORDER_ID);
        bytes32 forAttacker = _nonce(AGENT_ID, ORDER_ID);

        assertEq(forVictim, forAttacker, "one id for both payers");
    }

    function test_Collision_DifferentOrderIdsDoNotCollide() public view {
        assertNotEq(_nonce(AGENT_ID, ORDER_ID), _nonce(AGENT_ID, bytes32(uint256(2))), "order id");
        assertNotEq(_nonce(AGENT_ID, ORDER_ID), _nonce(AGENT_ID + 1, ORDER_ID), "agent id");
    }

    // --- the attack sequence ---

    function test_Squatting_AttackerOccupiesTheSlotFirst() public {
        // 1. The attacker settles a real payment against the victim's order id.
        bytes32 receiptId = _settle(attacker, ORDER_ID, MIN_PAYMENT);

        (address payer, uint256 agentId, uint256 amount,, bool spent,) = settler.receipts(receiptId);
        assertEq(payer, attacker, "receipt belongs to the attacker");
        assertEq(agentId, AGENT_ID, "for the victim's agent");
        assertEq(amount, MIN_PAYMENT, "at the cheapest qualifying amount");
        assertFalse(spent, "unspent");

        // 2. The victim's settlement now hits an occupied slot.
        vm.expectRevert("receipt exists");
        _settle(victim, ORDER_ID, AMOUNT);
    }

    function test_Squatting_CannotTouchVictimFunds() public {
        uint256 victimBefore = usdc.balanceOf(victim);
        uint256 attackerBefore = usdc.balanceOf(attacker);
        uint256 agentBefore = usdc.balanceOf(agentWallet);

        _settle(attacker, ORDER_ID, MIN_PAYMENT);

        vm.expectRevert("receipt exists");
        _settle(victim, ORDER_ID, AMOUNT);

        // The attacker paid; the victim did not. There is no path by which the
        // victim's balance moves, because `settle` pulls from the `payer`
        // argument and USDC verifies that payer's own authorization.
        assertEq(usdc.balanceOf(victim), victimBefore, "victim untouched");
        assertEq(usdc.balanceOf(attacker), attackerBefore - MIN_PAYMENT, "attacker paid");
        assertEq(usdc.balanceOf(agentWallet), agentBefore + MIN_PAYMENT, "agent received it");
    }

    function test_Squatting_DoesNotBurnTheVictimsAuthorization() public {
        _settle(attacker, ORDER_ID, MIN_PAYMENT);

        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);
        vm.expectRevert("receipt exists");
        _settle(victim, ORDER_ID, AMOUNT);

        // The revert happens in _validate, before receiveWithAuthorization, so
        // the victim's EIP-3009 nonce is never consumed. Nothing of theirs is
        // spent and the signature could still be used elsewhere.
        assertFalse(usdc.authorizationState(victim, nonce), "victim nonce unused");
    }

    function test_Squatting_VictimRecoversWithADifferentOrderId() public {
        _settle(attacker, ORDER_ID, MIN_PAYMENT);

        vm.expectRevert("receipt exists");
        _settle(victim, ORDER_ID, AMOUNT);

        // The remedy available today, with no contract change: pick another id.
        bytes32 retryId = _settle(victim, bytes32(uint256(99)), AMOUNT);

        (address payer,, uint256 amount,,,) = settler.receipts(retryId);
        assertEq(payer, victim, "victim now holds a receipt");
        assertEq(amount, AMOUNT, "for the intended amount");
        assertNotEq(retryId, _nonce(AGENT_ID, ORDER_ID), "a different slot");
    }

    function test_Squatting_CostsTheAttackerRealMoneyPaidToTheTarget() public {
        // Each squat is a settled payment, and the proceeds go to the agent
        // being griefed. Blocking N order ids costs N * minPayment, all of it
        // delivered to the target.
        uint256 agentBefore = usdc.balanceOf(agentWallet);
        uint256 attackerBefore = usdc.balanceOf(attacker);

        for (uint256 i = 1; i <= 5; i++) {
            _settle(attacker, bytes32(i), MIN_PAYMENT);
        }

        assertEq(usdc.balanceOf(attacker), attackerBefore - 5 * MIN_PAYMENT, "attacker spent");
        assertEq(usdc.balanceOf(agentWallet), agentBefore + 5 * MIN_PAYMENT, "target received it");
    }

    function test_Squatting_CannotBeDoneForFree() public {
        // Below the minimum there is no settlement and so no squat.
        vm.expectRevert("amount below minimum");
        _settle(attacker, ORDER_ID, MIN_PAYMENT - 1);

        (address payer,,,,,) = settler.receipts(_nonce(AGENT_ID, ORDER_ID));
        assertEq(payer, address(0), "slot still free");
    }

    function test_Squatting_GivesTheAttackerNothingTheyLacked() public {
        // The squatted receipt is an ordinary receipt the attacker paid for.
        // They could have obtained one with their own order id at the same
        // price, so squatting buys no review right they did not already have.
        bytes32 squatted = _settle(attacker, ORDER_ID, MIN_PAYMENT);
        bytes32 ordinary = _settle(attacker, bytes32(uint256(1234)), MIN_PAYMENT);

        (address p1,, uint256 a1,,,) = settler.receipts(squatted);
        (address p2,, uint256 a2,,,) = settler.receipts(ordinary);

        assertEq(p1, p2, "same owner");
        assertEq(a1, a2, "same value");
    }

    // --- the victim can also be the one who wins ---

    function test_Squatting_IsOnlyAFrontRunningRace() public {
        // Nothing privileges the attacker. Whoever lands first owns the slot,
        // so this is an ordering race, not an authorization flaw.
        bytes32 receiptId = _settle(victim, ORDER_ID, AMOUNT);

        (address payer,,,,,) = settler.receipts(receiptId);
        assertEq(payer, victim, "victim won the race");

        vm.expectRevert("receipt exists");
        _settle(attacker, ORDER_ID, MIN_PAYMENT);
    }
}
