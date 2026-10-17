# The Connect Kit

What an artist gives their AI to adapt SuperRare's template into a new cabinet (the same text as the hub's COPY THE KIT button, `hub/src.html`).

```text
You are adapting the public SuperRare Studio game template into a NEW game for THE WALL ARCADE.
Template: https://github.com/superrare/studio-games-example (MIT) on the published @rareprotocol/connect 0.9.0-beta.0.
Read first, in the cloned repo: README.md, docs/organizer-runbook.md, docs/server-verification.md.

HOW A CONNECT GAME WORKS (do not rewrite this plumbing)
- The player signs in with SuperRare Connect, buys credits in a pack (USDC, Ethereum mainnet) and spends 1 credit per run.
  Credits live in a CREDIT GROUP shared by every game registered in it. The template already implements sign-in, purchase,
  consent, recovery and run start: leave src/credits.ts, src/account-storage.ts, src/main.ts and the paid-start parts of src/round.js alone.
- The score is decided by the platform, never by the browser. A game is three pieces that must agree:
  (1) a deterministic ENGINE (pure functions createRun, advance, applyInput, view, isFinished, score) in src/target-engine.ts,
  (2) a VERIFIER Worker (src/server-verifier.ts) exposing that engine over POST /v1, bundled in the archive,
  (3) the browser CLIENT (src/round.js) that sends ordered inputs and draws the state the server returns.
- The browser sends only inputs such as {"action":"hit","targetId":3}: never a score, a time or a state.
  The platform owns time in 50 ms server ticks (20 per second), accepts at most one input per tick, 1 KiB per message.

RULES FOR THE ENGINE AND THE VERIFIER
- Deterministic and small: no Math.random, Date, network or storage. Same seed, same game. 10 ms CPU per call, no outbound request,
  state under 64 KiB, bundle under 256 KB.
- Validate every input strictly (reject extra fields, bound every number). An illegal input is a no-op, never a score.
- Never trust the client for score, time, positions or state: derive everything from the previous server state and the tick.
- Run the template checks: pnpm install --frozen-lockfile, pnpm typecheck, pnpm test, and the local verifier and bundled-verifier
  exercises in docs/server-verification.md. Add tests for your new rules (wrong action, replay, timing, forged input).
- Perfectly legal automated inputs are accepted by these rules: do not call your game bot-proof.

THE WALL (public data, free, no key)
  GET https://otw-arcade.netlify.app/positions
  Array of 557 objects: { position, tier, idx, minted, name, owner, xHandle }
  "name" and "owner" (wallet address) only when minted is true; "xHandle" (X handle, no @) only when known.
  tier is one of: name, pfp, house, mural, flag.
  Names grid (tier "name"): 500 bricks, 25 columns x 20 rows (column = idx % 25).
  PFPs (tier "pfp"): 50 bricks, 25 x 2, above the names. That makes the 550 bricks of the wall.
  The verifier has NO network: embed the names/positions it needs as a snapshot at build time. In the browser, fetch the live
  data at load and fall back to the snapshot if it fails.

IDENTITY (use, remix or ignore): the NFC system. Concrete #DEDBD3, ink #0B0B0B, chalk #F2F0EB, one blue #2E7FD6.
  Anton for titles, IBM Plex Mono for labels. Dashed = empty brick, solid = minted.

REQUIRED CREDIT LINE, visible in the game:
  A REMIX THE WALL EXPERIMENT · NFC SUMMIT 2027 · LISBON — link to https://onthewall.nfcsummit.com

OPTIONAL: tell the weekly Survivor which minted name was hit (best effort, batched, never blocks play):
  POST https://otw-arcade.netlify.app/hits   {"game":"your-game-slug","hits":{"name-0":2,"pfp-3":1}}   keys: name-<idx>, pfp-<idx>

DEPLOYMENT (the artist runs these, not the AI): docs/organizer-runbook.md. rare-profile CLI 0.1.0-beta.4+, app deploy (placeholder),
  credit group, pnpm build, app update, then publish the verifier version and the scoring event. Never put keys, tokens, treasury
  overrides or secrets in config.json.

When done, give me: every changed file in full, the new tests, and the exact commands to run.
```
