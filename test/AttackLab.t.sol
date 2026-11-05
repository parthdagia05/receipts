// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {IReputationRegistry} from "../src/interfaces/IReputationRegistry.sol";

/// @title AttackLab baseline
/// @notice Read-only test establishing the honest feedback baseline for the
///         live ERC-8004 Reputation Registry before any manipulation is shown.
///         It forks Ethereum Mainnet at a pinned block so the numbers are
///         reproducible, and asserts the five `quality` reviews of Agent 1.
contract AttackLabTest is Test {
    /// @dev Ethereum Mainnet Reputation Registry (ERC-1967 proxy).
    address internal constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    /// @dev Pinned mainnet block where Agent 1's six baseline entries exist.
    uint256 internal constant FORK_BLOCK = 26330000;

    /// @dev The agent under test.
    uint256 internal constant AGENT_ID = 1;

    IReputationRegistry internal registry;

    bool internal forkEnabled;

    /// @dev Skip the body (reported as skipped) when fork tests are not enabled.
    ///      Per test rather than in setUp(), so the suite always reports its two
    ///      tests and a collapsed count stays legible as the anomaly it is.
    modifier onlyFork() {
        if (!forkEnabled) {
            vm.skip(true, "set RUN_FORK_TESTS=true to run fork tests");
            return;
        }
        _;
    }

    function setUp() public {
        // Fork tests are opt-in. They need a live archive RPC, and a suite whose
        // result depends on a third-party endpoint is not a suite you can read a
        // red build from — so an ordinary `forge test` skips them entirely and
        // never looks at MAINNET_RPC_URL.
        forkEnabled = vm.envOr("RUN_FORK_TESTS", false);
        if (!forkEnabled) {
            return;
        }

        // Fork mainnet at the pinned block. The RPC URL comes from the
        // environment (never hardcoded); the fork is read-only and local.
        string memory rpcUrl = vm.envString("MAINNET_RPC_URL");
        vm.createSelectFork(rpcUrl, FORK_BLOCK);
        assertEq(block.number, FORK_BLOCK, "fork must sit on the pinned block");

        registry = IReputationRegistry(REPUTATION_REGISTRY);
    }

    /// @notice The honest baseline: exactly five `quality` reviews, all value 50.
    function test_QualityBaseline_Agent1() public onlyFork {
        // Read every non-revoked `quality`-tagged entry for the agent.
        // An empty client array means "all clients" (per the interface contract).
        address[] memory emptyClients = new address[](0);
        (
            address[] memory clients,
            uint64[] memory feedbackIndexes,
            int128[] memory values,
            uint8[] memory valueDecimals,
            string[] memory tag1s,
            string[] memory tag2s,
            bool[] memory revokedStatuses
        ) = registry.readAllFeedback(AGENT_ID, emptyClients, "quality", "", false);

        // Exactly five quality entries are expected at the pinned block.
        assertEq(clients.length, 5, "expected 5 quality entries");

        // Every parallel array must share that length.
        assertEq(feedbackIndexes.length, 5, "feedbackIndexes length");
        assertEq(values.length, 5, "values length");
        assertEq(valueDecimals.length, 5, "valueDecimals length");
        assertEq(tag1s.length, 5, "tag1s length");
        assertEq(tag2s.length, 5, "tag2s length");
        assertEq(revokedStatuses.length, 5, "revokedStatuses length");

        // Each entry: value 50, decimals 0, not revoked, tagged "quality".
        for (uint256 i = 0; i < values.length; i++) {
            assertEq(values[i], int128(50), "value must be 50");
            assertEq(valueDecimals[i], uint8(0), "decimals must be 0");
            assertEq(revokedStatuses[i], false, "entry must not be revoked");
            assertEq(tag1s[i], "quality", "tag1 must be quality");
        }

        // The registry's own mean over the quality metric must agree.
        // getSummary requires a non-empty client list, so pass the full set
        // of authors from getClients and filter to tag1 = "quality".
        address[] memory allClients = registry.getClients(AGENT_ID);
        (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) =
            registry.getSummary(AGENT_ID, allClients, "quality", "");

        assertEq(count, uint64(5), "summary count must be 5");
        assertEq(summaryValue, int128(50), "summary mean must be 50");
        assertEq(summaryValueDecimals, uint8(0), "summary decimals must be 0");
    }

    /// @notice Six fake reviewers drag the naive mean from 50 to 77.
    /// @dev Demonstrates the registry's zero breakdown point: unauthenticated,
    ///      unlimited feedback plus a plain mean means a handful of fresh
    ///      addresses move the score at will. All writes stay on the local fork.
    function test_MeanManipulation_SixAttackers() public onlyFork {
        // Initial quality summary: getSummary needs a non-empty client list,
        // so read the current authors and filter to tag1 = "quality".
        address[] memory initialClients = registry.getClients(AGENT_ID);
        (uint64 initialCount, int128 initialMean, uint8 initialDecimals) =
            registry.getSummary(AGENT_ID, initialClients, "quality", "");
        assertEq(initialCount, uint64(5), "initial count must be 5");
        assertEq(initialMean, int128(50), "initial mean must be 50");
        assertEq(initialDecimals, uint8(0), "initial decimals must be 0");

        // Six distinct attacker addresses. makeAddr derives a deterministic,
        // labelled address from a string seed; none is the agent's owner/operator,
        // so the registry's self-feedback check does not block them.
        uint256 attackerCount = 6;
        address[] memory attackers = new address[](attackerCount);
        for (uint256 i = 0; i < attackerCount; i++) {
            attackers[i] = makeAddr(string.concat("attacker-", vm.toString(i)));
        }

        // The six addresses must be pairwise distinct, otherwise they would
        // collapse into fewer clients and the attack would be weaker than claimed.
        for (uint256 i = 0; i < attackerCount; i++) {
            for (uint256 j = i + 1; j < attackerCount; j++) {
                assertTrue(attackers[i] != attackers[j], "attackers must be pairwise distinct");
            }
        }

        for (uint256 i = 0; i < attackerCount; i++) {
            // vm.prank sets msg.sender for exactly the next call, so each entry
            // is authored by a different address — i.e. a distinct "client".
            vm.prank(attackers[i]);
            registry.giveFeedback(AGENT_ID, int128(100), uint8(0), "quality", "", "", "", bytes32(0));
        }

        // Re-fetch the client list: getClients is append-only and each attacker
        // became a NEW client on its first giveFeedback. The list read before the
        // attack (initialClients) does not contain them, so reusing it would miss
        // the six new authors and understate the manipulation.
        address[] memory updatedClients = registry.getClients(AGENT_ID);
        (uint64 updatedCount, int128 updatedMean, uint8 updatedDecimals) =
            registry.getSummary(AGENT_ID, updatedClients, "quality", "");

        // 5 entries of 50 + 6 of 100 = 850 over 11 -> floor(850/11) = 77.
        assertEq(updatedCount, uint64(11), "updated count must be 11");
        assertEq(updatedMean, int128(77), "manipulated mean must be 77");
        assertEq(updatedDecimals, uint8(0), "updated decimals must be 0");

        // The attack added exactly six brand-new authors, so the full client
        // list must have grown by exactly six over the pre-attack list.
        assertEq(updatedClients.length, initialClients.length + attackerCount, "client list must grow by six");

        // Every attacker must now appear as a client for the agent.
        for (uint256 i = 0; i < attackerCount; i++) {
            bool found = false;
            for (uint256 k = 0; k < updatedClients.length; k++) {
                if (updatedClients[k] == attackers[i]) {
                    found = true;
                    break;
                }
            }
            assertTrue(found, "attacker must appear in updated client list");
        }
    }
}
