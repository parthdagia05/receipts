# Receipts demo video script

Target length: 3:20 to 3:30. Speak naturally, do not rush. Each section is one clip.
What is on screen is in brackets. The doubt each line kills is in italics.

## Clip 1: Problem (0:00 to 0:20)

[Screen: a product page full of suspicious 5-star reviews, then the ERC-8004 spec page]

> In today's marketplace, we already know fake reviews cost buyers billions.
> Now AI agents are getting paid for work, and Ethereum gave them an on-chain
> reputation standard, ERC-8004. But that registry accepts feedback from any
> address, and its score is a plain average.

*Doubt killed: why should I care. The problem is current and on-chain today.*

## Clip 2: The attack (0:20 to 0:45)

[Screen: AttackLab test output, score going 50 to 77]

> So before building anything, we attacked it. On a fork of mainnet, six
> freshly created wallets drag a real agent's reputation from fifty to
> seventy seven. The only cost is gas. If agents are going to hire each
> other based on these scores, this is a real problem.

*Doubt killed: is the problem real, or marketing. We show it, not claim it.*

## Clip 3: The fix, in one breath (0:45 to 1:05)

[Screen: Receipts landing page]

> We built Receipts to fix the write path. A review only counts if a
> verified human wrote it. One human, one review, per agent, enforced by
> World ID. If the reviewer actually paid the agent, their review carries
> more weight. And the score is a weighted median, not an average, so a
> minority of attackers cannot push it past honest opinion.

*Doubt killed: what is it. Three rules, ten seconds each.*

## Clip 4: Live walkthrough (1:05 to 2:20)

[Screen: the review wizard, done live and manually]

> Let me show you, live on Sepolia. I pick an agent and write a review.
> Receipts asks me to prove I am human. This is a real World ID
> verification, not a mock.

[Do the World ID flow on camera]

> Behind the scenes, our server signs the request context, verifies the
> proof, and stores the nullifier. My wallet signs the review, the server
> attests it, and the review goes on-chain into the real ERC-8004 registry.

[Show the transaction and the reputation page]

> Here is the part that matters. If I cancel the World ID check, no review.

[Cancel one attempt on camera]

> And if I try to review this agent a second time, the nullifier is already
> spent, so I am blocked. Any number of wallets, same human, still one review.

*Doubts killed: is it real, is World ID actually wired in, what stops repeat votes. The failure path is shown on camera, which the World prize requires.*

## Clip 5: The gauntlet (2:20 to 2:50)

[Screen: Attack demo page, click the button, both panes fill]

> But does the math actually hold? We run ten thousand randomized attacks,
> live, through the same scoring engine production uses. Random honest
> crowds against bot gangs. The registry average gets pushed past every
> honest rating over nine thousand times. Look at the trials where
> attackers hold less than half the weight: the average breaks three
> thousand three hundred times. The weighted median breaks zero times.
> That zero is a mathematical guarantee, and the seed is fixed, so anyone
> can rerun this and get the same numbers.

*Doubts killed: is the median actually better, is the demo cherry-picked.*

## Clip 6: Open data (2:50 to 3:05)

[Screen: the Arkiv panel on an agent page]

> Every confirmed review and every score snapshot is also published to
> Arkiv, a public queryable testnet. Anyone can read an agent's standing
> with one query, without trusting our server.

*Doubt killed: is this a walled garden.*

## Clip 7: Close (3:05 to 3:25)

[Screen: leaderboard or architecture slide, max 4 bullets]

> Existing projects read agent reputation and rank it. Receipts is the
> first to fix where that reputation comes from: payment and personhood,
> checked at write time. Next we ship the paid review flow in the UI and
> go to mainnet. Trust needs a receipt. Thank you.

*Doubt killed: how is this different, what happens after the hackathon.*

## Recording rules (ETHGlobal rejects videos that break these)

- 2 to 4 minutes, 720p or higher, no phone recording
- Your real voice, no AI voiceover, no text-to-speech, not sped up
- No music-with-captions instead of narration
- Max 4 bullets on any slide
