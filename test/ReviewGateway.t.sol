// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// @dev Test harness exposing the internal verification + digest helpers.
contract ReviewGatewayHarness is ReviewGateway {
    constructor(address signer, address rep, address id, address settler, address nullifierRegistry, uint256 minPayment)
        ReviewGateway(signer, rep, id, settler, nullifierRegistry, minPayment)
    {}

    function verify(Attestation calldata att) external view {
        _verifyAttestation(att);
    }

    function digestOf(Attestation calldata att) external view returns (bytes32) {
        return _digest(att);
    }

    function consumeNullifier(uint256 agentId, bytes32 nullifier) external {
        _consumeNullifier(agentId, nullifier);
    }
}

/// @dev Reputation Registry mock recording the last giveFeedback call. Only the
///      giveFeedback selector is needed (the gateway never reads back), so this
///      intentionally does not implement the full IReputationRegistry interface.
contract MockReputationRegistry {
    bool public called;
    uint256 public callCount;
    uint256 public lastAgentId;
    int128 public lastValue;
    uint8 public lastValueDecimals;
    string public lastTag1;
    string public lastTag2;
    string public lastEndpoint;
    string public lastFeedbackURI;
    bytes32 public lastFeedbackHash;
    bool public revertOnFeedback;

    function setRevert(bool v) external {
        revertOnFeedback = v;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(!revertOnFeedback, "registry revert");
        called = true;
        callCount++;
        lastAgentId = agentId;
        lastValue = value;
        lastValueDecimals = valueDecimals;
        lastTag1 = tag1;
        lastTag2 = tag2;
        lastEndpoint = endpoint;
        lastFeedbackURI = feedbackURI;
        lastFeedbackHash = feedbackHash;
    }
}

/// @dev ReceiptSettler mock mirroring consume()'s checks and Receipt tuple. Not
///      declared `is IReceiptSettler` to avoid a struct-type clash; the selector
///      and return tuple match, which is all the gateway needs.
contract MockReceiptSettler {
    /// @dev The active gateway. Private with an explicit getter so the getter
    ///      itself can be made to revert, which is what proves callers fail
    ///      closed rather than reading a zero address.
    address private _reviewGateway;
    bool public revertOnGatewayRead;

    /// @dev Freely settable in tests; the real settler restricts this.
    function setReviewGateway(address gateway) external {
        _reviewGateway = gateway;
    }

    function setRevertOnGatewayRead(bool v) external {
        revertOnGatewayRead = v;
    }

    function reviewGateway() external view returns (address) {
        require(!revertOnGatewayRead, "settler unavailable");
        return _reviewGateway;
    }

    struct Receipt {
        address payer;
        uint256 agentId;
        uint256 amount;
        uint64 settledAt;
        bool spent;
        bytes32 orderId;
    }

    mapping(bytes32 => Receipt) public receipts;

    function setReceipt(bytes32 id, address payer, uint256 agentId, uint256 amount, uint64 settledAt) external {
        receipts[id] = Receipt(payer, agentId, amount, settledAt, false, bytes32(0));
    }

    function consume(bytes32 receiptId, address expectedPayer, uint256 expectedAgentId)
        external
        returns (Receipt memory)
    {
        require(msg.sender == _reviewGateway, "not gateway");
        Receipt storage rp = receipts[receiptId];
        require(rp.payer != address(0), "unknown receipt");
        require(!rp.spent, "receipt spent");
        require(rp.payer == expectedPayer, "payer mismatch");
        require(rp.agentId == expectedAgentId, "agent mismatch");
        rp.spent = true;
        return rp;
    }
}

/// @dev Identity Registry mock: settable owner/authorization and an optional
///      revert to simulate a nonexistent agent (real ERC-721 ownerOf reverts).
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(uint256 => address) public owners;
    mapping(uint256 => mapping(address => bool)) public auth;
    mapping(uint256 => bool) public revertAuth;
    mapping(uint256 => address) public walletOf;

    function setOwner(uint256 agentId, address owner) external {
        owners[agentId] = owner;
    }

    function setAuthorized(address spender, uint256 agentId, bool v) external {
        auth[agentId][spender] = v;
    }

    function setRevertAuth(uint256 agentId, bool v) external {
        revertAuth[agentId] = v;
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        require(!revertAuth[agentId], "nonexistent agent");
        return spender == owners[agentId] || auth[agentId][spender];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return walletOf[agentId];
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return owners[agentId];
    }
}

