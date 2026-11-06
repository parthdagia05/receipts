# Receipts demo video script

Target length: about 3:40. Speak naturally, do not rush. Each section is one clip.
What is on screen is in brackets. Slides are used only where marked, everything else is the live product.

## Flow rules (how the Clarity video stays fluent)

- Narrate what is on screen while it happens, never before or after.
- One transition sentence between chapters: "Now let me show you how a review actually happens."
- End every demo beat with its benefit in one line.
- Keep sentences under 15 words.

## Clip 1: Title (0:00 to 0:08) — SLIDE 1

> Receipts. Reviews for AI agents that bots cannot outvote.

## Clip 2: Problem (0:08 to 0:28) — SLIDE 2

> We already know fake reviews cost buyers billions. Now AI agents are
> getting paid for work, and Ethereum gave them an on-chain reputation
> standard, ERC-8004. But that registry accepts feedback from any address,
> and its score is a plain average.

## Clip 3: The attack (0:28 to 0:50) — LIVE TERMINAL, no slide

[Screen: run the AttackLab fork test, output shows 50 going to 77]

> So before building anything, we attacked it. On a fork of mainnet, six
> freshly created wallets drag a real agent's reputation from fifty to
> seventy seven. The only cost is gas. If agents hire each other based on
> these scores, that is a real problem.

## Clip 4: The three rules (0:50 to 1:10) — SLIDE 3

> Receipts fixes the write path with three rules. A review only counts if
> a verified human wrote it. If the reviewer actually paid the agent, the
> review carries more weight. And the score is a weighted median, so a
> minority of attackers can never push it past honest opinion.

## Clip 5: Live walkthrough (1:10 to 2:25) — LIVE APP

[Screen: the review wizard, done manually]

> Now let me show you how a review actually happens, live on Sepolia.
> I pick an agent and write a review. Receipts asks me to prove I am
> human. This is a real World ID verification, not a mock.

[Do the World ID flow on camera]

> Behind the scenes, our server verifies the proof and stores the
> nullifier. My wallet signs, the server attests, and the review goes
> on-chain into the real ERC-8004 registry.

[Show the transaction and the reputation page]

> Here is the part that matters. If I cancel the verification, no review.

[Cancel one attempt on camera]

> And if I try to review the same agent again, I am blocked. Any number
> of wallets, same human, still one review.

## Clip 6: The gauntlet (2:25 to 2:50) — LIVE APP

[Screen: Attack demo page, click the button, both panes fill]

> But does the math hold? We run ten thousand randomized attacks through
> the same engine production uses. In the trials where attackers held
> less than half the weight, the registry average broke three thousand
> three hundred times. The weighted median broke zero times. The seed is
> fixed, so anyone can rerun this and get the same numbers.

## Clip 7: Open record (2:50 to 3:05) — LIVE APP

[Screen: the Arkiv panel on an agent page]

> Every confirmed review is also published to a public queryable network,
> so anyone can read an agent's standing without trusting our server.

## Clip 8: Future and growth (3:05 to 3:25) — SLIDE 4

> What is next: the paid review flow ships in the UI, then mainnet.
> And this grows. Every agent marketplace will need a trust layer, and
> Receipts plugs in with one gateway contract and one API. Every verified
> review becomes public data anyone can build on.

## Clip 9: Close (3:25 to 3:40) — SLIDE 5

> Existing projects read agent reputation and rank it. Receipts fixes
> where it comes from. Trust needs a receipt. Thank you.

## Recording rules (ETHGlobal rejects videos that break these)

- 2 to 4 minutes, 720p or higher, no phone recording
- Your real voice, no AI voiceover, no text-to-speech, not sped up
- No music-with-captions instead of narration
- Max 4 bullets on any slide
