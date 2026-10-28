# THE WALL ARCADE on SuperRare Connect

Arcade games played on the names of a real wall in Lisbon (550 panels, ON THE WALL by NFC Summit), running entirely
on SuperRare's plumbing: Connect sign-in, a shared credit group paid in ETH (50 plays for 0.005 ETH), server-run games whose score is computed by a
verifier the platform runs, and the server leaderboard.

| | URL |
| --- | --- |
| Hub (the games; `builders.html`: make a game on the wall, the kit; `assets.html`: THE WALL KIT, the wall's assets) | https://6972mvu4.srstudio.dev/ |
| UNBREAKABLE (the reference game of this repo) | https://7x2phv5j.srstudio.dev/ |
| FULL ROW (game #02: Block Blast rules, the names of the wall on the pieces) | https://yfq52eu3.srstudio.dev/ |

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

`src/games/full-row/` is game #02, **FULL ROW**: a copy of the most common
Block Blast / 1010! rules (8×8 grid, three pieces in a tray, full rows and columns clear, combo, the run ends when no piece
fits; 8-minute server cap, LAST MINUTE shown only in its last minute). One input, `{action:'place', slot, x, y}`; the generator is a pure function of the run seed
(weights and the "one piece of 3 cells or fewer per trio" guarantee are in its `RULES`). The names of the wall are a client
skin over the pieces' draw index (`names.ts`), never seen by the engine. `scripts/calibrate-full-row.ts` plays a random and a
greedy bot through the built verifier.

Screens follow one rule: one job, one sentence and one blue button per screen; every explanation sits behind the (i)
of the bar ("How it works"). The entry is the title, one sentence, PLAY · 1 CREDIT, "Practice, free" and this week's
top 3; the wallet is the balance, the shortened address and BUY; "purchase help" holds the history and the recovery.
During a run the bar goes away (a discreet ← in a corner): the score, big, and the names only when something is
painted; the first full row of a FULL ROW run gets a short ROW PAINTED moment. After a run, both games show the card
itself (`src/share/end-screen.ts`, drawn in the page by the same `src/share/card-draw.ts` as the card service), POST ON
X in blue under it, then PLAY AGAIN in ink (the page passes its end figures through the optional `Stage.endStats`).
The leaderboard is THIS WEEK's everywhere (Friday 15:00 to Friday 15:00, Lisbon; `src/shell/week.ts`), names are ENS
when the platform resolved one.

**POST ON X** (`src/share/post.ts`): one link to `x.com/intent/post` with the tweet written (X handles of the names
when known, the wall name otherwise, ≤ 280 characters) and a card link. The link is made by the **card service**
(`cards/`, its own Netlify site, https://wall-arcade-cards.netlify.app): `POST /api/cards` validates the card (names of
the wall only, integer scores, a player that is an ENS name or a shortened address; a leaderboard card's rows are read
from the platform's public leaderboard, never sent by the page), renders it server-side with the same drawing code
(`src/share/card-draw.ts`, @napi-rs/canvas, embedded Anton and IBM Plex Mono) and stores it in Netlify Blobs;
`/r/<id>` carries the og: / twitter: tags (summary_large_image, a 1200 × 630 preview with the whole card) and sends a
person on to the game; `/r/<id>.png` is the 1080 × 1080 card. Deploy: `cd cards && npm install && npm run deploy`;
tests: `cd cards && npm run assets && npm test`. No key in the repository (the Netlify CLI's own login).

`src/games/tap-the-name/` is a second, experimental game kept for reference only: it is **not** a supported game (in
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
* Walk the whole page without a wallet: `node --import tsx scripts/dev-flow.ts <dir> [unbreakable|full-row]`, serve `<dir>`
  at its root (fake sign-in, quote, checkout, claim and coordinator; `?credits=N&signed=1&ticks=N&mismatch=1&address=0x…`).
  It proves the page, not SuperRare's side. On a phone: `node --import tsx scripts/dev-serve.ts <dir> --lan` serves it over
  HTTPS with a throwaway self-signed certificate (the paid flow needs a secure context) and prints the wifi address.

## The kit, and adding an artist's game

`docs/CONNECT-KIT.md` is what an artist pastes into their AI to make a new game for the arcade: how a Connect game works
(what not to touch, Practice, embedded Connect, the weekly leaderboard window, credits given by the organizer), the data of
the wall, the shared group id, the two commands that put a game online, SuperRare's developer guide
([`docs/creator-handoff.md`](https://github.com/superrare/studio-games-example/blob/main/docs/creator-handoff.md)) and what
to send back. The hub's builders page (`hub/builders.html`) copies this repository's link followed by that kit; the build
inlines it from the Markdown file, so the file is the only place to edit it.

When an artist sends their name, game address, app ID and "I agree to enable this app in the shared arcade group at
1 credit per play", the organizer attaches the game to the shared group in one line:

```sh
rare-profile credit-group add-game 60faaf46-ba4b-460c-a82a-adb852371a94 --app <ARTIST_APP_ID> --origin https://<artist-host>.srstudio.dev --credits 1
```

The origin is the exact HTTPS origin (no path, no trailing slash). Attach a game only once its paid flow is ready: an
active group gates unpaid starts at once. Then add it to the hub (`hub/src.html`: its card, with its PLAY link's
`data-app`, its board, and the `GAMES` list); the hub shows its top 3 as soon as it has an active scoring event. The card
service lets it in by itself: it reads the group's apps (id, origin, name) where `/stats` does, at the next refresh (every
15 minutes, or `/stats?refresh=1`), with our three origins and our two games always (`cards/src/group.ts`). Its page may
then `POST /api/cards` and `/api/events` (its tags are counted as its game's), the hub's PLAY is counted with its app id,
and a board card (`{ kind: 'board', game: <app id> }`) shows its top 5 under its own name. (CLI 0.1.0 applies `add-game` but may report "Unexpected response shape"
because the API no longer returns `creditCost`: check the group afterwards before retrying.)

### The artists' games

Attached to the shared group at 1 credit per play. The 40% of the jackpot that goes to the artists each Friday is paid
to the wallet below.

| Game | Artist (panel) | App ID | Origin | 40% paid to | Attached | On the hub |
|---|---|---|---|---|---|---|
| Dirty Signals Radio | Bully Meow (BULLY-MEOW, panel 18) | `8617e311-f5d4-4e04-9010-19298f2ff9a0` | https://sy3mgnnh.srstudio.dev | `0x14076eFC88Ca7D53594500261AdA8185033e6D5B` | 27 Oct 2026 | 28 Oct 2026, card #03 and its top 3 |
| THE MORNING BREW | osaykancuno (K4NCUN0, panel 33) | `1c10c96c-bf88-471c-88af-7f23a992a7ea` | https://k6ag9vxz.srstudio.dev | `0x41b199A5194c58b29559A482E919331E1c8EEF85` (the wallet holding K4NCUN0, unless the artist gives another) | 28 Oct 2026 | 28 Oct 2026, card #04 and its top 3 |

## The people of the wall: walking sprites

Every person of the wall has a walking sprite. Use them.

People of the wall make a pixel character in 30 seconds at Sprite Party (event "PEOPLE OF THE WALL"), typing their
name as painted on the wall. The way in is token-gated: the hub's PEOPLE section (`hub/people-gate.ts`) shows ADD
YOURSELF only to a player signed in with Connect whose wallet holds a name of the wall, and the games' band and end link
only to such a holder; the capture link is in no page, the card service hands it to a holder
(`GET /people/capture?wallet=`). A sprite whose name matches no name of the wall stays out of people.json. The card
service mirrors each sheet and matches it to its panel (`cards/src/people.ts`, `cards/people/aliases.json` for the rest):

- `GET https://wall-arcade-cards.netlify.app/people.json` (public, no key, CORS *, refreshed every 5 minutes): one object
  per name painted on the wall, `{ panel, name, handle, wallet?, sprite: { id, url, cols: 4, rows: 4, frame: 48 } | null, updatedAt }`.
- A sheet is a PNG of 192 × 192, transparent, 4 × 4 frames of 48 px: row = direction (0 up, 1 right, 2 down, facing
  you, 3 left), column = step (4 steps, 130 ms each). `/people/sprites.zip` holds them all.
- In the games (`src/shell/people.ts`, `src/share/sprite.ts`, display only): FULL ROW's ROW PAINTED shows the row's
  people walking and its card carries their sprites (resolved by the card service, never sent by the page);
  UNBREAKABLE shows the signed-in player's character where the dragon stands; a holder without a character gets a band
  and a "Make your character →" link.

The hub's `assets.html`, THE WALL KIT, gathers what an artist can use: people.json, the sprites, the names, the palette,
the fonts, the dragon, and a 20-line example that walks a sprite on a canvas (`hub/kit/walk-a-sprite.html`).

## The jackpot and the split

Every paid play goes straight into the jackpot. Every Friday it's split: half to the best score on each game, 40% to the artists who made the games (their payout wallets: [The artists' games](#the-artists-games)), 10% to the wall. It is stated once in each place a player or an artist reads it: the games' (i) and the kit. It replaces the original 50/35/15 split.

The jackpot shown is the treasury wallet's balance (0xb6ede0158e1792ed25e1367edeec05a824d7c9ad), live: the card
service's own `GET https://wall-arcade-cards.netlify.app/pot` (`cards/src/pot.ts`) reads it by a public RPC and answers
`{ pot }` (ETH, 4 decimals), cached 60 s; if no RPC answers, the last amount served. The hub's jackpot line (under its title) and
the line "Jackpot … ETH" on the games' entry screen read it. The former arcade's `/pot` (otw-arcade) is not read any more.

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

## The teaser

`comms/teaser/` holds THE WALL ARCADE's launch teaser (37 s: the opening with the two logos, the title, five sequences of
a card and then a clip, the wall's photo or nothing, the end card) in 16:9, 9:16 and 1:1, its stills and `holders.png`. `scripts/teaser-capture.ts` records the clips (the
game stages on the test bench, the entry screen with the fake Connect SDK, the player page), `scripts/teaser.ts`
draws the pixel world (8 tones, `comms/teaser/palette.json`), the cards, the photo's push-in and the music (Korobeiniki,
synthesized) and encodes the films; texts and sources are in `comms/teaser/teaser.config.json`.