contract ReviewGatewayAttestationTest is Test {
    ReviewGatewayHarness internal gw;

    // secp256k1 order, for crafting a malleable high-s signature.
    uint256 internal constant SECP256K1N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address internal signer;
    uint256 internal signerKey;

    MockReputationRegistry internal rep;
    MockIdentityRegistry internal id;
    MockReceiptSettler internal settler;
    NullifierRegistry internal nullifiers;

    uint256 internal constant AGENT_ID = 1;
    bytes32 internal constant NULLIFIER = keccak256("nullifier-1");
    address internal reviewer = makeAddr("reviewer");
    address internal relayer = makeAddr("relayer");

    uint256 internal constant MIN_PAYMENT = 1_000_000; // 1 USDC
    uint256 internal constant PAID_AMOUNT = 5_000_000; // 5 USDC
    bytes32 internal constant RECEIPT_ID = keccak256("receipt-1");

    uint64 internal constant FUTURE = 1 hours;
    bytes32 internal constant FREE_HASH = keccak256("free-evidence");
    bytes32 internal constant PAID_HASH = keccak256("paid-evidence");
    string internal constant FREE_URI = "ipfs://free";
    string internal constant PAID_URI = "ipfs://paid";
    int128 internal constant FREE_VALUE = 80;
    int128 internal constant PAID_VALUE = 90;

    function setUp() public {
        (signer, signerKey) = makeAddrAndKey("recordServer");
        rep = new MockReputationRegistry();
        id = new MockIdentityRegistry();
        settler = new MockReceiptSettler();
        nullifiers = new NullifierRegistry(address(settler));
        gw = new ReviewGatewayHarness(
            signer, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT
        );
        // The settler names the active gateway; without this every submission
        // is refused, which is the point of the check.
        settler.setReviewGateway(address(gw));
    }

    // --- helpers ---

    /// @dev Sign an attestation with `key` against the gateway's live digest.
    function _signWith(uint256 key, ReviewGateway.Attestation memory a) internal view {
        bytes32 digest = gw.digestOf(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        a.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Build and sign an attestation with all fields specified.
    function _build(
        uint256 agentId,
        bytes32 nullifier,
        address rev,
        uint64 expiry,
        int128 value,
        uint8 valueDecimals,
        bytes32 feedbackHash,
        uint8 reviewType,
        bytes32 receiptId
    ) internal view returns (ReviewGateway.Attestation memory a) {
        a.agentId = agentId;
        a.nullifier = nullifier;
        a.reviewer = rev;
        a.expiry = expiry;
        a.value = value;
        a.valueDecimals = valueDecimals;
        a.feedbackHash = feedbackHash;
        // Signed like every other field now, so it is set before _signWith.
        a.feedbackURI = reviewType == 1 ? PAID_URI : FREE_URI;
        a.reviewType = reviewType;
        a.receiptId = receiptId;
        _signWith(signerKey, a);
    }

    /// @dev A default, signed free attestation (reviewType 0, no receipt).
    function _freeAtt(uint256 agentId, bytes32 nullifier, address rev)
        internal
        view
        returns (ReviewGateway.Attestation memory a)
    {
        a = _build(agentId, nullifier, rev, uint64(block.timestamp + FUTURE), FREE_VALUE, 0, FREE_HASH, 0, bytes32(0));
    }

    /// @dev A default, signed paid attestation (reviewType 1, with receipt).
    function _paidAtt(uint256 agentId, bytes32 nullifier, address rev, bytes32 receiptId)
        internal
        view
        returns (ReviewGateway.Attestation memory a)
    {
        a = _build(agentId, nullifier, rev, uint64(block.timestamp + FUTURE), PAID_VALUE, 0, PAID_HASH, 1, receiptId);
    }

    function _validAtt() internal view returns (ReviewGateway.Attestation memory a) {
        a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
    }

    // --- deployment ---

    function test_Constructor_RejectsZeroSigner() public {
        vm.expectRevert("signer is zero");
        new ReviewGatewayHarness(
            address(0), address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT
        );
    }

    function test_Constructor_AcceptsEOASigner() public {
        (address eoa,) = makeAddrAndKey("eoaSigner");
        assertEq(eoa.code.length, 0, "precondition: eoa has no code");
        ReviewGatewayHarness g = new ReviewGatewayHarness(
            eoa, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT
        );
        assertEq(g.recordServerSigner(), eoa, "eoa signer configured");
    }

    function test_Constructor_RejectsContractSigner() public {
        address contractAddr = address(gw); // a deployed contract (has code)
        assertGt(contractAddr.code.length, 0, "precondition: has code");
        vm.expectRevert("signer must be EOA");
        new ReviewGatewayHarness(
            contractAddr, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT
        );
    }

    function test_Constructor_RejectsZeroReputation() public {
        vm.expectRevert("reputation is zero");
        new ReviewGatewayHarness(signer, address(0), address(id), address(settler), address(nullifiers), MIN_PAYMENT);
    }

    function test_Constructor_RejectsCodelessReputation() public {
        address eoa = makeAddr("notacontract");
        vm.expectRevert("reputation has no code");
        new ReviewGatewayHarness(signer, eoa, address(id), address(settler), address(nullifiers), MIN_PAYMENT);
    }

    function test_Constructor_RejectsZeroIdentity() public {
        vm.expectRevert("identity is zero");
        new ReviewGatewayHarness(signer, address(rep), address(0), address(settler), address(nullifiers), MIN_PAYMENT);
    }

    function test_Constructor_RejectsCodelessIdentity() public {
        address eoa = makeAddr("notacontract2");
        vm.expectRevert("identity has no code");
        new ReviewGatewayHarness(signer, address(rep), eoa, address(settler), address(nullifiers), MIN_PAYMENT);
    }

    function test_Constructor_RejectsZeroSettler() public {
        vm.expectRevert("settler is zero");
        new ReviewGatewayHarness(signer, address(rep), address(id), address(0), address(nullifiers), MIN_PAYMENT);
    }

    function test_Constructor_RejectsCodelessSettler() public {
        address eoa = makeAddr("notacontract3");
        vm.expectRevert("settler has no code");
        new ReviewGatewayHarness(signer, address(rep), address(id), eoa, address(nullifiers), MIN_PAYMENT);
    }

    function test_Constructor_RejectsZeroMinPayment() public {
        vm.expectRevert("minPayment is zero");
        new ReviewGatewayHarness(signer, address(rep), address(id), address(settler), address(nullifiers), 0);
    }

    // --- attestation verification ---

    function test_Verify_ValidSignature_Accepted() public view {
        gw.verify(_validAtt());
    }

    function test_Verify_WrongSigner_Rejected() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        ReviewGateway.Attestation memory a = _validAtt();
        _signWith(otherKey, a);
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    // Any changed signed field invalidates the signature.

    function test_Verify_TamperedAgentId_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.agentId = AGENT_ID + 1;
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedNullifier_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.nullifier = keccak256("different");
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedReviewer_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.reviewer = makeAddr("attacker");
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedExpiry_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.expiry = a.expiry + 1;
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedValue_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.value = a.value + 1;
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedValueDecimals_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.valueDecimals = 1;
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedFeedbackHash_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.feedbackHash = keccak256("tampered");
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedReviewType_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.reviewType = 1;
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_TamperedReceiptId_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.receiptId = keccak256("some-receipt");
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    // Freshness and non-zero fields.

    function test_Verify_Expired_Rejected() public {
        vm.warp(1_000_000);
        ReviewGateway.Attestation memory a =
            _build(AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp - 1), FREE_VALUE, 0, FREE_HASH, 0, bytes32(0));
        vm.expectRevert("attestation expired");
        gw.verify(a);
    }

    function test_Verify_ZeroReviewer_Rejected() public {
        ReviewGateway.Attestation memory a = _build(
            AGENT_ID, NULLIFIER, address(0), uint64(block.timestamp + FUTURE), FREE_VALUE, 0, FREE_HASH, 0, bytes32(0)
        );
        vm.expectRevert("zero reviewer");
        gw.verify(a);
    }

    function test_Verify_ZeroNullifier_Rejected() public {
        ReviewGateway.Attestation memory a = _build(
            AGENT_ID, bytes32(0), reviewer, uint64(block.timestamp + FUTURE), FREE_VALUE, 0, FREE_HASH, 0, bytes32(0)
        );
        vm.expectRevert("zero nullifier");
        gw.verify(a);
    }

    // Signature well-formedness.

    function test_Verify_BadSignatureLength_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        a.signature = hex"deadbeef"; // 4 bytes, not 65
        vm.expectRevert("bad signature length");
        gw.verify(a);
    }

    function test_Verify_InvalidV_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        bytes memory sig = a.signature;
        sig[64] = bytes1(uint8(26)); // invalid v
        a.signature = sig;
        vm.expectRevert("invalid signature v");
        gw.verify(a);
    }

    function test_Verify_HighS_Rejected() public {
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        bytes32 digest = gw.digestOf(a);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes32 highS = bytes32(SECP256K1N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        a.signature = abi.encodePacked(r, highS, flippedV);
        vm.expectRevert("invalid signature s");
        gw.verify(a);
    }

    // Cross-chain and cross-gateway replay protection.

    function test_Verify_DifferentChainId_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        vm.chainId(block.chainid + 1);
        vm.expectRevert("bad attestation signer");
        gw.verify(a);
    }

    function test_Verify_DifferentGateway_Rejected() public {
        ReviewGateway.Attestation memory a = _validAtt();
        ReviewGatewayHarness gw2 = new ReviewGatewayHarness(
            signer, address(rep), address(id), address(settler), address(nullifiers), MIN_PAYMENT
        );

        // Make the second gateway the active one. Without this the active-gateway
        // check fires first and the test would pass on the wrong rule, proving
        // nothing about the domain binding it exists to cover.
        settler.setReviewGateway(address(gw2));

        vm.expectRevert("bad attestation signer");
        gw2.verify(a);
    }

    // --- nullifier tracking ---

    function test_Nullifier_FirstUse_Succeeds() public {
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier recorded");
    }

    function test_Nullifier_ReuseSameAgent_Reverts() public {
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
        vm.expectRevert("nullifier used");
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
    }

    function test_Nullifier_DifferentAgent_Allowed() public {
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
        gw.consumeNullifier(AGENT_ID + 1, NULLIFIER);
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "agent1 recorded");
        assertTrue(gw.usedNullifier(AGENT_ID + 1, NULLIFIER), "agent2 recorded");
    }

    function test_Nullifier_DifferentNullifiers_SameAgent_Allowed() public {
        bytes32 n2 = keccak256("nullifier-2");
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
        gw.consumeNullifier(AGENT_ID, n2);
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "n1 recorded");
        assertTrue(gw.usedNullifier(AGENT_ID, n2), "n2 recorded");
    }

    function test_Nullifier_Zero_Rejected() public {
        vm.expectRevert("zero nullifier");
        gw.consumeNullifier(AGENT_ID, bytes32(0));
    }

    function test_Nullifier_FailedDuplicate_NoSideEffects() public {
        bytes32 n2 = keccak256("nullifier-2");
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
        vm.expectRevert("nullifier used");
        gw.consumeNullifier(AGENT_ID, NULLIFIER);
        assertFalse(gw.usedNullifier(AGENT_ID, n2), "n2 still unused");
        assertFalse(gw.usedNullifier(AGENT_ID + 1, NULLIFIER), "other agent still unused");
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "original still set");
    }

    // --- free review submission ---

    function test_Free_Success_CallsRegistryWithCorrectArgs() public {
        gw.submitFreeReview(_freeAtt(AGENT_ID, NULLIFIER, reviewer));

        assertEq(rep.callCount(), 1, "one feedback call");
        assertEq(rep.lastAgentId(), AGENT_ID, "agentId");
        assertEq(rep.lastValue(), FREE_VALUE, "value");
        assertEq(rep.lastValueDecimals(), 0, "decimals");
        assertEq(rep.lastTag1(), "quality", "tag1");
        assertEq(rep.lastTag2(), "human-verified", "tag2");
        assertEq(rep.lastEndpoint(), "", "endpoint empty");
        assertEq(rep.lastFeedbackURI(), "ipfs://free", "feedbackURI");
        assertEq(rep.lastFeedbackHash(), FREE_HASH, "feedbackHash from attestation");
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier consumed");
    }

    function test_Free_InvalidAttestation_Rejected() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        _signWith(otherKey, a);
        vm.expectRevert("bad attestation signer");
        gw.submitFreeReview(a);
        assertEq(rep.callCount(), 0, "no feedback");
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier not consumed");
    }

    function test_Free_Expired_Rejected() public {
        vm.warp(1_000_000);
        ReviewGateway.Attestation memory a =
            _build(AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp - 1), FREE_VALUE, 0, FREE_HASH, 0, bytes32(0));
        vm.expectRevert("attestation expired");
        gw.submitFreeReview(a);
    }

    function test_Free_DuplicateNullifierSameAgent_Rejected() public {
        gw.submitFreeReview(_freeAtt(AGENT_ID, NULLIFIER, reviewer));
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("nullifier used");
        gw.submitFreeReview(a);
        assertEq(rep.callCount(), 1, "only first feedback");
    }

    function test_Free_SameNullifierDifferentAgent_Accepted() public {
        gw.submitFreeReview(_freeAtt(AGENT_ID, NULLIFIER, reviewer));
        gw.submitFreeReview(_freeAtt(AGENT_ID + 1, NULLIFIER, reviewer));
        assertEq(rep.callCount(), 2, "two feedback calls");
    }

    function test_Free_OwnerSelfReview_Rejected() public {
        id.setOwner(AGENT_ID, reviewer);
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("reviewer is owner/operator");
        gw.submitFreeReview(a);
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier not consumed");
    }

    function test_Free_OperatorSelfReview_Rejected() public {
        id.setAuthorized(reviewer, AGENT_ID, true);
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("reviewer is owner/operator");
        gw.submitFreeReview(a);
    }

    function test_Free_RatingOutOfRange_Rejected() public {
        ReviewGateway.Attestation memory aLow = _build(
            AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp + FUTURE), int128(-1), 0, FREE_HASH, 0, bytes32(0)
        );
        vm.expectRevert("value out of range");
        gw.submitFreeReview(aLow);

        ReviewGateway.Attestation memory aHigh = _build(
            AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp + FUTURE), int128(101), 0, FREE_HASH, 0, bytes32(0)
        );
        vm.expectRevert("value out of range");
        gw.submitFreeReview(aHigh);
    }

    function test_Free_NonzeroDecimals_Rejected() public {
        ReviewGateway.Attestation memory a = _build(
            AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp + FUTURE), FREE_VALUE, 1, FREE_HASH, 0, bytes32(0)
        );
        vm.expectRevert("decimals must be 0");
        gw.submitFreeReview(a);
    }

    function test_Free_RejectsPaidAttestation() public {
        // reviewType 1 presented to the free path.
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("not a free review");
        gw.submitFreeReview(a);
    }

    function test_Free_RejectsNonzeroReceiptId() public {
        // reviewType 0 but a nonzero receiptId.
        ReviewGateway.Attestation memory a = _build(
            AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp + FUTURE), FREE_VALUE, 0, FREE_HASH, 0, RECEIPT_ID
        );
        vm.expectRevert("free: receiptId must be zero");
        gw.submitFreeReview(a);
    }

    function test_Free_RegistryRevert_RollsBackNullifier() public {
        rep.setRevert(true);
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("registry revert");
        gw.submitFreeReview(a);
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier rolled back");
    }

    function test_Free_RelayerSubmits_ForAttestedReviewer() public {
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.prank(relayer);
        gw.submitFreeReview(a);
        assertEq(rep.callCount(), 1, "feedback written");
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier consumed for attested reviewer");
    }

    function test_Free_InvalidAgent_HandledSafely() public {
        id.setRevertAuth(AGENT_ID, true);
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("nonexistent agent");
        gw.submitFreeReview(a);
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier not consumed");
        assertEq(rep.callCount(), 0, "no feedback");
    }

    // --- paid review submission ---

    function _setReceiptNow(uint256 amount) internal {
        settler.setReceipt(RECEIPT_ID, reviewer, AGENT_ID, amount, uint64(block.timestamp));
    }

    function test_Paid_Success_CallsRegistryWithCorrectArgs() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        gw.submitPaidReview(_paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID));

        assertEq(rep.callCount(), 1, "one feedback call");
        assertEq(rep.lastAgentId(), AGENT_ID, "agentId");
        assertEq(rep.lastValue(), PAID_VALUE, "value");
        assertEq(rep.lastValueDecimals(), 0, "decimals");
        assertEq(rep.lastTag1(), "quality", "tag1");
        assertEq(rep.lastTag2(), "receipt-verified", "tag2");
        assertEq(rep.lastEndpoint(), "", "endpoint empty");
        assertEq(rep.lastFeedbackURI(), "ipfs://paid", "feedbackURI");
        assertEq(rep.lastFeedbackHash(), PAID_HASH, "feedbackHash from attestation");
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier consumed");
        (,,,, bool spent,) = settler.receipts(RECEIPT_ID);
        assertTrue(spent, "receipt consumed");
    }

    function test_Paid_PayerMismatch_Rejected() public {
        vm.warp(365 days);
        settler.setReceipt(RECEIPT_ID, makeAddr("otherPayer"), AGENT_ID, PAID_AMOUNT, uint64(block.timestamp));
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("payer mismatch");
        gw.submitPaidReview(a);
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier not consumed");
    }

    function test_Paid_AgentMismatch_Rejected() public {
        vm.warp(365 days);
        settler.setReceipt(RECEIPT_ID, reviewer, AGENT_ID + 1, PAID_AMOUNT, uint64(block.timestamp));
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("agent mismatch");
        gw.submitPaidReview(a);
    }

    function test_Paid_UnknownReceipt_Rejected() public {
        vm.warp(365 days);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, keccak256("nope"));
        vm.expectRevert("unknown receipt");
        gw.submitPaidReview(a);
    }

    function test_Paid_AlreadyConsumedReceipt_Rejected() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        gw.submitPaidReview(_paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID));

        ReviewGateway.Attestation memory a2 = _paidAtt(AGENT_ID, keccak256("nullifier-2"), reviewer, RECEIPT_ID);
        vm.expectRevert("receipt spent");
        gw.submitPaidReview(a2);
    }

    function test_Paid_PaymentBelowMinimum_Rejected() public {
        vm.warp(365 days);
        _setReceiptNow(MIN_PAYMENT - 1);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("payment below minimum");
        gw.submitPaidReview(a);
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier not consumed");
        (,,,, bool spent,) = settler.receipts(RECEIPT_ID);
        assertFalse(spent, "receipt consumption rolled back");
    }

    function test_Paid_ReceiptTooOld_Rejected() public {
        vm.warp(365 days);
        settler.setReceipt(RECEIPT_ID, reviewer, AGENT_ID, PAID_AMOUNT, uint64(block.timestamp - 31 days));
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("review window passed");
        gw.submitPaidReview(a);
        (,,,, bool spent,) = settler.receipts(RECEIPT_ID);
        assertFalse(spent, "receipt consumption rolled back");
    }

    function test_Paid_ReceiptAtBoundary_Accepted() public {
        vm.warp(365 days);
        settler.setReceipt(RECEIPT_ID, reviewer, AGENT_ID, PAID_AMOUNT, uint64(block.timestamp - gw.REVIEW_WINDOW()));
        gw.submitPaidReview(_paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID));
        assertEq(rep.callCount(), 1, "accepted at boundary");
    }

    function test_Paid_SharedNullifierWithFree_Rejected() public {
        vm.warp(365 days);
        gw.submitFreeReview(_freeAtt(AGENT_ID, NULLIFIER, reviewer));

        _setReceiptNow(PAID_AMOUNT);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("nullifier used");
        gw.submitPaidReview(a);
    }

    function test_Paid_OwnerSelfReview_Rejected() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        id.setOwner(AGENT_ID, reviewer);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("reviewer is owner/operator");
        gw.submitPaidReview(a);
    }

    function test_Paid_InvalidAttestation_Rejected() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        (, uint256 otherKey) = makeAddrAndKey("other");
        _signWith(otherKey, a);
        vm.expectRevert("bad attestation signer");
        gw.submitPaidReview(a);
        (,,,, bool spent,) = settler.receipts(RECEIPT_ID);
        assertFalse(spent, "receipt not consumed");
    }

    function test_Paid_RejectsFreeAttestation() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        // reviewType 0 presented to the paid path.
        ReviewGateway.Attestation memory a = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("not a paid review");
        gw.submitPaidReview(a);
    }

    function test_Paid_RejectsZeroReceiptId() public {
        // reviewType 1 but zero receiptId.
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, bytes32(0));
        vm.expectRevert("paid: receiptId required");
        gw.submitPaidReview(a);
    }

    function test_Paid_InvalidRatingAndDecimals_Rejected() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);

        ReviewGateway.Attestation memory a1 = _build(
            AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp + FUTURE), int128(101), 0, PAID_HASH, 1, RECEIPT_ID
        );
        vm.expectRevert("value out of range");
        gw.submitPaidReview(a1);

        ReviewGateway.Attestation memory a2 = _build(
            AGENT_ID, NULLIFIER, reviewer, uint64(block.timestamp + FUTURE), PAID_VALUE, 1, PAID_HASH, 1, RECEIPT_ID
        );
        vm.expectRevert("decimals must be 0");
        gw.submitPaidReview(a2);
    }

    function test_Paid_RegistryRevert_RollsBackReceiptAndNullifier() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        rep.setRevert(true);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("registry revert");
        gw.submitPaidReview(a);
        assertFalse(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier rolled back");
        (,,,, bool spent,) = settler.receipts(RECEIPT_ID);
        assertFalse(spent, "receipt consumption rolled back");
    }

    function test_Paid_RelayerSubmits_ForAttestedReviewer() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        ReviewGateway.Attestation memory a = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.prank(relayer);
        gw.submitPaidReview(a);
        assertEq(rep.callCount(), 1, "feedback written");
        assertTrue(gw.usedNullifier(AGENT_ID, NULLIFIER), "nullifier consumed for attested reviewer");
    }

    // --- cross-path replay protection ---

    /// @dev A signature intended for the free path cannot be replayed through the
    ///      paid path, and vice versa: reviewType is signed, so the mismatched
    ///      path check reverts (and tampering reviewType breaks the signature).
    function test_CrossPathReplay_FreeSigThroughPaid_Rejected() public {
        vm.warp(365 days);
        _setReceiptNow(PAID_AMOUNT);
        ReviewGateway.Attestation memory freeAtt = _freeAtt(AGENT_ID, NULLIFIER, reviewer);
        vm.expectRevert("not a paid review");
        gw.submitPaidReview(freeAtt);

        // Flipping reviewType to 1 to pass the path check breaks the signature.
        freeAtt.reviewType = 1;
        freeAtt.receiptId = RECEIPT_ID;
        vm.expectRevert("bad attestation signer");
        gw.submitPaidReview(freeAtt);
    }

    function test_CrossPathReplay_PaidSigThroughFree_Rejected() public {
        ReviewGateway.Attestation memory paidAtt = _paidAtt(AGENT_ID, NULLIFIER, reviewer, RECEIPT_ID);
        vm.expectRevert("not a free review");
        gw.submitFreeReview(paidAtt);

        // Flipping reviewType to 0 and clearing receiptId breaks the signature.
        paidAtt.reviewType = 0;
        paidAtt.receiptId = bytes32(0);
        vm.expectRevert("bad attestation signer");
        gw.submitFreeReview(paidAtt);
    }
}
