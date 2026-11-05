// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @dev Minimal stand-in satisfying the settler's handshake: it reports the
///      settler it was built against, which is all setReviewGateway reads.
contract GatewayStub {
    address public receiptSettler;
    address public nullifierRegistry;

    constructor(address settler_, address registry_) {
        receiptSettler = settler_;
        nullifierRegistry = registry_;
    }
}

/// @dev A candidate whose registry getter reverts, to prove the settler fails
///      closed rather than reading a zero registry.
contract GatewayStubBadRegistry {
    address public receiptSettler;

    constructor(address settler_) {
        receiptSettler = settler_;
    }

    function nullifierRegistry() external pure returns (address) {
        revert("registry unavailable");
    }
}

/// @dev Minimal IIdentityRegistry mock with a settable agent wallet.
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) public wallet;

    function setWallet(uint256 agentId, address w) external {
        wallet[agentId] = w;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return wallet[agentId];
    }

    function ownerOf(uint256) external pure returns (address) {
        return address(0);
    }

    function isAuthorizedOrOwner(address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev Mock USDC implementing just the EIP-3009 receive flow + transfer, with
///      balance accounting and switches for the failure/reentrancy scenarios.
contract MockUSDC is IUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public usedNonce;

    bool public revertOnReceive; // simulate an invalid authorization
    bool public falseOnTransfer; // simulate a token that returns false

    // Reentrancy harness: when armed, re-enter settle() during receive.
    ReceiptSettler public reenterTarget;
    bytes public reenterError;
    bool public reentered;

    struct ReenterArgs {
        address payer;
        uint256 agentId;
        bytes32 orderId;
        uint256 amount;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 signedNonce;
    }

    ReenterArgs internal _re;
    bool internal _reArmed;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setRevertOnReceive(bool v) external {
        revertOnReceive = v;
    }

    function setFalseOnTransfer(bool v) external {
        falseOnTransfer = v;
    }

    function armReentry(ReceiptSettler target, ReenterArgs calldata args) external {
        reenterTarget = target;
        _re = args;
        _reArmed = true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32 nonce,
        bytes memory
    ) external {
        require(!revertOnReceive, "bad authorization");

        // Attempt a reentrant settle() exactly once, if armed.
        if (_reArmed && !reentered) {
            reentered = true;
            try reenterTarget.settle(
                _re.payer, _re.agentId, _re.orderId, _re.amount, _re.validAfter, _re.validBefore, _re.signedNonce, ""
            ) {
                reenterError = bytes("no-revert");
            } catch Error(string memory reason) {
                reenterError = bytes(reason);
            }
        }

        require(!usedNonce[from][nonce], "authorization used");
        usedNonce[from][nonce] = true;

        // Pull `value` from the payer to the payee (the settler).
        require(balanceOf[from] >= value, "insufficient payer balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return usedNonce[authorizer][nonce];
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (falseOnTransfer) {
            return false;
        }
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}

contract ReceiptSettlerTest is Test {
    ReceiptSettler internal settler;
    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;

    uint256 internal constant MIN_PAYMENT = 1_000_000; // 1 USDC
    uint256 internal constant AMOUNT = 5_000_000; // 5 USDC

    uint256 internal constant AGENT_ID = 1;
    bytes32 internal constant ORDER_ID = bytes32(uint256(0xABCD));
    uint256 internal constant VALID_AFTER = 0;
    uint256 internal constant VALID_BEFORE = type(uint256).max;

    address internal payer = makeAddr("payer");
    address internal relayer = makeAddr("relayer");
    address internal agentWallet = makeAddr("agentWallet");

    event ReceiptSettled(
        bytes32 indexed receiptId, address indexed payer, uint256 indexed agentId, uint256 amount, address agentWallet
    );

    event ReviewGatewaySet(address indexed gateway, address indexed previous);

    address internal gateway; // a deployed stub (the settler requires code)
    address internal registry; // the shared ledger every gateway must keep

    function setUp() public {
        usdc = new MockUSDC();
        identity = new MockIdentityRegistry();
        settler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        registry = address(new NullifierRegistry(address(settler)));
        gateway = address(new GatewayStub(address(settler), registry));
        identity.setWallet(AGENT_ID, agentWallet);
        usdc.mint(payer, 100_000_000); // fund the payer
    }

    function _nonce(uint256 agentId, bytes32 orderId) internal view returns (bytes32) {
        return keccak256(abi.encode(agentId, orderId, block.chainid, address(settler)));
    }

    /// @dev 1 + 2 + 3: successful settlement moves funds and stores the receipt.
    function test_Settle_Success() public {
        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);
        uint256 payerBefore = usdc.balanceOf(payer);

        // Event check (settler is the emitter).
        vm.expectEmit(true, true, true, true, address(settler));
        emit ReceiptSettled(nonce, payer, AGENT_ID, AMOUNT, agentWallet);

        // A relayer (not the payer) submits the settlement.
        vm.prank(relayer);
        bytes32 receiptId = settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        assertEq(receiptId, nonce, "receiptId == nonce");

        // Funds: exact amount reached the agent wallet; settler holds nothing.
        assertEq(usdc.balanceOf(agentWallet), AMOUNT, "agent received amount");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler holds nothing");
        assertEq(usdc.balanceOf(payer), payerBefore - AMOUNT, "payer debited exactly");

        // Receipt fields.
        (address rPayer, uint256 rAgentId, uint256 rAmount, uint64 rSettledAt, bool rSpent, bytes32 rOrderId) =
            settler.receipts(nonce);
        assertEq(rPayer, payer, "receipt payer");
        assertEq(rAgentId, AGENT_ID, "receipt agentId");
        assertEq(rAmount, AMOUNT, "receipt amount");
        assertEq(rSettledAt, uint64(block.timestamp), "receipt settledAt");
        assertEq(rSpent, false, "receipt not spent");
        assertEq(rOrderId, ORDER_ID, "receipt orderId");
    }

    /// @dev 4: an invalid authorization reverts and leaves no receipt / no funds.
    function test_Settle_InvalidAuthorization_Reverts_NoState() public {
        usdc.setRevertOnReceive(true);
        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectRevert("bad authorization");
        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        (address rPayer,,,,,) = settler.receipts(nonce);
        assertEq(rPayer, address(0), "no receipt persisted");
        assertEq(usdc.balanceOf(agentWallet), 0, "no funds to agent");
        assertEq(usdc.balanceOf(payer), payerBefore, "payer not debited");
    }

    /// @dev 5: a transfer that returns false reverts the whole settlement.
    function test_Settle_TransferReturnsFalse_Reverts_NoState() public {
        usdc.setFalseOnTransfer(true);
        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectRevert("usdc transfer failed");
        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        (address rPayer,,,,,) = settler.receipts(nonce);
        assertEq(rPayer, address(0), "no receipt persisted");
        assertEq(usdc.balanceOf(agentWallet), 0, "no funds to agent");
        assertEq(usdc.balanceOf(payer), payerBefore, "payer balance restored");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler holds nothing");
    }

    /// @dev 6: a second settlement for the same order/nonce is rejected.
    function test_Settle_DuplicateOrder_Reverts() public {
        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);
        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        vm.expectRevert("receipt exists");
        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");
    }

    /// @dev 7: a reentrant settle() during the USDC receive is rejected by the
    ///      guard, while the outer settlement still completes.
    function test_Settle_ReentrancyRejected() public {
        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);

        // Arm the mock to re-enter with a different order (would otherwise be a
        // fresh, valid settlement) so only the guard can stop it.
        bytes32 innerOrder = bytes32(uint256(0xBEEF));
        usdc.armReentry(
            settler,
            MockUSDC.ReenterArgs({
                payer: payer,
                agentId: AGENT_ID,
                orderId: innerOrder,
                amount: AMOUNT,
                validAfter: VALID_AFTER,
                validBefore: VALID_BEFORE,
                signedNonce: _nonce(AGENT_ID, innerOrder)
            })
        );

        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        assertTrue(usdc.reentered(), "reentry was attempted");
        assertEq(string(usdc.reenterError()), "reentrant call", "reentry rejected by guard");

        // Outer settlement still succeeded.
        (address rPayer,,,,,) = settler.receipts(nonce);
        assertEq(rPayer, payer, "outer receipt persisted");
        assertEq(usdc.balanceOf(agentWallet), AMOUNT, "outer payment delivered");
    }

    /// @dev 8: an unset agent wallet is rejected before any token interaction.
    function test_Settle_UnsetAgentWallet_Reverts() public {
        uint256 agentWithoutWallet = 2; // mock returns address(0)
        bytes32 nonce = _nonce(agentWithoutWallet, ORDER_ID);

        vm.expectRevert("agent wallet unset");
        settler.settle(payer, agentWithoutWallet, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        (address rPayer,,,,,) = settler.receipts(nonce);
        assertEq(rPayer, address(0), "no receipt persisted");
    }

    /// @dev 9: an agent wallet equal to the settler itself is rejected, so a
    ///      settlement can never route funds back to this contract.
    function test_Settle_AgentWalletIsSettler_Reverts_NoState() public {
        identity.setWallet(AGENT_ID, address(settler));
        bytes32 nonce = _nonce(AGENT_ID, ORDER_ID);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectRevert("agent wallet is settler");
        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");

        (address rPayer,,,,,) = settler.receipts(nonce);
        assertEq(rPayer, address(0), "no receipt persisted");
        assertEq(usdc.balanceOf(payer), payerBefore, "payer not debited");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler holds nothing");
    }

    // --- Chunk 1: ReviewGateway configuration + receipt consumption ---

    /// @dev Settle the standard receipt and return its id, for consume tests.
    function _settleStandard() internal returns (bytes32 nonce) {
        nonce = _nonce(AGENT_ID, ORDER_ID);
        vm.prank(relayer);
        settler.settle(payer, AGENT_ID, ORDER_ID, AMOUNT, VALID_AFTER, VALID_BEFORE, nonce, "");
    }

    /// @dev 1: the configurator (test deployer) sets the initial gateway.
    function test_SetReviewGateway_Success() public {
        vm.expectEmit(true, false, false, false, address(settler));
        emit ReviewGatewaySet(gateway, address(0));
        settler.setReviewGateway(gateway);
        assertEq(settler.reviewGateway(), gateway, "gateway configured");
    }

    /// @dev 2: a non-configurator cannot configure the gateway.
    function test_SetReviewGateway_OnlyConfigurator() public {
        vm.prank(relayer);
        vm.expectRevert("not configurator");
        settler.setReviewGateway(gateway);
    }

    /// @dev 3: the zero address is rejected.
    function test_SetReviewGateway_RejectsZero() public {
        vm.expectRevert("zero gateway");
        settler.setReviewGateway(address(0));
    }

    /// @dev 3b: an EOA (no code) is rejected; a deployed contract is accepted.
    function test_SetReviewGateway_RejectsEOA() public {
        address eoa = makeAddr("eoa");
        assertEq(eoa.code.length, 0, "precondition: eoa has no code");
        vm.expectRevert("gateway has no code");
        settler.setReviewGateway(eoa);

        // A deployed contract still configures fine.
        settler.setReviewGateway(gateway);
        assertEq(settler.reviewGateway(), gateway, "contract gateway configured");
    }

    /// @dev 4: the gateway can be replaced, which is the recovery mechanism.
    ///      This previously asserted the opposite — the pointer was one-time, so
    ///      a compromised signer or a flawed gateway could never be answered and
    ///      unspent receipts were stranded. F-02 inverted it deliberately.
    function test_SetReviewGateway_CanBeReplaced() public {
        settler.setReviewGateway(gateway);

        address replacement = address(new GatewayStub(address(settler), registry));
        vm.expectEmit(true, true, true, true);
        emit ReviewGatewaySet(replacement, gateway);
        settler.setReviewGateway(replacement);

        assertEq(settler.reviewGateway(), replacement, "pointer moved");
    }

    /// @dev Replacement is configurator-only, like the first wiring.
    function test_SetReviewGateway_ReplacementOnlyConfigurator() public {
        settler.setReviewGateway(gateway);
        address replacement = address(new GatewayStub(address(settler), registry));

        vm.prank(makeAddr("stranger"));
        vm.expectRevert("not configurator");
        settler.setReviewGateway(replacement);

        assertEq(settler.reviewGateway(), gateway, "pointer unchanged");
    }

    /// @dev Re-setting the current gateway is a no-op and rejected as such.
    function test_SetReviewGateway_RejectsTheCurrentGateway() public {
        settler.setReviewGateway(gateway);

        vm.expectRevert("gateway unchanged");
        settler.setReviewGateway(gateway);

        assertEq(settler.reviewGateway(), gateway, "pointer unchanged");
    }

    /// @dev The handshake: a candidate built against another settler is refused.
    function test_SetReviewGateway_RejectsForeignGateway() public {
        ReceiptSettler other = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        address foreign = address(new GatewayStub(address(other), registry));

        vm.expectRevert("gateway settler mismatch");
        settler.setReviewGateway(foreign);

        assertEq(settler.reviewGateway(), address(0), "pointer unchanged");
    }

    /// @dev A contract with no receiptSettler() cannot be named active: the
    ///      handshake call itself reverts, so it fails closed.
    function test_SetReviewGateway_RejectsContractWithoutHandshake() public {
        address notAGateway = address(new MockIdentityRegistry());

        vm.expectRevert();
        settler.setReviewGateway(notAGateway);

        assertEq(settler.reviewGateway(), address(0), "pointer unchanged");
    }

    /// @dev The successor must keep writing to the same nullifier ledger. A
    ///      fresh registry bound to this same settler passes every other check
    ///      while starting empty, which would reset one-human-one-review on
    ///      each migration.
    function test_SetReviewGateway_RejectsAFreshRegistry() public {
        settler.setReviewGateway(gateway);

        address emptyRegistry = address(new NullifierRegistry(address(settler)));
        address replacement = address(new GatewayStub(address(settler), emptyRegistry));

        vm.expectRevert("nullifier registry mismatch");
        settler.setReviewGateway(replacement);

        assertEq(settler.reviewGateway(), gateway, "pointer unchanged");
    }

    /// @dev Same ledger, different gateway: the supported migration.
    function test_SetReviewGateway_AcceptsTheSameRegistry() public {
        settler.setReviewGateway(gateway);

        address replacement = address(new GatewayStub(address(settler), registry));
        settler.setReviewGateway(replacement);

        assertEq(settler.reviewGateway(), replacement, "pointer moved");
    }

    /// @dev A registry belonging to another deployment is refused too — caught
    ///      by the continuity check, since it cannot equal the incumbent's.
    function test_SetReviewGateway_RejectsARegistryFromAnotherSettler() public {
        settler.setReviewGateway(gateway);

        ReceiptSettler other = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        address foreignRegistry = address(new NullifierRegistry(address(other)));
        address replacement = address(new GatewayStub(address(settler), foreignRegistry));

        vm.expectRevert("nullifier registry mismatch");
        settler.setReviewGateway(replacement);

        assertEq(settler.reviewGateway(), gateway, "pointer unchanged");
    }

    /// @dev A zero registry can never become active, on first wiring or later.
    function test_SetReviewGateway_RejectsAZeroRegistry() public {
        address noRegistry = address(new GatewayStub(address(settler), address(0)));

        vm.expectRevert("gateway registry is zero");
        settler.setReviewGateway(noRegistry);

        assertEq(settler.reviewGateway(), address(0), "pointer unchanged");
    }

    /// @dev A candidate whose registry getter reverts fails closed: the read is
    ///      never interpreted as "no registry".
    function test_SetReviewGateway_FailsClosedWhenTheRegistryGetterReverts() public {
        address broken = address(new GatewayStubBadRegistry(address(settler)));

        vm.expectRevert("registry unavailable");
        settler.setReviewGateway(broken);

        assertEq(settler.reviewGateway(), address(0), "pointer unchanged");
    }

    /// @dev Every rejected replacement leaves the live pointer exactly as it was.
    function test_SetReviewGateway_FailedReplacementsLeavePointerIntact() public {
        settler.setReviewGateway(gateway);

        vm.expectRevert("zero gateway");
        settler.setReviewGateway(address(0));

        vm.expectRevert("gateway has no code");
        settler.setReviewGateway(makeAddr("eoa"));

        vm.expectRevert("gateway unchanged");
        settler.setReviewGateway(gateway);

        assertEq(settler.reviewGateway(), gateway, "still the original");
    }

    /// @dev 5: consumption is rejected before the gateway is configured.
    function test_Consume_RejectedBeforeConfiguration() public {
        bytes32 nonce = _settleStandard();
        vm.prank(gateway); // not yet configured
        vm.expectRevert("not gateway");
        settler.consume(nonce, payer, AGENT_ID);
    }

    /// @dev 6: a non-gateway address cannot consume.
    function test_Consume_OnlyGateway() public {
        bytes32 nonce = _settleStandard();
        settler.setReviewGateway(gateway);
        vm.prank(relayer);
        vm.expectRevert("not gateway");
        settler.consume(nonce, payer, AGENT_ID);
    }

    /// @dev 7: a successful consumption returns the receipt and sets spent = true.
    function test_Consume_Success() public {
        bytes32 nonce = _settleStandard();
        settler.setReviewGateway(gateway);

        vm.prank(gateway);
        ReceiptSettler.Receipt memory r = settler.consume(nonce, payer, AGENT_ID);

        assertEq(r.payer, payer, "returned payer");
        assertEq(r.agentId, AGENT_ID, "returned agentId");
        assertEq(r.amount, AMOUNT, "returned amount");
        assertEq(r.orderId, ORDER_ID, "returned orderId");
        assertEq(r.spent, true, "returned spent");

        (,,,, bool storedSpent,) = settler.receipts(nonce);
        assertEq(storedSpent, true, "stored spent");
    }

    /// @dev 8: a receipt cannot be consumed twice.
    function test_Consume_DuplicateRejected() public {
        bytes32 nonce = _settleStandard();
        settler.setReviewGateway(gateway);

        vm.prank(gateway);
        settler.consume(nonce, payer, AGENT_ID);

        vm.prank(gateway);
        vm.expectRevert("receipt spent");
        settler.consume(nonce, payer, AGENT_ID);
    }

    /// @dev 9: an incorrect payer is rejected without marking the receipt spent.
    function test_Consume_WrongPayer_Rejected_NoState() public {
        bytes32 nonce = _settleStandard();
        settler.setReviewGateway(gateway);

        vm.prank(gateway);
        vm.expectRevert("payer mismatch");
        settler.consume(nonce, relayer, AGENT_ID);

        (,,,, bool storedSpent,) = settler.receipts(nonce);
        assertEq(storedSpent, false, "receipt not spent");
    }

    /// @dev 10: an incorrect agent id is rejected without marking the receipt spent.
    function test_Consume_WrongAgent_Rejected_NoState() public {
        bytes32 nonce = _settleStandard();
        settler.setReviewGateway(gateway);

        vm.prank(gateway);
        vm.expectRevert("agent mismatch");
        settler.consume(nonce, payer, AGENT_ID + 1);

        (,,,, bool storedSpent,) = settler.receipts(nonce);
        assertEq(storedSpent, false, "receipt not spent");
    }

    /// @dev 11: an unknown receipt id is rejected.
    function test_Consume_UnknownReceipt_Rejected() public {
        settler.setReviewGateway(gateway);
        vm.prank(gateway);
        vm.expectRevert("unknown receipt");
        settler.consume(keccak256("nope"), payer, AGENT_ID);
    }
}
