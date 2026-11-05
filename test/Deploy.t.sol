// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";
import {MockIdentityRegistry, MockUSDC} from "./ReceiptSettler.t.sol";
import {MockReputationRegistry} from "./ReviewGateway.t.sol";

/// @title DeployTest
/// @notice The deployment sequence, run in-process against the real contracts.
/// @dev A deployment is the one procedure with no test coverage in production
///      and no second chance: a gateway wired to the wrong registry is
///      discovered after it is live. This runs `Deploy.deploy` and
///      `Deploy.verify` exactly as the script does.
contract DeployTest is Test {
    Deploy internal script;
    MockUSDC internal usdc;
    MockIdentityRegistry internal identity;
    MockReputationRegistry internal reputation;

    address internal recordServerSigner = makeAddr("recordServer");
    uint256 internal constant MIN_PAYMENT = 1_000_000;

    function setUp() public {
        script = new Deploy();
        usdc = new MockUSDC();
        identity = new MockIdentityRegistry();
        reputation = new MockReputationRegistry();
    }

    function _config() internal view returns (Deploy.Config memory c) {
        c.usdc = address(usdc);
        c.identityRegistry = address(identity);
        c.reputationRegistry = address(reputation);
        c.recordServerSigner = recordServerSigner;
        c.minPayment = MIN_PAYMENT;
    }

    function test_Deploy_ProducesAFullyWiredDeployment() public {
        Deploy.Config memory c = _config();
        Deploy.Deployment memory d = script.deploy(c);

        // The script's own assertions must pass on its own output.
        script.verify(d, c);
    }

    function test_Deploy_NamesTheGatewayActive() public {
        Deploy.Deployment memory d = script.deploy(_config());

        assertEq(d.settler.reviewGateway(), address(d.gateway), "pointer set");
    }

    function test_Deploy_UsesOneSharedRegistry() public {
        Deploy.Deployment memory d = script.deploy(_config());

        assertEq(address(d.gateway.nullifierRegistry()), address(d.nullifiers), "gateway -> registry");
        assertEq(address(d.nullifiers.receiptSettler()), address(d.settler), "registry -> settler");
    }

    function test_Deploy_CarriesTheConfiguredValues() public {
        Deploy.Config memory c = _config();
        Deploy.Deployment memory d = script.deploy(c);

        assertEq(d.gateway.recordServerSigner(), recordServerSigner, "signer");
        assertEq(address(d.gateway.reputationRegistry()), c.reputationRegistry, "reputation");
        assertEq(address(d.gateway.identityRegistry()), c.identityRegistry, "identity");
        assertEq(address(d.settler.usdc()), c.usdc, "usdc");
        assertEq(d.gateway.minPayment(), MIN_PAYMENT, "gateway minPayment");
        assertEq(d.settler.minPayment(), MIN_PAYMENT, "settler minPayment");
    }

    /// @notice The order is forced by the constructors, not a convention.
    /// @dev The registry cannot come first: its constructor requires the settler
    ///      to already have code. This is why the proposed "registry, then
    ///      settler" ordering is not implementable.
    function test_Deploy_RegistryCannotBeDeployedBeforeTheSettler() public {
        address notYetDeployed = makeAddr("futureSettler");

        vm.expectRevert("settler has no code");
        new NullifierRegistry(notYetDeployed);
    }

    /// @dev And the gateway cannot come before the registry, for the same reason.
    function test_Deploy_GatewayCannotBeDeployedBeforeTheRegistry() public {
        ReceiptSettler settler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);

        vm.expectRevert("registry has no code");
        new ReviewGateway(
            recordServerSigner,
            address(reputation),
            address(identity),
            address(settler),
            makeAddr("futureRegistry"),
            MIN_PAYMENT
        );
    }

    function test_Deploy_RejectsARegistryFromAnotherDeployment() public {
        ReceiptSettler settlerA = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        ReceiptSettler settlerB = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        NullifierRegistry foreign = new NullifierRegistry(address(settlerB));

        vm.expectRevert("registry settler mismatch");
        new ReviewGateway(
            recordServerSigner, address(reputation), address(identity), address(settlerA), address(foreign), MIN_PAYMENT
        );
    }

    /// @notice An unfinished deployment is inert, not subtly broken.
    function test_Deploy_FailsClosedBeforeStepFour() public {
        ReceiptSettler settler = new ReceiptSettler(address(usdc), address(identity), MIN_PAYMENT);
        NullifierRegistry nullifiers = new NullifierRegistry(address(settler));
        ReviewGateway gateway = new ReviewGateway(
            recordServerSigner,
            address(reputation),
            address(identity),
            address(settler),
            address(nullifiers),
            MIN_PAYMENT
        );

        // Step 4 not yet run: nothing is active, so nothing can be reviewed.
        assertEq(settler.reviewGateway(), address(0), "no active gateway");

        ReviewGateway.Attestation memory a;
        a.agentId = 1;
        a.nullifier = keccak256("n");
        a.reviewer = makeAddr("reviewer");
        a.expiry = type(uint64).max;
        a.feedbackURI = "https://receipts.test/reviews/0x0";
        a.signature = new bytes(65);

        vm.expectRevert("gateway not active");
        gateway.submitFreeReview(a);
    }

    /// @dev `verify` must actually reject a mis-wired deployment, or it is
    ///      decoration. Hand-build one the script could never produce.
    function test_Verify_RejectsAMisWiredDeployment() public {
        Deploy.Config memory c = _config();
        Deploy.Deployment memory good = script.deploy(c);

        // A second, fully valid deployment; splicing one of its parts in is
        // exactly the mistake a manual deployment makes.
        Deploy.Deployment memory other = script.deploy(c);

        Deploy.Deployment memory spliced =
            Deploy.Deployment({settler: good.settler, nullifiers: other.nullifiers, gateway: good.gateway});

        vm.expectRevert("gateway uses another registry");
        script.verify(spliced, c);
    }

    function test_Verify_RejectsAnUnexpectedSigner() public {
        Deploy.Config memory c = _config();
        Deploy.Deployment memory d = script.deploy(c);

        c.recordServerSigner = makeAddr("someoneElse");

        vm.expectRevert("unexpected record server signer");
        script.verify(d, c);
    }

    /// @notice A Mainnet address on a testnet has no code, and is refused.
    function test_Verify_RejectsACodelessRegistry() public {
        Deploy.Config memory c = _config();
        c.reputationRegistry = makeAddr("mainnetOnlyAddress");

        // The gateway constructor refuses it first, which is the real guard.
        vm.expectRevert("reputation has no code");
        script.deploy(c);
    }
}
