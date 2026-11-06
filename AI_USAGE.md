# AI usage disclosure

This file states how AI tools were used on Receipts. It separates what is **confirmed**, what the repository itself **evidences**, and what is **not known** to the author of this file. It does not contain prompts, because none are recorded in this repository and none are invented here.

## Tools

The project owner confirmed that **ChatGPT and Claude were the only AI tools used.** No other AI assistant, code completion tool or model is claimed.

| Tool | Where it is evidenced | Detail |
|---|---|---|
| **Claude** (Anthropic), via **Claude Code** | Git history and the integration work | Three commits carry the trailer `Co-Authored-By: Claude Sonnet 5.5`: `c3e6099` (reputation tiers), `ea21bf0` (wallet-verified review backend) and `9b04b36` (web multi-verification review UX). The coordination, audits, test runs and documentation described below were produced by Claude Code sessions. |
| **ChatGPT** (OpenAI) | Owner confirmation only | The repository contains no trace of ChatGPT use. What it was used for is **not recorded here**. See "To be completed by the authors". |

## What is evidenced about Claude's role

These statements come from the git history, from the working sessions that produced the integration work, and from the files themselves.

1. **Feature implementation by parallel Claude Code sessions.** Work after the baseline commit `7d1827e` was split into three parallel worktrees and branches, each with one scope:
   - reputation engine, retrieval and routes (`feature/reputation-tiers`, merged as `c3e6099`);
   - wallet-verified review backend (`feature/wallet-verification`, merged as `ea21bf0`);
   - frontend (`feature/review-ux`, merged as `9b04b36`).

   The three commits above carry the Claude co-author trailer. The scope split and merge order were set by the project owner, who also performed the merges.
2. **Integration coordination and QA.** A Claude Code session acting as "Agent 4" produced `COORDINATION.md`: shared identifiers, API schemas, file ownership, invariants, the security-risk list, a required-test list and the audits of each branch. It ran the test suites and typechecks (results in `README.md`), made read-only checks of the deployed Sepolia contracts, and fetched ETHGlobal's published ENS and Arkiv prize pages to check requirements. It did not edit other agents' implementation files and did not commit, merge, push, deploy or send transactions.
3. **Documentation.** `README.md`, `AI_USAGE.md`, `DEMO.md` and `docs/specs/` were drafted by that same Claude Code session from the source code, tests, `COORDINATION.md` and git history.
4. **Deployment of the merged `integration` branch (2026-11-06).** A Claude Code session running **Claude Opus 5** performed the deployment to the Cloudflare-tunnelled stack: it ran the server, web and contract suites; built the API image `local/receipts-api:integration-a96e4ed-20261106`; took a `pg_dump` backup; restored that backup into a throwaway database and tested the v1→v2 schema upgrade and an old-image rollback against it; changed `IMAGE_TAG` in `.env.prod`; recreated only the API container; and verified the result over HTTP. It did not deploy contracts, send transactions, submit reviews, enable wallet reviews, or change DNS. The model identity here is stated from the session itself, not from a commit trailer.
5. **Arkiv integration (2026-11-06, evening).** A Claude Code session running **Claude Opus 5.5** worked to the project owner's written brief. That brief set the target prize, the entity design, what must stay off Arkiv, and that no transaction be sent without approval of the exact operation. The session:
   - investigated the Arkiv prize rules and SDK;
   - verified `@arkiv-network/sdk` 1.0.1 against its published source;
   - wrote `server/src/arkiv/`, `server/test/arkiv.test.ts`, `web/src/lib/arkiv.ts`, `web/src/lib/arkiv.test.ts` and `web/src/components/ArkivRecord.tsx`, and the panel's placement on the agent page;
   - wrote the `arkiv/` documents and the Arkiv parts of `README.md`, `DEMO.md`, `docs/specs/` and the `.env.example` files.

   It ran read-only queries against Rabdi and Sepolia, including gas estimates whose send step is blocked. It did not create a wallet, send a transaction or write an Arkiv entity.
6. **The documents in `docs/specs/` are retrospective, not prior specifications.** They describe what the code does and why, as read from the code. They were **not** written first and then implemented from. If the authors used earlier specifications or prompts (for example in ChatGPT or Claude conversations), those are not in this repository and should be added, see below.

## What the human authors decided (evidenced in the integration sessions)

Only decisions visible in the working sessions are listed. This is not a complete account of human contribution.

- Assigned the scope of each agent and the integration order (reputation, then wallet backend, then frontend, then QA).
- Required that no contract be deployed, no transaction sent, no branch pushed and no secret or deployment configuration changed during the integration work.
- Kept `WALLET_REVIEWS_ENABLED` off.
- Performed the merges into `integration` and accepted the post-merge audit.
- Asked that ENS and Arkiv not be claimed while unimplemented, and that live World ID verification not be claimed as tested. Later approved building the Arkiv integration, under the constraints in item 5 above.
- Confirmed the AI tools used (ChatGPT and Claude).

## What AI did not do

- It did not deploy contracts or send blockchain transactions. The Sepolia deployment records in `broadcast/` are not shown here to have been produced by any AI session.
- It did not test live World ID verification.
- It did not independently audit the contracts. The security review in `docs/specs/THREAT_MODEL.md` is a reading of the code and tests by an AI session, not an audit.

## To be completed by the authors

The author of this file cannot know the following and has not guessed. Fill in before submission, or state "not applicable".

> **OWNER TO COMPLETE: how ChatGPT was used.** Which parts (planning, research, code, review, text), and roughly when.
>
> **OWNER TO COMPLETE: how the baseline code was produced.** The 29 commits up to `7d1827e` (contracts, tests, server, web, infrastructure) were all recorded between 05:06 and 05:10 IST on 2026-11-06. The history does not show who or what wrote that code or when. State plainly which tools were used for it and how the commit history was created, so that readers do not have to infer it.
>
> **OWNER TO COMPLETE: prompts and specification files.** ETHGlobal asks that spec files and prompts used in AI-assisted workflows be in the repository. None are recorded here. Add any that exist (for example, the project plan and the instructions given to the AI sessions) under `docs/specs/`.
>
> **OWNER TO COMPLETE: human review.** Which parts of the AI-written code a human read, tested or changed before merge.

## Known gaps in this disclosure

- The Claude model identity is taken from the commit trailers (`Claude Sonnet 5.5`). Other sessions may have used a different model; this is not recorded.
- The three feature branches were developed as uncommitted working trees and merged as one commit each. Their intermediate history does not exist.
