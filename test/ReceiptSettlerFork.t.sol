// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {IUSDC} from "../src/interfaces/IUSDC.sol";

/// @dev Real ERC-8004 Identity Registry register() entrypoint (not in the
///      production IIdentityRegistry, which only needs reads). register() mints a
///      fresh agent and auto-sets agentWallet = msg.sender.
interface IIdentityRegister {
    function register() external returns (uint256 agentId);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

/// @dev Extra USDC views used only to verify the live EIP-712 domain/typehash.
interface IUSDCDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
}

/// @title ReceiptSettler fork integration tests (real Sepolia USDC)
/// @notice Exercises the full EIP-3009 signing path against the real Circle USDC
///         and ERC-8004 Identity Registry on an Ethereum Sepolia fork, pinned to
///         SEPOLIA_FORK_BLOCK. Opt-in via RUN_FORK_TESTS=true, so the offline
///         suite never touches the network.
contract ReceiptSettlerForkTest is Test {
    // Verified Sepolia deployments.
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    // ReceiveWithAuthorization type hash; asserted against the live contract.
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    uint256 internal constant MIN_PAYMENT = 1_000_000; // 1 USDC
    uint256 internal constant AMOUNT = 5_000_000; // 5 USDC
    uint256 internal constant FUND = 100_000_000; // 100 USDC

    bool internal forkEnabled;

    ReceiptSettler internal settler;
    uint256 internal agentId;
    address internal agentWallet;

    address internal payer;
    uint256 internal payerKey;
    address internal relayer = makeAddr("relayer");

    /// @dev Skip the body (reported as skipped) when fork tests are not enabled.
    modifier onlyFork() {
        if (!forkEnabled) {
            vm.skip(true, "set RUN_FORK_TESTS=true to run fork tests");
            return;
        }
        _;
    }

    function setUp() public {
        // Opt-in, so an ordinary `forge test` needs no network at all. Neither
        // Sepolia variable is read unless fork tests are actually enabled.
        forkEnabled = vm.envOr("RUN_FORK_TESTS", false);
        if (!forkEnabled) {
            return;
        }

        string memory rpc = vm.envString("SEPOLIA_RPC_URL");

        // Required rather than defaulted. setUp() re-runs before every test, so
        // forking at `latest` let each test resolve a different head block —
        // Sepolia advanced mid-suite — and pulled live third-party state into
        // results that are supposed to be reproducible.
        uint256 forkBlock = vm.envUint("SEPOLIA_FORK_BLOCK");
        vm.createSelectFork(rpc, forkBlock);
        assertEq(block.number, forkBlock, "fork must sit on the pinned block");

        settler = new ReceiptSettler(USDC, IDENTITY, MIN_PAYMENT);

        // Verify the signing constants against the live contract.
        assertEq(RECEIVE_TYPEHASH, IUSDCDomain(USDC).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), "typehash mismatch");

        // Register a fresh agent whose wallet is a dedicated owner EOA.
        address agentOwner = makeAddr("agentOwner");
        vm.prank(agentOwner);
        agentId = IIdentityRegister(IDENTITY).register();
        agentWallet = IIdentityRegister(IDENTITY).getAgentWallet(agentId);
        assertEq(agentWallet, agentOwner, "agent wallet should be registrant");

        // Local payer key we control; fund it with real USDC via deal.
        (payer, payerKey) = makeAddrAndKey("payer");
        deal(USDC, payer, FUND);
        assertEq(_bal(payer), FUND, "payer funded");
    }

    function _bal(address who) internal view returns (uint256) {
        // balanceOf via low-level call to avoid widening the production interface.
        (bool ok, bytes memory data) = USDC.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok, "balanceOf failed");
        return abi.decode(data, (uint256));
    }

    function _nonce(uint256 agentId_, bytes32 orderId) internal view returns (bytes32) {
        return keccak256(abi.encode(agentId_, orderId, block.chainid, address(settler)));
    }

    /// @dev Build a ReceiveWithAuthorization signature with the live domain.
    function _sign(
        uint256 key,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 domainSep = IUSDCDomain(USDC).DOMAIN_SEPARATOR();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev 1: happy path through real USDC.
    function test_Fork_Settle_Success() public onlyFork {
        bytes32 orderId = bytes32(uint256(1));
        bytes32 nonce = _nonce(agentId, orderId);
        bytes memory sig = _sign(payerKey, payer, address(settler), AMOUNT, 0, type(uint256).max, nonce);

        uint256 payerBefore = _bal(payer);
        uint256 agentBefore = _bal(agentWallet);

        vm.prank(relayer);
        bytes32 receiptId = settler.settle(payer, agentId, orderId, AMOUNT, 0, type(uint256).max, nonce, sig);

        assertEq(receiptId, nonce, "receiptId == nonce");
        assertEq(_bal(payer), payerBefore - AMOUNT, "payer debited exactly");
        assertEq(_bal(agentWallet), agentBefore + AMOUNT, "agent credited exactly");
        assertEq(_bal(address(settler)), 0, "settler holds nothing");

        (address rPayer, uint256 rAgentId, uint256 rAmount,, bool rSpent,) = settler.receipts(nonce);
        assertEq(rPayer, payer, "receipt payer");
        assertEq(rAgentId, agentId, "receipt agentId");
        assertEq(rAmount, AMOUNT, "receipt amount");
        assertEq(rSpent, false, "receipt not spent");
    }

    /// @dev 2: expired authorization rejected by USDC.
    function test_Fork_Settle_Expired_Reverts() public onlyFork {
        bytes32 orderId = bytes32(uint256(2));
        bytes32 nonce = _nonce(agentId, orderId);
        uint256 validBefore = block.timestamp - 1;
        bytes memory sig = _sign(payerKey, payer, address(settler), AMOUNT, 0, validBefore, nonce);

        vm.prank(relayer);
        vm.expectRevert();
        settler.settle(payer, agentId, orderId, AMOUNT, 0, validBefore, nonce, sig);
    }

    /// @dev 3: not-yet-valid authorization rejected by USDC.
    function test_Fork_Settle_NotYetValid_Reverts() public onlyFork {
        bytes32 orderId = bytes32(uint256(3));
        bytes32 nonce = _nonce(agentId, orderId);
        uint256 validAfter = block.timestamp + 1 days;
        bytes memory sig = _sign(payerKey, payer, address(settler), AMOUNT, validAfter, type(uint256).max, nonce);

        vm.prank(relayer);
        vm.expectRevert();
        settler.settle(payer, agentId, orderId, AMOUNT, validAfter, type(uint256).max, nonce, sig);
    }

    /// @dev 4: a signature from the wrong key is rejected by USDC.
    function test_Fork_Settle_WrongKey_Reverts() public onlyFork {
        bytes32 orderId = bytes32(uint256(4));
        bytes32 nonce = _nonce(agentId, orderId);
        (, uint256 wrongKey) = makeAddrAndKey("wrong");
        // Signed by wrongKey but `from` is payer, so USDC recovers a mismatch.
        bytes memory sig = _sign(wrongKey, payer, address(settler), AMOUNT, 0, type(uint256).max, nonce);

        vm.prank(relayer);
        vm.expectRevert();
        settler.settle(payer, agentId, orderId, AMOUNT, 0, type(uint256).max, nonce, sig);
    }

    /// @dev 5: a duplicate order is rejected by ReceiptSettler (our revert).
    function test_Fork_Settle_DuplicateOrder_Reverts() public onlyFork {
        bytes32 orderId = bytes32(uint256(5));
        bytes32 nonce = _nonce(agentId, orderId);
        bytes memory sig = _sign(payerKey, payer, address(settler), AMOUNT, 0, type(uint256).max, nonce);

        vm.prank(relayer);
        settler.settle(payer, agentId, orderId, AMOUNT, 0, type(uint256).max, nonce, sig);

        vm.prank(relayer);
        vm.expectRevert("receipt exists");
        settler.settle(payer, agentId, orderId, AMOUNT, 0, type(uint256).max, nonce, sig);
    }

    /// @dev 6: a nonce signed for a different order is rejected by ReceiptSettler.
    function test_Fork_Settle_NonceMismatch_Reverts() public onlyFork {
        bytes32 orderA = bytes32(uint256(6));
        bytes32 orderB = bytes32(uint256(0x60B));
        bytes32 nonceB = _nonce(agentId, orderB);
        // Sign a valid authorization for nonceB, but submit it under orderA.
        bytes memory sig = _sign(payerKey, payer, address(settler), AMOUNT, 0, type(uint256).max, nonceB);

        vm.prank(relayer);
        vm.expectRevert("nonce mismatch");
        settler.settle(payer, agentId, orderA, AMOUNT, 0, type(uint256).max, nonceB, sig);
    }

    /// @dev 7: USDC itself rejects replay of a consumed authorization.
    function test_Fork_USDC_AuthorizationReplay_Reverts() public onlyFork {
        // Consume directly against USDC: to == msg.sender == this test contract.
        bytes32 nonce = keccak256("direct-replay");
        bytes memory sig = _sign(payerKey, payer, address(this), AMOUNT, 0, type(uint256).max, nonce);

        IUSDC(USDC).receiveWithAuthorization(payer, address(this), AMOUNT, 0, type(uint256).max, nonce, sig);
        assertTrue(IUSDC(USDC).authorizationState(payer, nonce), "nonce marked used");

        vm.expectRevert();
        IUSDC(USDC).receiveWithAuthorization(payer, address(this), AMOUNT, 0, type(uint256).max, nonce, sig);
    }
}
