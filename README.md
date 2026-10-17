# THE WALL ARCADE on SuperRare Connect

Arcade cabinets played on the names of a real wall in Lisbon (550 panels, ON THE WALL by NFC Summit), running entirely
on SuperRare's plumbing: Connect sign-in, a shared credit group paid in USDC, server-run games whose score is computed by a
verifier the platform runs, and the server leaderboard.

| | URL |
| --- | --- |
| Hub (cabinets, how it works, the kit) | https://6972mvu4.srstudio.dev/ |
| UNBREAKABLE (the reference game of this repo) | https://7x2phv5j.srstudio.dev/ |

This repository started from SuperRare's public template, [superrare/studio-games-example](https://github.com/superrare/studio-games-example)
(MIT), on the published `@rareprotocol/connect@0.9.0-beta.0`.

## What comes from SuperRare's template, what is ours

| Part | Origin | Files |
| --- | --- | --- |
| Wallet-isolated storage, hosted-flow error mapping | **Template**, unchanged | `src/shell/account-storage.ts`, `src/shell/hosted-flow.ts` |
| Purchase / claim / recovery of credits | **Template**, adapted: our pack terms as one source of truth, a buy screen (`buyNow`), purchase history, refused-claim handling | `src/shell/credits.ts` |
| Paid start, consent, recovery, server-run socket (the state machine) | **Template** (`round.js`), logic unchanged; the game plugs in through an adapter and reports its state to the page instead of drawing buttons | `src/shell/paid-round.js`, `src/shell/saved-round.ts` |
| Public config schema | **Template**, adapted (`display: popup \| embed`, game ids, hub link) | `src/shell/config.ts` |
| Verifier envelope (`POST /v1`, strict JSON, version 1) | **Template** (`server-verifier.ts`), generalised to any engine | `src/verifiers/protocol.ts` |
| Build and packaging (esbuild, zip with `server-verifier.js` + `scoring-config.json`) | **Template**, adapted for several games and hashed assets | `scripts/package-game.ts`, `scripts/build.ts` |
| Game seam (`GameAdapter`, `Stage`) | **Ours** | `src/shell/adapter.ts` |
| One-screen page: bar, full-frame game, overlay (PLAY / PRACTICE / top 5 / end screen), wallet menu, buy screen, embedded Connect, boot guard | **Ours** (replaces the template's `main.ts` and page) | `src/shell/app.ts`, `src/index.html`, `src/shell/styles.css` |
| Practice mode (local, unrecorded) | **Ours** | `src/shell/practice.ts` |
| Game engine, verifier, canvas client | **Ours** | `src/games/unbreakable/`, `src/verifiers/unbreakable.ts`, `src/common/det.ts` |
| Wall data (names) and the Survivor hit feed of NFC's own backend | **Ours** | `src/shell/wall-data.ts`, `src/shell/hits.ts`, `src/generated/*`, `scripts/snapshot-wall.ts` |
| Hub page | **Ours** | `hub/`, `scripts/build-hub.ts` |
| Tests, coordinator stand-in, fake Connect SDK for walking the page | **Ours** | `tests/`, `src/dev/`, `scripts/dev-*.ts` |

## How a game is built: engine / verifier / client / config

Three pieces that must agree, plus the public config:

1. **Engine** (`src/games/<game>/engine.ts`): the rules as pure, deterministic functions
   `createRun(seed, config) · advance(state, serverTick) · applyInput(state, input, serverTick) · view · isFinished · score`.
   Integer maths only (`+ − × ÷`, `Math.sqrt`, `floor`, `abs`), seeded PRNG (`src/common/det.ts`), state that round-trips
   through JSON exactly, no clock, no network. The **same module** runs in the browser (prediction) and in the verifier.
2. **Verifier** (`src/verifiers/<game>.ts`): the engine behind the template's `POST /v1` protocol. Bundled as
   `server-verifier.js` in the archive; Studio runs it (Workers for Platforms, 10 ms CPU per call, 64 KiB state, 256 KB
   bundle, no outbound requests). The server owns time (50 ms ticks) and applies at most one ordered input per tick.
3. **Client** (`src/games/<game>/client.ts`): a `Stage` that draws the authoritative state (advanced locally between
   snapshots) and turns a gesture into **one ordered input** (`{action:'fire', angle}`). It never sends a score, a time or
   a state. The `GameAdapter` exported next to it gives PaidRound the schemas, the prediction and the practice rules.
4. **Config** (`deploy/<game>.config.json` → `config.json` in the archive): public identity and routing only
   (`appId`, `groupId`, origins, `display`, `game`, `hubUrl`). Never a key, token or treasury: payment terms come from
   Studio's quote. `scoring-config.json` (round length in ticks) comes from `scoringConfiguration()` in `src/shell/config.ts`.

`src/games/tap-the-name/` is a second, experimental game kept for reference only: it is **not** a supported cabinet (in
live play its first answer was not counted by the platform, a cause not identified yet; see `docs/friction-with-the-template.md`).

UNBREAKABLE: a 180 Hz brick-breaker simulation, 9 steps per server tick, 3 minutes per run; `tests/unbreakable.test.ts`
replays the original browser game against the port when it is available on the machine (otherwise the test is skipped).

## Build, test, deploy

Requirements: Node.js 22+, npm (the lockfile is npm; pnpm is not needed), the `rare-profile` CLI **0.1.0-beta.4 or newer**
(`npm i -g @rareprotocol/rare-profile@beta`, or locally under `tools/`), a Studio creator account.

```sh
npm ci
npm run typecheck && npm test                    # engines, built verifiers, paid-round state machine, purchase guard
node --import tsx scripts/snapshot-wall.ts       # refresh the wall's names (the verifier has no network)
npm run build -- --config deploy/unbreakable.config.json --output dist/unbreakable.zip
npm run build:hub -- --output dist/hub.zip
rare-profile app update <app-id> --zip dist/unbreakable.zip --max-attempts 10000
```

* A server-scored archive needs `--max-attempts`: `app update` then registers the deployment's verifier version (Studio runs
  a conformance check) and creates its scoring event. **Every update supersedes the deployment and its event** (the
  leaderboard is kept: it spans deployments). Never run `app deploy` twice for a game: it allocates a new origin.
