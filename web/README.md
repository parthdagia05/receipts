# Receipts — web

The Receipts frontend: browse ERC-8004 agents, read reviews, and submit a free,
human-verified review end to end.

## Running it

The Record Server must be running first — the review flow depends on it, and the
dashboard reports its health.

```bash
cd server && npm run dev     # http://localhost:3000
cd web    && npm run dev     # http://localhost:5173
```

`web/.env` is optional: every value falls back to the deployed Sepolia
configuration. Copy `.env.example` to `.env` to override anything.

In development the Vite dev server proxies `/api`, `/reviews` and `/health` to
the Record Server, so the browser stays on one origin and **no CORS
configuration is needed**. Point `RECORD_SERVER_URL` elsewhere if the server is
not on port 3000.

## Deploying

`npm run build` emits a static bundle to `dist/`. Two options:

- **Same origin (recommended).** Serve `dist/` behind the same host as the
  Record Server, with `/api`, `/reviews` and `/health` routed to it. Leave
  `VITE_API_BASE_URL` empty.
- **Separate origins.** Set `VITE_API_BASE_URL` to the server's URL. The Record
  Server currently ships **no CORS middleware**, so it will need one before this
  works from a browser.

Every `VITE_`-prefixed variable is inlined into the bundle and is public. Never
put a private key, the World ID signing key, or an RPC URL carrying an API key
into one.

## What it reads, and from where

| Surface                                            | Source                                           |
| -------------------------------------------------- | ------------------------------------------------ |
| Agent list, owner, payment wallet, metadata URI    | ERC-8004 Identity Registry, direct RPC           |
| Reputation summaries and feedback counts           | ERC-8004 Reputation Registry, direct RPC         |
| Review history, reviewer, nullifier, evidence hash | `ReviewSubmitted` events on the Receipts gateway |
| Review text                                        | Record Server, `GET /reviews/:feedbackHash`      |
| Server health                                      | Record Server, `GET /health`                     |

Nothing is mocked. Where a value cannot be read, the interface shows an em dash
or an explicit error state rather than a plausible-looking number.

### Agent discovery

The Identity Registry implements no enumeration — `totalSupply` and
`tokenByIndex` both revert — so the highest minted agent id is found by binary
search over `ownerOf`, which reverts with `ERC721NonexistentToken` for an unminted
id. The directory then pages backwards from there. Search is by agent id because
that is the only key the contract can answer on; there is no on-chain name index.

## Scope

Only the **free** review path is implemented. Paid reviews need a settled USDC
receipt, and no client exists for `ReceiptSettler.settle` yet — see the
Documentation page in the app.
