// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @dev Test-only harness exposing ReceiptSettler's internal preflight helpers
///      and a setter to simulate a pre-existing receipt. Production code keeps
///      these functions internal; the harness lives only in the test build.
contract ReceiptSettlerHarness is ReceiptSettler {
    constructor(address usdc_, address identityRegistry_, uint256 minPayment_)
        ReceiptSettler(usdc_, identityRegistry_, minPayment_)
    {}

    function computeNonce(uint256 agentId, bytes32 orderId) external view returns (bytes32) {
        return _computeNonce(agentId, orderId);
    }

    function validate(address payer, uint256 agentId, bytes32 orderId, uint256 amount, bytes32 signedNonce)
        external
        view
        returns (bytes32 nonce, address agentWallet)
    {
        return _validate(payer, agentId, orderId, amount, signedNonce);
    }

    /// @dev Simulate an already-settled receipt by writing only its payer.
    function seedReceiptPayer(bytes32 nonce, address payer) external {
        receipts[nonce].payer = payer;
    }
}

/// @dev Minimal IIdentityRegistry mock: lets a test set the agent wallet.
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

contract ReceiptSettlerValidationTest is Test {
    ReceiptSettlerHarness internal settler;
    MockIdentityRegistry internal identity;

    address internal usdc = makeAddr("usdc"); // nonzero; unused by validation
    uint256 internal constant MIN_PAYMENT = 1_000_000; // 1 USDC (6 decimals)

    uint256 internal constant AGENT_ID = 1;
    bytes32 internal constant ORDER_ID = bytes32(uint256(0xABCD));
    address internal payer = makeAddr("payer");
    address internal agentWallet = makeAddr("agentWallet");

    function setUp() public {
        identity = new MockIdentityRegistry();
        settler = new ReceiptSettlerHarness(usdc, address(identity), MIN_PAYMENT);
        identity.setWallet(AGENT_ID, agentWallet);
    }

    /// @dev The nonce must equal keccak256(abi.encode(agentId, orderId, chainid, settler)).
    function test_ComputeNonce_MatchesFormula() public view {
        bytes32 expected = keccak256(abi.encode(AGENT_ID, ORDER_ID, block.chainid, address(settler)));
        assertEq(settler.computeNonce(AGENT_ID, ORDER_ID), expected, "nonce formula");
    }

    /// @dev A different agent or order yields a different nonce.
    function test_ComputeNonce_DiffersPerAgentAndOrder() public view {
        bytes32 base = settler.computeNonce(AGENT_ID, ORDER_ID);
        assertTrue(base != settler.computeNonce(AGENT_ID + 1, ORDER_ID), "agent must change nonce");
        assertTrue(base != settler.computeNonce(AGENT_ID, bytes32(uint256(0x1234))), "order must change nonce");
    }

    /// @dev Happy path: valid inputs return the computed nonce and the agent wallet.
    function test_Validate_HappyPath() public view {
        bytes32 nonce = settler.computeNonce(AGENT_ID, ORDER_ID);
        (bytes32 outNonce, address outWallet) = settler.validate(payer, AGENT_ID, ORDER_ID, MIN_PAYMENT, nonce);
        assertEq(outNonce, nonce, "returned nonce");
        assertEq(outWallet, agentWallet, "returned wallet");
    }

    function test_Validate_RevertsOnZeroPayer() public {
        bytes32 nonce = settler.computeNonce(AGENT_ID, ORDER_ID);
        vm.expectRevert("payer is zero");
        settler.validate(address(0), AGENT_ID, ORDER_ID, MIN_PAYMENT, nonce);
    }

    function test_Validate_RevertsOnAmountBelowMinimum() public {
        bytes32 nonce = settler.computeNonce(AGENT_ID, ORDER_ID);
        vm.expectRevert("amount below minimum");
        settler.validate(payer, AGENT_ID, ORDER_ID, MIN_PAYMENT - 1, nonce);
    }

    function test_Validate_RevertsOnNonceMismatch() public {
        bytes32 wrongNonce = settler.computeNonce(AGENT_ID + 1, ORDER_ID);
        vm.expectRevert("nonce mismatch");
        settler.validate(payer, AGENT_ID, ORDER_ID, MIN_PAYMENT, wrongNonce);
    }

    function test_Validate_RevertsOnUnsetAgentWallet() public {
        uint256 agentWithoutWallet = 2; // mock returns address(0) for this id
        bytes32 nonce = settler.computeNonce(agentWithoutWallet, ORDER_ID);
        vm.expectRevert("agent wallet unset");
        settler.validate(payer, agentWithoutWallet, ORDER_ID, MIN_PAYMENT, nonce);
    }

    function test_Validate_RevertsWhenReceiptExists() public {
        bytes32 nonce = settler.computeNonce(AGENT_ID, ORDER_ID);
        settler.seedReceiptPayer(nonce, payer); // simulate already-settled
        vm.expectRevert("receipt exists");
        settler.validate(payer, AGENT_ID, ORDER_ID, MIN_PAYMENT, nonce);
    }
}
