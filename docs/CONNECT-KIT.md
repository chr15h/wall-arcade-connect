# The Connect Kit

What an artist pastes into their AI (Claude, ChatGPT…) to make a new game for THE WALL ARCADE. The hub's COPY THE KIT
button (`hub/builders.html`) copies the link of this repository followed by the block below, inlined at build time by
`scripts/build-hub.ts`: edit it here only.

```text
You are helping me make a NEW game for THE WALL ARCADE, an arcade of browser games built on the names of a real wall in
Lisbon (550 names, ON THE WALL by NFC Summit). Players sign in with SuperRare Connect, buy credits and spend 1 credit per
play; the score is computed by SuperRare's server. Describe nothing to me until you have read the sources below.

STARTING POINT (pick one)
- SuperRare's public template: https://github.com/superrare/studio-games-example (MIT), Connect 0.11.0.
  Read in it: README.md, docs/creator-handoff.md (SuperRare's guide for creators like me), docs/organizer-runbook.md,
  docs/server-verification.md.
- Or THE WALL ARCADE's own repository (the link above this kit): the same plumbing with two finished games of the wall
  (src/games/unbreakable, src/games/full-row). Its README says what comes from the template and what is ours.
Requirements: Node.js 22+, Git, pnpm 10.11.0 for the template (npm for ours), the CLI: npm install --global @rareprotocol/rare-profile@0.1.0
and a SuperRare Studio creator account (rare-profile login). I run every command that touches my account myself.

HOW A CONNECT GAME WORKS (do not rewrite this plumbing)
- Sign-in, purchase, purchase recovery, the explicit "spend 1 credit" consent and the paid start are already written:
  in the template, leave src/credits.ts, src/account-storage.ts, src/hosted-flow.ts, src/main.ts and the paid-start parts of
  src/round.js alone. Payment terms (price, currency, treasury) come from SuperRare's quote, never from the game.
- Connect opens embedded in the page ("display": "embed", the default). If a browser cannot embed it, the page offers an
  explicit popup retry; it never opens a popup by itself. Keep that behaviour.
- Practice: the same rules run locally in the browser (src/practice.ts), free, no credit, nothing recorded, and clearly
  labelled as practice. Keep it working with your new rules: it is how players learn the game and how I test it.
- Credits can also be given by the arcade (an organizer grant): they land in the same balance and still need the same
  per-play consent. The game needs no code for that. Never add a free paid-start fallback, seeded credits or any grant code.
- The score is decided by the platform, never by the browser. A game is three pieces that must agree:
  (1) a deterministic ENGINE (createRun, advance, applyInput, view, isFinished, score) - src/target-engine.ts in the template,
  (2) a VERIFIER (src/server-verifier.ts) exposing that engine over POST /v1, bundled in the archive as server-verifier.js,
  (3) the browser CLIENT (src/round.js) that sends ordered inputs and draws the state the server returns.
- The browser sends only inputs such as {"action":"hit","targetId":3}: never a score, a time or a state. The platform owns
  time in 50 ms server ticks, accepts at most one input per tick, 1 KiB per message.

RULES FOR THE ENGINE AND THE VERIFIER
- Deterministic and small: no Math.random, Date, network or storage. Same seed, same game. 10 ms CPU per call, no outbound
  request, state under 64 KiB, bundle under 256 KB.
- Validate every input strictly (reject extra fields, bound every number). An illegal input is a no-op, never a score.
- Never trust the client for score, time, positions or state: derive everything from the previous server state and the tick.
- Run the checks: pnpm install --frozen-lockfile, pnpm typecheck, pnpm test, and the local and bundled-verifier exercises in
  docs/server-verification.md. Add tests for the new rules (wrong action, replay, timing, forged input).
- Perfectly legal automated inputs are accepted by these rules: do not call the game bot-proof.

THE LEADERBOARD: ONE WEEK AT A TIME
- The arcade's week runs Friday 15:00 to Friday 15:00, Lisbon time. Week 1 is longer: Thursday 2026-10-22 00:00 to Friday
  2026-10-30 15:00 Lisbon, that is "leaderboardWindow": { "from": "2026-10-21T23:00:00Z", "to": "2026-10-30T15:00:00Z" }.
- The template reads a fixed window from config.json ("leaderboardWindow", [from, to), both with Z or an explicit offset;
  without it, all time). A fixed window must be rebuilt and redeployed every week. Better: compute the week in the page and
  call getServerLeaderboard({ from, to }) as THE WALL ARCADE does (src/shell/week.ts in our repository), and show the real
  end date ("ends Fri Oct 30 · 15:00 Lisbon"). Names on the leaderboard: ENS when the platform resolved one, else 0x1234…abcd.

THE WALL (public data, free, no key)
  GET https://otw-arcade.netlify.app/positions
  Array of 557 objects: { position, tier, idx, minted, name, owner, xHandle }
  "name" and "owner" (wallet address) only when minted is true; "xHandle" (X handle, no @) only when known.
  tier is one of: name, pfp, house, mural, flag.
  Names grid (tier "name"): 500 bricks, 25 columns x 20 rows (column = idx % 25).
  PFPs (tier "pfp"): 50 bricks, 25 x 2, above the names. That makes the 550 bricks of the wall.
  The verifier has NO network: embed the names it needs as a snapshot at build time. In the browser, fetch the live data at
  load and fall back to the snapshot if it fails.

IDENTITY (use, remix or ignore): concrete #DEDBD3, ink #0B0B0B, chalk #F2F0EB, one blue #2E7FD6; Anton for titles.

THE DEAL: Every paid play goes straight into the jackpot. Every Friday it's split: half to the best score on each game, 40% to the artists who made the games, 10% to the wall.

THE RULE
- The credit line, visible in the game, linked:
  A REMIX THE WALL EXPERIMENT · NFC SUMMIT 2027 · LISBON - https://onthewall.nfcsummit.com
- You send one edition of your game's artwork to the wallet that holds the name, on the platform of your choice, within a
  month of your game going live; we give you the address.

OPTIONAL: tell the weekly Survivor which minted name was hit (best effort, batched, never blocks play):
  POST https://otw-arcade.netlify.app/hits   {"game":"your-game-slug","hits":{"name-0":2,"pfp-3":1}}   keys: name-<idx>, pfp-<idx>

CONFIG (config.json, public: never a key, token, treasury or secret in it)
  { "appId": "<my app id>", "groupId": "60faaf46-ba4b-460c-a82a-adb852371a94",
    "studioUrl": "https://studio.superrare.com", "apiUrl": "https://api.superrare.com", "connectUrl": "https://connect.superrare.com",
    "appOrigin": "https://<my-game-host>.srstudio.dev", "display": "embed", "game": "<variant>" }
  groupId is THE WALL ARCADE's shared credit group: do NOT create a credit group.

PUTTING IT ONLINE: two commands, which I run (give them to me filled in)
1. Once, to get my app ID and HTTPS address, with a placeholder page (rare-profile store list gives my storefront id):
   mkdir -p /tmp/wall-game && printf '<!doctype html><title>Integration test only</title><h1>Integration test only</h1>' > /tmp/wall-game/index.html && (cd /tmp/wall-game && zip -q bootstrap.zip index.html) && rare-profile app deploy --store <storefront-id> --title "<Game title> - integration test" --price 0 --zip /tmp/wall-game/bootstrap.zip --json
   Put the returned id in config.json as appId and the returned app_url (scheme + host, no path, no trailing slash) as appOrigin.
   Never run app deploy again for this game: it would create another app and another address.
2. Every time the game changes: build, then update the same app (it also registers the verifier and the scoring event):
   pnpm build -- --config ./my-game.config.json --output ./dist/my-game.zip --force && rare-profile app update <app-id> --zip ./dist/my-game.zip --max-attempts 10000 --json
   (In THE WALL ARCADE's repository: npm run build -- --config deploy/<game>.config.json --output dist/<game>.zip --force.)
   The ZIP must hold, at its root: index.html, config.json, assets/, server-verifier.js, scoring-config.json.
Then check the deployed page and Practice. Paid play works once the arcade has registered the game; do not buy credits to test.

WHEN THE GAME IS ONLINE, send this to John (DM @johnkarp on X), filled in:
  Name:
  Game address (https://…srstudio.dev):
  App ID:
  I agree to enable this app in the shared arcade group at 1 credit per play.
The game is in the arcade within 24 hours. Never send a CLI token, a wallet key or a session.

When you write code, give me every changed file in full, the new tests, and the exact commands to run.
```
