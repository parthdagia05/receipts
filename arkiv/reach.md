# Reach

## Who is it for, and would they use it?

Receipts gives ERC-8004 agents a reputation score that is hard to inflate. A review counts only if it is bound to a World ID human, at most one per human per agent, optionally weighted by a settled USDC payment. The score is a weighted median, which an attacker holding under half the weight cannot move outside the honest range. The registry's own summary is a plain mean, and the repository's attack test moves it from 50 to 77 with six synthetic reviewers.

The Arkiv record is for the people who *consume* that score, not the people who write reviews:

- **Agent directories and marketplaces** that list ERC-8004 agents and want a sybil-resistant signal next to each one. One query returns every agent above a threshold.
- **Agents choosing a counterparty.** An agent about to pay another agent can query its standing directly, with no account, no API key and no dependence on Receipts staying online.
- **Wallets and explorers** that show an agent's reviews with the text, checkable against the on-chain hash.
- **Agents themselves**, which can extend their own review entities to keep their history public.

## Can they try it today?

Yes, without installing anything:

- **The app:** each agent page has a **Public record on Arkiv** card that reads Rabdi directly in the browser.
- **The command line:** the README's [Arkiv section](../README.md#arkiv) has a curl query that runs against the public Rabdi RPC with no key.
- **In code:** `@arkiv-network/sdk` with the schemas in [`web/src/lib/arkiv.ts`](../web/src/lib/arkiv.ts). That file is self-contained and can be copied into another app.

Numbers so far: 4 entities written in 1 transaction, covering 2 agents (11292 and 11294): 2 reviews mirrored with their text, and 2 reputation snapshots. Both reviews are Simulator tests (staging World ID), not real people, and both agents are below the five-human threshold. Details and links: the README's [Arkiv section](../README.md#arkiv).

## Will you keep building it after Mumbai?

`<team to answer>`. The honest state of Receipts today:
- It is a hackathon prototype.
- The contracts are deployed on Sepolia, and the reputation API is live.
- Two reviews have been written on-chain through the gateway, both test runs verified with the World ID Simulator (staging), not real credentials. Agents 11292 and 11294.
- Live World ID verification has not been tested end to end (see the README status table).

The Arkiv part is built to keep running unattended: one idempotent command, safe to put on a schedule.
