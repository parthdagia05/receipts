# World ID integration debrief

Feedback for the World team, as the Best Use of IDKit prize asks: time to first success, friction, what was missing, and the one improvement with the greatest impact.

What we integrated: `@worldcoin/idkit-core` 4.6.0, World ID 4.0, credential preset `proofOfHuman`, backend-signed `rp_context`, one dynamic action per agent (`review-agent-<agentId>`), verification against `POST /api/v4/verify/{rp_id}`, nullifiers stored with `UNIQUE(nullifier, action)` and spent on-chain. Code: [`server/src/worldid/`](../server/src/worldid/) and [`web/src/lib/worldId.ts`](../web/src/lib/worldId.ts).

## Why Proof of Human, and nothing more

The trust moment is writing a review of an AI agent into a shared on-chain registry. What has to be true is that one person cannot vote twice on the same agent, no matter how many wallets they control. That needs exactly two things: a proof that a unique human is present, and a nullifier scoped to (person, agent). `proofOfHuman` provides both. We do not need a legal identity, a document, or a face: Passport/NFC or Selfie Check would collect more assurance than the action requires and raise the barrier for honest reviewers. Payment weighting is handled separately by our own receipts, so the credential only has to answer "one human, once".

## Time to first success

From the git history, all on Nov 6:

- 04:29 to 04:49: the four server modules (action scoping, proof handling, rp_context signing, verify client).
- 07:47: staging environment support.
- 09:43 to 10:35: the World ID and review server test suites in place and passing.
- 15:58: the browser IDKit client. 18:38: the review wizard around it.

So roughly five hours from first commit to a passing server-side verify path, and about fourteen hours to the first full browser verification with the Simulator against our staging RP. The first verified reviews reached Sepolia through the gateway before the morning of Nov 7.

## Friction we hit

1. **The signed request's wire format is undocumented.** `signRequest()` returns `sig`, `createdAt`, `expiresAt`, but IDKit expects the context as `signature`, `created_at`, `expires_at`. We found the mapping by trial and hand-roll it in [`signing.ts`](../server/src/worldid/signing.ts). Reformatting the timestamps risks breaking the signature, which the docs also do not warn about.
2. **A 200 from the verify API does not mean your proof verified.** The endpoint returns 200 when at least one proof in the request verified, and every field of each `results` entry is optional in the published schema. A server must find the entry whose `identifier` matches and whose `success` is exactly `true`, or it will accept the wrong credential ([`verifyClient.ts`](../server/src/worldid/verifyClient.ts)). This is easy to get wrong and the reference does not call it out.
3. **Whether actions need pre-registration is unclear.** World ID 4.0 derives the nullifier from (identity, rp_id, action), so our dynamic per-agent actions need no Portal entry, and the Portal creates the action record on first verification. We confirmed this by testing, not from the docs, and we still do not know how thousands of dynamic actions interact with the Portal's `max_verifications` default.
4. **Environment scoping fails silently.** An action exercised in staging does not thereby exist in production, and the mismatch presents as a frontend that silently does nothing rather than an error. We also had to reject proofs whose environment differs from the configured one ourselves, because a staging proof is cheap to obtain.
5. **Error bodies can quote the request.** The verify API's error messages can echo proof elements and the nullifier, so a careful server cannot relay them to clients. We classify failures into three kinds and drop the message.

## Missing capability or documentation

- A documented wire schema for the signed `rp_context` (or the SDK exporting the wire type directly).
- A verify API reference that states the 200 semantics and the optionality of `results` fields plainly.
- Guidance on dynamic, high-cardinality actions: scale, `max_verifications`, environment behavior.

## The one improvement with the greatest impact

**Let staging work with the real World App on fake credentials.** Staging only accepts the Simulator, so the only way to rehearse the production user flow is to go live on a production RP. This is the single reason every review in our demo is labelled "Staging World ID, Simulator test" instead of a production verification: we could prove the whole pipeline, but not with the app a real user would hold. A staging mode in the World App itself would have let us demo the true end-to-end experience without claiming assurance we do not have.