* The first deployment of a new game: `app deploy` a placeholder to get the origin, put that origin in the config, build,
  then `app update`; create or reuse a credit group (`rare-profile credit-group create …`) and attach the app
  (`credit-group add-game <group> --app <id> --origin <origin> --credits 1`). Details: the template's
  `docs/organizer-runbook.md`, and what differs today in `docs/friction-with-the-template.md`.
* The pack the client accepts is pinned in `src/shell/credits.ts` (`EXPECTED_PACK_PRICE_ATOMIC`, `EXPECTED_PACK_CREDITS`)
  and must equal the credit group's terms; `tests/credits-terms.test.ts` checks it against `deploy/credit-group.json`.
* Walk the whole page without a wallet: `node --import tsx scripts/dev-flow.ts <dir>`, serve `<dir>` at its root
  (fake sign-in, quote, checkout, claim and coordinator; `?credits=N&signed=1&ticks=N&mismatch=1`). It proves the page,
  not SuperRare's side.

## The kit

`docs/CONNECT-KIT.md` is what an artist hands to their AI to turn SuperRare's template into a new cabinet (the hub's
COPY THE KIT button, `hub/src.html`). It states what not to touch (the paid plumbing), the three pieces, the data of the
wall, the deployment steps and the required credit line.

## Required credit line

Every game built from this project or the kit shows, visibly in the game, linked to the wall:

> **A REMIX THE WALL EXPERIMENT · NFC SUMMIT 2027 · LISBON** — link to https://onthewall.nfcsummit.com

and keeps SuperRare's MIT notice for the template-derived code (`LICENSE`, `NOTICE`).

## Not in this repository

No credential of any kind: the CLI's token lives in `~/.rare-profile/config.json`, never here. No deployment records with
account identifiers (kept privately by the organizer). The NFC backend (`otw-arcade`, wall names and Survivor feed) is a
separate project; this repo only reads its public `GET /positions` and posts best-effort `POST /hits`.

## License

See `LICENSE` (SuperRare's MIT license for the template-derived code) and `NOTICE` (attribution and the license of the
NFC parts).
