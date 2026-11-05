// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ReceiptSettler} from "../src/ReceiptSettler.sol";
import {NullifierRegistry} from "../src/NullifierRegistry.sol";
import {ReviewGateway} from "../src/ReviewGateway.sol";

/// @title Deploy
/// @notice Deploys the three Receipts contracts and wires them together.
/// @dev The order is forced by the constructors, not chosen:
///
///        ReceiptSettler   — depends on nothing of ours
///        NullifierRegistry(settler)
///                         — requires the settler to already have code
///        ReviewGateway(..., settler, registry, ...)
///                         — requires both, and checks the registry was built
///                           against this same settler
///        settler.setReviewGateway(gateway)
///                         — reads the gateway back and checks it points here
///
///      So the registry cannot be deployed first, and the gateway cannot be
///      deployed before the registry. Each step validates the previous one, and
///      a half-finished deployment fails closed: until step 4 lands the pointer
///      is zero, and every gateway refuses both review paths.
///
///      One registry per deployment, never two. It is the shared
///      one-human-one-review ledger that outlives gateway replacement; a second
///      one would reset that history. Replacing a gateway later reuses the
///      settler and registry deployed here — see `setReviewGateway`.
///
///      No key material is read by this script. The broadcasting account comes
///      from the forge CLI (`--private-key`, `--account`, `--ledger`), so a
///      secret never reaches a file or an environment variable this reads.
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL" --broadcast --account <keystore>
contract Deploy is Script {
    /// @notice Addresses this deployment is wired to, read from the environment.
    /// @dev Required with no defaults, deliberately. Defaulting would let a
    ///      Mainnet address be used on a testnet silently, and these are exactly
    ///      the values that are unrecoverable once a gateway is live.
    struct Config {
        address usdc;
        address identityRegistry;
        address reputationRegistry;
        address recordServerSigner;
        uint256 minPayment;
    }

    /// @notice What was deployed, returned so tests and callers can assert on it.
    struct Deployment {
        ReceiptSettler settler;
        NullifierRegistry nullifiers;
        ReviewGateway gateway;
    }

    function readConfig() public view returns (Config memory c) {
        c.usdc = vm.envAddress("USDC_ADDRESS");
        c.identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        c.reputationRegistry = vm.envAddress("REPUTATION_REGISTRY");
        c.recordServerSigner = vm.envAddress("RECORD_SERVER_SIGNER");
        c.minPayment = vm.envUint("MIN_PAYMENT");
    }

    function run() external returns (Deployment memory) {
        Config memory c = readConfig();

        vm.startBroadcast();
        Deployment memory d = deploy(c);
        vm.stopBroadcast();

        verify(d, c);
        log(d, c);
        return d;
    }

    /// @notice The deployment sequence, without broadcasting.
    /// @dev Separated so a test can run the identical sequence in-process.
    function deploy(Config memory c) public returns (Deployment memory d) {
        // 1. The settler. Everything else is built against it, and it is the
        //    single source of truth for which gateway is active.
        d.settler = new ReceiptSettler(c.usdc, c.identityRegistry, c.minPayment);

        // 2. The shared nullifier ledger. Takes its write authority from the
        //    settler's active-gateway pointer, so it needs the settler first.
        d.nullifiers = new NullifierRegistry(address(d.settler));

        // 3. The gateway. Its constructor rejects a registry built against a
        //    different settler, so this is where a mismatched pair is caught.
        d.gateway = new ReviewGateway(
            c.recordServerSigner,
            c.reputationRegistry,
            c.identityRegistry,
            address(d.settler),
            address(d.nullifiers),
            c.minPayment
        );

        // 4. Name the gateway active. The settler reads the candidate back and
        //    requires it to point here, so a wrong address cannot be installed.
        d.settler.setReviewGateway(address(d.gateway));
    }

    /// @notice Assert the deployment is wired as intended, before anyone uses it.
    /// @dev Cheap insurance on the values that become immutable or expensive to
    ///      change. Reverts the script rather than leaving a subtly wrong
    ///      deployment for the Record Server to discover at startup.
    function verify(Deployment memory d, Config memory c) public view {
        // 5. Gateway and settler point at each other.
        require(d.settler.reviewGateway() == address(d.gateway), "settler does not name the gateway");
        require(address(d.gateway.receiptSettler()) == address(d.settler), "gateway names another settler");

        // 6. Both use the intended, shared registry.
        require(address(d.gateway.nullifierRegistry()) == address(d.nullifiers), "gateway uses another registry");
        require(address(d.nullifiers.receiptSettler()) == address(d.settler), "registry bound to another settler");

        // 7. The Record Server signer the attestations will have to match.
        require(d.gateway.recordServerSigner() == c.recordServerSigner, "unexpected record server signer");

        // 8. External registries and economics, as configured.
        require(address(d.gateway.reputationRegistry()) == c.reputationRegistry, "unexpected reputation registry");
        require(address(d.gateway.identityRegistry()) == c.identityRegistry, "unexpected identity registry");
        require(address(d.settler.usdc()) == c.usdc, "unexpected USDC");
        require(d.gateway.minPayment() == c.minPayment, "gateway minPayment");
        require(d.settler.minPayment() == c.minPayment, "settler minPayment");

        // The registries must be live on *this* chain. A Mainnet address used
        // on a testnet is codeless there, which the constructors already
        // reject — this restates it where the failure is readable.
        require(c.reputationRegistry.code.length > 0, "reputation registry has no code on this chain");
        require(c.identityRegistry.code.length > 0, "identity registry has no code on this chain");
        require(c.usdc.code.length > 0, "USDC has no code on this chain");
    }

    function log(Deployment memory d, Config memory c) internal view {
        console.log("chain id            ", block.chainid);
        console.log("ReceiptSettler      ", address(d.settler));
        console.log("NullifierRegistry   ", address(d.nullifiers));
        console.log("ReviewGateway       ", address(d.gateway));
        console.log("recordServerSigner  ", c.recordServerSigner);
        console.log("");
        console.log("Set in server/.env:");
        console.log("  REVIEW_GATEWAY_ADDRESS=", address(d.gateway));
        console.log("  CHAIN_ID=", block.chainid);
    }
}
