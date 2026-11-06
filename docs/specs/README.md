# Specifications and decision records

These documents describe Receipts as implemented on the merged `integration` branch (commit `a96e4ed`).

**They are retrospective.** They were written after the implementation, from the source code, the tests, `COORDINATION.md` and the git history. They are not specifications that were written first and then built from. See `AI_USAGE.md`.

| Document | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, flows, data stores, deployment state |
| [REVIEW_TYPES_AND_LABELS.md](REVIEW_TYPES_AND_LABELS.md) | The three review types, their identifiers and the labels shown to users |
| [API.md](API.md) | Record Server HTTP endpoints as implemented |
| [REPUTATION_SPEC.md](REPUTATION_SPEC.md) | Scoring rules, thresholds, tiers, evidence manifest |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Assets, trust assumptions, risks, mitigations and non-guarantees |
| [DECISIONS.md](DECISIONS.md) | Architecture decision records |

Where a statement depends on something that was not verified, it says so. In particular: live World ID verification was never tested, wallet-verified reviews are not on-chain, ENS is not implemented, and the Arkiv integration ([arkiv/](../../arkiv/)) is implemented and tested but has not published any entity yet.
