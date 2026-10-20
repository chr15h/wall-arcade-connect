# Friction following SuperRare's runbook and template (for SuperRare)

> **Paiement en ETH natif (native ETH payment): not possible with a credit group.** The organizer asked for packs priced in
> native ETH (2026-10-17). A credit group is USDC-only: `rare-profile credit-group create` requires `--usdc <token>`, the
> group stores a `usdcAddress`, the runbook names canonical Ethereum USDC as the only supported setup, and the claim checks a
> USDC transfer. We keep USDC (50 credits for 10 USDC). Ask: native ETH (or any ERC-20 + ETH) as the pack currency.

Observed 2026-10-17 while taking the studio-games-example template to two new games and a hub.

1. **The runbook says there is no scoring command; the CLI has one.** Section 6 describes manual creator HTTP calls
   (or a browser-console script) to register a verifier version and create an event. `rare-profile` 0.1.0-beta.4 does
   both inside `app update/deploy` (it requires `--max-attempts <1-10000>` for a server-scored ZIP) and has `app scoring`.
2. **"CLI not on npm" was out of date**: on 2026-10-17 the `beta` dist-tag is 0.1.0-beta.4 (latest is still beta.3).
   The documented clone / `pnpm build` / `npm pack` install is unnecessary.
3. **Config schema vs live apps**: the repo accepts only `display: "popup"`, while the four reference apps listed
   as live (y4prnpya, q3s9bpab, q77e66pg, tu9zzywe) serve `"display": "embed"`.
4. **The game list is hard-coded** (`z.enum(['target-rush','color-match'])` in config, engine, packager, build title,
   main.ts copy, round.js DOM). A third game means touching ~8 files; we introduced a `GameAdapter` seam.
5. **Verifier conformance only calls `createRun` with seed 0**: a verifier that passes can still be wrong everywhere
   else; our own end-to-end harness against the BUILT module is what exercised `advance/applyInput/score`.
6. **No way to test the paid run without paying**: a registered app gates free sessions (402), the Connect login is a
   popup (blocked in headless / agent browsers). The coordinator's real cadence (calls per tick, CPU budget in a real
   isolate, session TTL vs run length) is untestable before a real run.
7. **Group creation is live-capable and one-way**: purchases are enabled on creation, a price/treasury change pauses
   them, and there is no unpause command (documented, but easy to trip over).
8. **No grant / allowlist mechanism**: no way for an organizer to give credits (e.g. a weekly free play for holders of a
   collection) or to let a wallet play free in a registered app.
9. **Only an all-time top 10** (`getServerLeaderboard`) and an app-wide top score: no weekly or per-event standings,
   although events have windows; the completed-runs feed is creator-only and has no wallet directory for payouts.
10. **One treasury per group**: an artist cannot be paid per game inside a shared-credit group.

16. **TAP THE NAME, open question (2026-10-17).** On the live platform, every run of the reaction game ended with score 0
    at about start + 64 ticks: the first answer was not counted and the first question expired (completed-runs feed:
    `last_tick` 91-103, ~5 s). Locally, a bot that always answers right wins: through the page with a simulated coordinator
    (0 and 150 ms one-way latency) and through the deployed verifier bundle (same first question as the client, correct
    answer accepted). The coordinator's exact handling (input acceptance/rejection, `inputTick`, catch-up) is not observable
    from outside a paid run; a per-run input trace in the creator feed would settle it. The game is off the hub and the README,
    and its product was unlisted on 2026-10-17 until this is understood. **Still open.**

Added after v2 (one-screen page, embedded Connect):

11. **The template has no embed path** although the live reference apps use one: we wrote the iframe adapter
    (`ConnectEmbedOptions` in a `<dialog>`), following the SDK README. It works on https://7x2phv5j.srstudio.dev (the
    hosted sign-in renders in the iframe; closing it returns `cancelled`).
12. **`game.connect()` does not emit `auth.onChange`**: a page that keys its saved-round storage on the authorization
    must refresh after connecting, or it looks for the saved play under no key (this hid a signed-out-with-credits start).
13. **The claim refuses a payment from another wallet with a generic 422** ("does not match this payment quote"), and the
    hosted checkout lets the player pay from an account other than the signed-in one. Nothing in the SDK lets the page
    pin the paying account; we can only warn ("Pay from this wallet only") and offer recovery. The organizer hit this on 2026-10-17.
14. **`getServerLeaderboard` names players by `displayName`**: a wallet for `kind: wallet`, a profile name otherwise, so a
    page cannot reliably find the signed-in player's rank; there is no "my rank / my best" for server-verified runs.
15. **Free plays**: no grant and no free session in a registered app, so "3 free plays a week for holders" can only be a
    local, unrecorded practice mode.

17. **The run seed is the platform's, per run (2026-10-19, FULL ROW).** `createRun` receives the coordinator's seed; a game
    cannot ask for "the same pieces for everyone this week" (a seed from the ISO week and a run number). FULL ROW's pieces are
    a pure function of the seed it is given, so two runs with the same seed are identical, but whether two players ever share
    a seed is up to the platform. A weekly shared puzzle would need a seed (or a seed salt) settable per event.
