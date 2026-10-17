// The game page: one screen. A thin bar (← arcade, title, credits, wallet), the game full frame, and an overlay on the
// game for everything a player decides: PLAY, PRACTICE, the "spend 1 credit" consent, the end of a run.
//
// PLAY walks the four Connect approvals behind one button, each one still explicit and cancellable:
//   1. not signed in        -> SuperRare Connect sign-in (hosted window: embed or popup, from config.json)
//   2. no game authorization -> game.connect(), automatically: it is API-only (SDK README, "Studio game.connect() is
//                               API-only ... connecting never creates a hosted game-authorization URL")
//   3. no credit             -> the buy screen (offer, paying wallet, warning) -> Connect checkout, approved in the wallet
//   4. one credit            -> "Spend 1 credit" consent -> the paid, server-verified run (PaidRound)
// Cancelling any step returns to the overlay with nothing started. When PLAY is pressed with everything ready, the
// priced click itself ("PLAY · 1 CREDIT") is the consent, as in the SDK's own example; when sign-in or a purchase came
// in between, the consent is asked again explicitly.
import { ConnectEmbedUnavailableError, createSuperRareClient, type ConnectEmbedOptions } from '@rareprotocol/connect';
import { accountStorage } from './account-storage.js';
import type { GameAdapter, Stage, StageIO } from './adapter.js';
import { parseConfiguration } from './config.js';
import { Credits, EXPECTED_PACK_CREDITS, packPriceLabel } from './credits.js';
import { describeSdkFailure } from './hosted-flow.js';
import { PaidRound } from './paid-round.js';
import { Practice } from './practice.js';

function requiredElement<ElementType extends HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing interface element: ${selector}`);
  return element;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
const shortAddress = (address: string): string => /^0x[0-9a-f]{40}$/i.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
const DISPLAY_FALLBACK_KEY = 'wall-arcade:connect-display';

const ui = {
  overlay: requiredElement('#overlay'),
  eyebrow: requiredElement('#overlay-eyebrow'),
  title: requiredElement('#overlay-title'),
  line: requiredElement('#overlay-line'),
  score: requiredElement('#overlay-score'),
  actions: requiredElement('#overlay-actions'),
  status: requiredElement('#overlay-status'),
  roundActions: requiredElement('#round-actions'),
  board: requiredElement('#overlay-board'),
  boardList: requiredElement<HTMLOListElement>('#board-list'),
  fine: requiredElement('#overlay-fine'),
  banner: requiredElement('#practice-banner'),
  bannerReal: requiredElement<HTMLButtonElement>('#practice-real'),
  balance: requiredElement<HTMLButtonElement>('#balance-badge'),
  walletButton: requiredElement<HTMLButtonElement>('#wallet-button'),
  walletDot: requiredElement('#wallet-dot'),
  walletPanel: requiredElement<HTMLDialogElement>('#wallet-panel'),
  walletAddress: requiredElement('#wallet-address'),
  signIn: requiredElement<HTMLButtonElement>('#sign-in'),
  signOut: requiredElement<HTMLButtonElement>('#sign-out'),
  authorize: requiredElement<HTMLButtonElement>('#connect'),
  signInStatus: requiredElement('#connect-status'),
  authorizationStatus: requiredElement('#connection-status'),
  buyPanel: requiredElement<HTMLDialogElement>('#buy-panel'),
  buyWallet: requiredElement('#buy-wallet'),
  buyPay: requiredElement<HTMLButtonElement>('#buy-pay'),
  buyStatus: requiredElement('#buy-status'),
  buyRecovery: requiredElement<HTMLButtonElement>('#buy-recovery'),
  connectModal: requiredElement<HTMLDialogElement>('#connect-modal'),
  connectEmbed: requiredElement('#connect-embed'),
  connectStatus: requiredElement('#connect-modal-status'),
  connectClose: requiredElement<HTMLButtonElement>('#connect-close'),
};

type Mode = 'loading' | 'entry' | 'busy' | 'recovery' | 'consent' | 'playing' | 'end' | 'practice' | 'practice-end';
type BoardEntry = { rank: number; score: string; player: { kind: string; displayName: string } };

export async function startApp(adapter: GameAdapter): Promise<void> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load /config.json: HTTP ${response.status}`);
  const configuration = parseConfiguration(await response.json(), location.origin);
  if (configuration.game !== adapter.id) throw new Error(`This archive is built for ${adapter.id}, its config says ${configuration.game}.`);
  document.title = `${adapter.title} · THE WALL ARCADE`;
  // Every price on the page comes from the purchase guard's constants (src/shell/credits.ts): one source of truth.
  requiredElement('#buy-offer').textContent = `${EXPECTED_PACK_CREDITS} plays · ${packPriceLabel()}`;
  requiredElement('#buy-pay').textContent = `Pay ${packPriceLabel()} with SuperRare Connect`;
  requiredElement('#overlay-fine').textContent = `Practice is free. Pay to compete. ${EXPECTED_PACK_CREDITS} plays for ${packPriceLabel()} (Ethereum mainnet, real USDC), one credit per run, shared by every cabinet of the arcade. Prizes are handled manually by the organizer.`;
  requiredElement('#game-title').textContent = adapter.title;
  if (configuration.hubUrl) {
    const hub = requiredElement<HTMLAnchorElement>('#hub-link');
    hub.href = configuration.hubUrl;
    hub.hidden = false;
  }

  /* ---------------------- SuperRare Connect: embed or popup ---------------------- */
  let fallbackToPopup = false;
  try { fallbackToPopup = localStorage.getItem(DISPLAY_FALLBACK_KEY) === 'popup'; } catch { /* storage unavailable */ }
  const display = configuration.display === 'embed' && !fallbackToPopup ? 'embed' : 'popup';
  let frame: HTMLIFrameElement | undefined;
  let reloadOnClose = false;
  const closeConnect = (): void => { if (ui.connectModal.open) ui.connectModal.close(); frame?.remove(); frame = undefined; };
  ui.connectModal.addEventListener('close', () => {
    frame?.remove(); frame = undefined;
    if (reloadOnClose) location.reload();
  });
  ui.connectClose.addEventListener('click', closeConnect);
  const embed: ConnectEmbedOptions = {
    open(url) {
      if (ui.connectModal.open) return null;
      const iframe = document.createElement('iframe');
      iframe.title = 'SuperRare Connect sign-in or checkout';
      iframe.allow = 'payment';
      ui.connectEmbed.replaceChildren(iframe);
      const messageSource = iframe.contentWindow;
      if (messageSource === null) { iframe.remove(); return null; }
      frame = iframe;
      ui.connectStatus.textContent = 'Complete the requested step in SuperRare Connect. Wallet transactions still ask for your explicit approval.';
      ui.connectModal.showModal();
      iframe.src = url;
      return {
        messageSource,
        get closed() { return !iframe.isConnected || !ui.connectModal.open; },
        close() { if (frame === iframe) closeConnect(); else iframe.remove(); },
        location: { replace(next: string) { iframe.src = next; } },
      };
    },
    onUnavailable(error) {
      // The SDK never opens a popup by itself: remember the choice and let the next explicit click use one.
      try { localStorage.setItem(DISPLAY_FALLBACK_KEY, 'popup'); } catch { /* storage unavailable */ }
      reloadOnClose = true;
      const message = `Embedded Connect is not available in this browser (${error.code}). Close this window and press PLAY again: Connect will open in a popup.`;
      ui.connectStatus.textContent = message;
      ui.status.textContent = message;
    },
  };

  let credits: Credits | undefined;
  let readAddress: () => string | undefined = () => undefined;
  const client = createSuperRareClient({
    studioUrl: configuration.studioUrl,
    apiUrl: configuration.apiUrl,
    connectUrl: configuration.connectUrl,
    sessionStorage: accountStorage(localStorage, () => readAddress()),
    ...(display === 'embed' ? { embed } : {}),
    onIntentSettled: (intent) => {
      credits?.onIntentSettled(intent);
      if (['completed', 'failed', 'cancelled', 'expired'].includes(intent.status)) closeConnect();
    },
  });
  readAddress = () => client.auth.getSession()?.address;
  const game = client.games.forGame({ appId: configuration.appId, groupId: configuration.groupId });
  // Scoring reads, server runs and one-time sockets use the hosted game origin, not Studio's cross-origin credit API.
  const scoringGame = createSuperRareClient({
    studioUrl: location.origin,
    apiUrl: configuration.apiUrl,
    connectUrl: configuration.connectUrl,
    sessionStorage: false,
  }).games.forGame({ appId: configuration.appId });
  const storageKey = `studio-games:${encodeURIComponent(configuration.studioUrl)}:${configuration.appId}:${configuration.groupId}`;

  /* ------------------------------ the stage ------------------------------ */
  let practice: Practice | undefined;
  let round: PaidRound | undefined;
  const arena = requiredElement('#arena');
  const io: StageIO = {
    sendInput: (input) => { if (practice?.active) practice.input(input); else round?.userInput(input); },
    canInput: () => (practice?.active ? practice.canInput() : Boolean(round?.canInput())),
    estimatedTick: () => (practice?.active ? practice.tick() : round?.state?.run ? round.estimatedServerTick() : 0),
    pendingCount: () => (practice?.active ? 0 : round?.state?.run?.pendingInputs.length ?? 0),
  };
  const stage = adapter.createStage(arena, io);
  arena.append(ui.overlay, ui.banner);
  // The paid round never touches the stage while a practice run is on screen.
  const roundStage: Stage = {
    setMessage: (text, extra) => { if (!practice?.active) stage.setMessage(text, extra); },
    hideRun: () => { if (!practice?.active) stage.hideRun(); },
    showRun: (view, info) => { if (!practice?.active) stage.showRun(view, info); },
  };

  /* ------------------------------- state -------------------------------- */
  let mode: Mode = 'loading';
  let busy = false;                 // a sign-in / sign-out / authorization call is in flight
  let flowBusy = false;             // the PLAY sequence is running
  let authenticated = false;
  let failedVerification = false;
  let identity = client.auth.getSession()?.address.toLowerCase();
  let expiryTimer: number | undefined;
  let authorizationMessage: string | undefined;
  let verificationGeneration = 0;
  let lastScore: { score: number; practice: boolean } | null = null;
  let board: BoardEntry[] = [];
  let recoveryOffered = false;
  let buyResolve: ((bought: boolean) => void) | null = null;
  let consentResolve: ((yes: boolean) => void) | null = null;

  const session = () => client.auth.getSession();
  const address = (): string | undefined => session()?.address.toLowerCase();
  const validAuthorization = (): boolean => {
    const authorization = game.getAuthorization();
    return Boolean(authorization && authorization.address.toLowerCase() === address());
  };
  const available = (): number => credits?.balance?.available ?? 0;
  const bestKey = (wallet: string): string => `wall-arcade:best:${configuration.appId}:${wallet}`;
  function localBest(wallet: string | undefined): number | null {
    if (!wallet) return null;
    try { const value = Number(localStorage.getItem(bestKey(wallet))); return Number.isFinite(value) && value > 0 ? value : null; } catch { return null; }
  }
  function rememberBest(wallet: string | undefined, score: number): void {
    if (!wallet || (localBest(wallet) ?? -1) >= score) return;
    try { localStorage.setItem(bestKey(wallet), String(score)); } catch { /* storage unavailable */ }
  }

  /* ------------------------------ overlay ------------------------------- */
  function actionButton(label: string, action: () => void, className = ''): HTMLButtonElement {
    const button = node('button', label, className);
    button.type = 'button';
    button.addEventListener('click', action);
    ui.actions.append(button);
    return button;
  }
  function overlay(next: Mode, content: { eyebrow?: string; title?: string; line?: string; status?: string; showBoard?: boolean; end?: boolean; busy?: boolean }): void {
    if (consentResolve && next !== 'consent') { const resolve = consentResolve; consentResolve = null; resolve(false); }
    mode = next;
    if (round) round.viewKind = null;        // the page drew its own screen: the round's next report must get through
    ui.overlay.hidden = false;
    ui.banner.hidden = true;
    ui.overlay.classList.toggle('is-end', Boolean(content.end));
    ui.overlay.classList.toggle('is-busy', Boolean(content.busy));
    ui.eyebrow.textContent = content.eyebrow ?? 'A Remix The Wall experiment';
    ui.title.textContent = content.title ?? adapter.title;
    ui.line.textContent = content.line ?? '';
    ui.line.hidden = !content.line;
    ui.score.hidden = true;
    ui.actions.replaceChildren();
    if (content.status !== undefined) ui.status.textContent = content.status;
    ui.roundActions.hidden = next !== 'recovery';
    ui.board.hidden = content.showBoard === false;
    ui.fine.hidden = next === 'end' || next === 'practice-end';
  }
  function scoreGrid(cells: { label: string; value: string; main?: boolean }[]): void {
    ui.score.replaceChildren(...cells.map(({ label, value, main }) => {
      const cell = node('div', undefined, main ? 'main' : undefined);
      cell.append(node('span', label), node('strong', value));
      return cell;
    }));
    ui.score.hidden = false;
  }
  function hideOverlay(next: Mode): void {
    mode = next;
    ui.overlay.hidden = true;
    ui.banner.hidden = next !== 'practice';
  }

  function showEntry(status?: string): void {
    stage.setMessage('', { idle: true });
    overlay('entry', { line: adapter.tagline ?? adapter.lede, status: status ?? '' });
    actionButton('Play · 1 credit', () => void play(), 'play');
    if (practice?.available) actionButton('Practice · no score', () => startPractice(), 'secondary');
    renderBoard();
  }
  function showBusy(status?: string): void {
    overlay('busy', { line: '', busy: true, showBoard: false, ...(status !== undefined ? { status } : {}) });
  }
  function showRecovery(): void {
    overlay('recovery', { eyebrow: 'Your paid round', line: '' });
    renderBoard();
  }
  function showConsent(): Promise<boolean> {
    overlay('consent', {
      eyebrow: 'One credit per run',
      line: `Spend 1 credit to start a server-verified run? You have ${available()} credit${available() === 1 ? '' : 's'}.`,
      status: '',
      showBoard: false,
    });
    return new Promise((resolve) => {
      consentResolve = resolve;
      actionButton('Spend 1 credit · start', () => { consentResolve = null; resolve(true); }, 'play');
      actionButton('Cancel', () => { consentResolve = null; resolve(false); }, 'secondary');
    });
  }
  function endActions(): void {
    ui.actions.replaceChildren();
    if (mode === 'practice-end') {
      actionButton('Play for real · 1 credit', () => void play(), 'play');
      actionButton('Practice again', () => startPractice(), 'secondary');
      return;
    }
    if (authenticated && credits?.balance && available() < 1) actionButton('Buy credits', () => void play(true), 'play');
    else actionButton('Play again · 1 credit', () => void play(), 'play');
    if (practice?.available) actionButton('Practice · no score', () => startPractice(), 'secondary');
  }
  function showEnd(score: number): void {
    const wallet = address();
    rememberBest(wallet, score);
    overlay('end', { eyebrow: 'Server-verified · recorded by SuperRare', title: 'Run over', line: '', status: '', end: true });
    const mine = myEntry(wallet);
    const best = Math.max(score, localBest(wallet) ?? 0, mine ? Number(mine.score) : 0);
    scoreGrid([
      { label: 'Score', value: String(score), main: true },
      { label: 'Rank', value: mine ? `#${mine.rank}` : '—' },
      { label: mine ? 'Best' : 'Best · this device', value: String(best) },
    ]);
    endActions();
    renderBoard();
    // The leaderboard may take a moment to include the run that just ended: read it again, then fill the rank in.
    const update = (fresh: boolean): void => { if (mode === 'end' && lastScore?.score === score && !lastScore.practice) refreshEndGrid(score, fresh); };
    void loadBoard().then(update);
    window.setTimeout(() => { void loadBoard().then(update); }, 3000);
  }
  function myEntry(wallet: string | undefined): BoardEntry | undefined {
    return wallet ? board.find((entry) => entry.player.kind === 'wallet' && entry.player.displayName.toLowerCase() === wallet) : undefined;
  }
  function refreshEndGrid(score: number, fresh: boolean): void {
    const wallet = address();
    const mine = myEntry(wallet);
    const best = Math.max(score, localBest(wallet) ?? 0, mine ? Number(mine.score) : 0);
    scoreGrid([
      { label: 'Score', value: String(score), main: true },
      { label: 'Rank', value: mine ? `#${mine.rank}` : fresh && score < Number(board.at(-1)?.score ?? 0) && board.length >= 10 ? 'Not top 10' : '—' },
      { label: mine ? 'Best' : 'Best · this device', value: String(best) },
    ]);
  }
  function showPracticeEnd(score: number): void {
    overlay('practice-end', { eyebrow: "Practice · scores don't count", title: 'Practice over', line: '', status: '', end: true });
    const best = localBest(address());
    scoreGrid([
      { label: 'Practice score', value: String(score), main: true },
      { label: 'Recorded', value: 'No' },
      { label: 'Your best (real)', value: best === null ? '—' : String(best) },
    ]);
    endActions();
    renderBoard();
  }

  /* ----------------------------- leaderboard ---------------------------- */
  function renderBoard(): void {
    const wallet = address();
    const top = board.slice(0, 5);
    if (!top.length) {
      ui.boardList.replaceChildren(node('li', boardFailed ? 'Scores could not be loaded right now.' : boardLoaded ? 'No server-verified score yet. Be the first.' : 'Loading scores…', 'empty'));
      return;
    }
    ui.boardList.replaceChildren(...top.map((entry) => {
      const item = node('li', undefined, entry.player.kind === 'wallet' && entry.player.displayName.toLowerCase() === wallet ? 'me' : undefined);
      const name = entry.player.kind === 'wallet' ? shortAddress(entry.player.displayName) : entry.player.displayName;
      const who = node('span', name);
      who.title = entry.player.displayName;
      item.append(node('span', String(entry.rank), 'rank'), who, node('span', entry.score));
      return item;
    }));
  }
  let boardLoaded = false;
  let boardFailed = false;
  async function loadBoard(): Promise<boolean> {
    let fresh = false;
    try {
      board = await scoringGame.getServerLeaderboard() as BoardEntry[];
      boardLoaded = true;
      boardFailed = false;
      fresh = true;
    } catch {
      boardFailed = !board.length;
    }
    renderBoard();
    return fresh;
  }

  /* -------------------------------- bar --------------------------------- */
  function renderBar(): void {
    const balance = credits?.balance;
    ui.balance.textContent = !session() ? 'Sign in' : balance ? `${balance.available} credit${balance.available === 1 ? '' : 's'}` : '— credits';
    ui.walletDot.hidden = !credits?.pendingPurchase();
  }

  /* --------------------------- wallet panel ----------------------------- */
  function renderAuth(): void {
    const current = session();
    ui.walletAddress.textContent = current ? current.address : 'Not signed in';
    ui.signIn.hidden = authenticated;
    ui.signIn.textContent = failedVerification ? 'Retry Connect session check' : 'Sign in to SuperRare';
    ui.signIn.disabled = busy || flowBusy;
    ui.signOut.hidden = !current;
    ui.signOut.disabled = busy || flowBusy;
    const valid = validAuthorization();
    ui.authorize.hidden = !authenticated || valid;
    ui.authorize.disabled = busy || flowBusy;
    ui.authorizationStatus.textContent = authorizationMessage ?? (authenticated && !valid
      ? 'This game is not authorized for your wallet yet; it is done automatically when you press PLAY.' : '');
    window.clearTimeout(expiryTimer);
    const expiries = [current?.expiresAt, game.getAuthorization()?.expiresAt]
      .filter((value): value is string => value !== undefined)
      .map(Date.parse).filter((value) => Number.isFinite(value) && value > Date.now());
    if (expiries.length) expiryTimer = window.setTimeout(() => { void verifySession(); }, Math.min(Math.min(...expiries) - Date.now(), 2_147_483_647));
    renderBar();
  }
  function openWallet(recovery = false): void {
    if (!ui.walletPanel.open) ui.walletPanel.showModal();
    if (recovery) credits?.openRecovery();
    void credits?.refresh();
  }
  for (const panel of [ui.walletPanel, ui.buyPanel]) {
    panel.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', () => panel.close());
  }
  ui.walletButton.addEventListener('click', () => openWallet());
  ui.balance.addEventListener('click', () => openWallet());

  /* ----------------------------- buy screen ----------------------------- */
  function openBuy(): Promise<boolean> {
    ui.buyWallet.textContent = address() ?? 'your signed-in wallet';
    ui.buyStatus.textContent = '';
    ui.buyRecovery.hidden = true;
    ui.buyPay.disabled = false;
    if (ui.walletPanel.open) ui.walletPanel.close();
    if (!ui.buyPanel.open) ui.buyPanel.showModal();
    return new Promise((resolve) => { buyResolve = resolve; });
  }
  ui.buyPanel.addEventListener('close', () => {
    const resolve = buyResolve;
    buyResolve = null;
    resolve?.(available() >= 1);
  });
  ui.buyPay.addEventListener('click', async () => {
    if (!credits) return;
    ui.buyPay.disabled = true;
    try { await credits.buyNow(); } finally { ui.buyPay.disabled = false; }
  });
  ui.buyRecovery.addEventListener('click', () => { ui.buyPanel.close(); openWallet(true); });

  /* ------------------------ credits and paid round ---------------------- */
  credits = new Credits({
    client, game, root: requiredElement('#credits'), storageKey: `${storageKey}:purchase`,
    changed: () => {
      renderAuth();
      if (ui.buyPanel.open && available() >= 1) {
        ui.buyStatus.textContent = `Credits received: you have ${available()}.`;
        window.setTimeout(() => { if (ui.buyPanel.open) ui.buyPanel.close(); }, 700);
      }
      if (mode === 'end') endActions();
      void round?.refresh();
    },
    onBuyRequested: () => { void openBuy(); },
    onStatus: (message, hint) => {
      if (ui.buyPanel.open) ui.buyStatus.textContent = message;
      if (hint?.recovery) ui.buyRecovery.hidden = false;
      renderBar();
    },
  });
  const creditPanel = credits;

  round = new PaidRound({
    game, scoringGame, adapter, root: null, stage: roundStage,
    storageKey: `${storageKey}:round`,
    nodes: { status: ui.status, actions: ui.roundActions, score: requiredElement('#round-score') },
    getBalance: async () => { await creditPanel.refresh(); renderBar(); return creditPanel.balance; },
    getAddress: () => client.auth.getSession()?.address,
    onView: (kind: string, detail: { score?: number }) => {
      if (practice?.active) return;
      if (kind === 'playing') {
        if (mode !== 'playing') void creditPanel.refresh().then(renderBar);     // the credit just spent
        hideOverlay('playing');
        return;
      }
      if (kind === 'busy') { if (mode !== 'consent') showBusy(); return; }
      if (kind === 'recovery') { if (mode !== 'consent') showRecovery(); return; }
      if (kind === 'finished' && typeof detail.score === 'number') {
        lastScore = { score: detail.score, practice: false };
        showEnd(detail.score);
        return;
      }
      if (kind === 'ready' || kind === 'signed-out') {
        if (flowBusy || mode === 'end' || mode === 'practice-end' || mode === 'consent') return;
        showEntry(mode === 'busy' || mode === 'playing' ? ui.status.textContent ?? '' : undefined);
      }
    },
  });
  const paidRound = round;

  practice = new Practice(adapter, stage, (score) => {
    lastScore = { score, practice: true };
    showPracticeEnd(score);
  });
  function startPractice(): void {
    if (flowBusy || !practice?.available) return;
    paidRound.disconnectRun();
    hideOverlay('practice');
    practice.start();
  }
  ui.bannerReal.addEventListener('click', () => {
    practice?.stop();
    void play(true);
  });

  creditPanel.render();
  paidRound.render();

  async function refreshPanels(): Promise<void> {
    await creditPanel.refresh();
    await paidRound.refresh();
    renderAuth();
    // A purchase whose money may already have moved is shown once, without being asked.
    const record = creditPanel.record;
    if (!recoveryOffered && record && creditPanel.pendingPurchase() && (record.intentId || record.transactionHash || record.outcomeUnknown)) {
      recoveryOffered = true;
      openWallet(true);
    }
  }

  /* ------------------------------ sign-in ------------------------------- */
  async function signIn(): Promise<boolean> {
    if (failedVerification && session()) { await verifySession(); return authenticated; }
    ui.signInStatus.textContent = display === 'embed' ? 'SuperRare Connect sign-in is open.' : 'Opening SuperRare Connect sign-in in a popup…';
    try {
      const result = await client.auth.login();
      closeConnect();
      authenticated = result.status === 'authenticated';
      failedVerification = false;
      ui.signInStatus.textContent = authenticated ? `Signed in as ${session()?.address}.` : `Sign-in ${result.status}. Nothing was started.`;
      return authenticated;
    } catch (error) {
      closeConnect();
      if (error instanceof ConnectEmbedUnavailableError) {
        try { localStorage.setItem(DISPLAY_FALLBACK_KEY, 'popup'); } catch { /* storage unavailable */ }
        ui.signInStatus.textContent = 'Embedded sign-in is not available in this browser. Reloading: press PLAY again to sign in with a popup.';
        window.setTimeout(() => location.reload(), 1200);
        return false;
      }
      ui.signInStatus.textContent = `Sign-in failed (${describeSdkFailure(error)}). Nothing was started.`;
      return false;
    }
  }
  /** game.connect() is an API call (no hosted screen): done automatically after sign-in. */
  async function authorize(): Promise<boolean> {
    if (validAuthorization()) return true;
    authorizationMessage = undefined;
    try {
      const authorization = await game.connect();
      if (authorization.address.toLowerCase() !== address()) {
        throw new Error('Game authorization does not belong to the signed-in wallet. Sign out and reconnect.');
      }
      return true;
    } catch (error) {
      authorizationMessage = `Game authorization failed (${describeSdkFailure(error)}). Nothing was started.`;
      return false;
    }
  }

  /* -------------------------------- PLAY -------------------------------- */
  /** `askConsent`: the button pressed did not show the price, so the "spend 1 credit" step is always asked. */
  async function play(askConsent = false): Promise<void> {
    if (flowBusy || busy) return;
    flowBusy = true;
    const back = (message: string): void => { flowBusy = false; renderAuth(); showEntry(message); };
    try {
      if (practice?.active) practice.stop();
      if (paidRound.state && !['completed', 'terminal'].includes(paidRound.state.phase)) {
        flowBusy = false;
        await paidRound.recover();
        return;
      }
      if (!authenticated) {
        showBusy('Sign in with SuperRare Connect to play.');
        if (!(await signIn())) { back(ui.signInStatus.textContent || 'Sign-in cancelled. Nothing was started.'); return; }
        askConsent = true;
      }
      showBusy('Connecting this game to your wallet…');
      if (!(await authorize())) { back(authorizationMessage ?? 'Game authorization failed. Nothing was started.'); return; }
      await creditPanel.refresh();
      // The authorization may be new: the round must look again for this wallet's saved play before anything starts.
      await paidRound.refresh();
      renderAuth();
      if (paidRound.state && !['completed', 'terminal'].includes(paidRound.state.phase)) {
        flowBusy = false;
        await paidRound.recover();
        return;
      }
      if (!creditPanel.balance) { back('Your credit balance could not be loaded. Try again.'); return; }
      if (available() < 1) {
        if (creditPanel.pendingPurchase() && !creditPanel.record?.confirmPayment) {
          back('A purchase is still being confirmed. Open the wallet menu to finish it.');
          openWallet(true);
          return;
        }
        showBusy('Buy credits to play.');
        if (!(await openBuy())) {
          back(creditPanel.pendingPurchase() && !creditPanel.record?.confirmPayment
            ? 'Your purchase is still being confirmed. The wallet menu shows where it stands; nothing was started.'
            : 'No credit was bought. Nothing was started.');
          return;
        }
        askConsent = true;
      }
      if (askConsent && !(await showConsent())) { back('Nothing was started. Your credits are unchanged.'); return; }
      flowBusy = false;
      showBusy('Starting your server-verified run…');
      await paidRound.prepareRound(1);
    } catch (error) {
      back(`Could not start: ${describeSdkFailure(error)}. Nothing was charged.`);
    } finally {
      flowBusy = false;
      renderAuth();
    }
  }

  /* --------------------------- session checks --------------------------- */
  async function verifySession(): Promise<void> {
    const generation = ++verificationGeneration;
    const currentIdentity = address();
    if (identity !== undefined && currentIdentity !== identity) { location.reload(); return; }
    if (!session()) {
      authenticated = false;
      failedVerification = false;
      ui.signInStatus.textContent = 'Not signed in. PLAY signs you in with SuperRare Connect; nothing is paid or started automatically.';
      renderAuth();
      await refreshPanels();
      return;
    }
    busy = true;
    renderAuth();
    ui.signInStatus.textContent = 'Verifying the saved Connect session…';
    try {
      const remote = await client.auth.getRemoteSession();
      if (generation !== verificationGeneration) return;
      authenticated = remote.authenticated;
      failedVerification = !remote.authenticated;
      ui.signInStatus.textContent = remote.authenticated
        ? ''
        : 'The saved session is no longer authenticated. Sign out, then sign in again; saved purchases and rounds are preserved.';
      if (authenticated) await authorize();
      await refreshPanels();
    } catch (error) {
      if (generation !== verificationGeneration) return;
      authenticated = false;
      failedVerification = true;
      ui.signInStatus.textContent = `Session verification failed (${describeSdkFailure(error)}). Credentials and saved recovery records were preserved.`;
    } finally {
      if (generation === verificationGeneration) { busy = false; renderAuth(); }
    }
  }

  const unsubscribe = client.auth.onChange((next) => {
    const nextIdentity = next?.address.toLowerCase();
    if (identity !== undefined && identity !== nextIdentity) {
      // Discard in-memory game state on wallet replacement, not saved credentials or any wallet's recovery records.
      location.reload();
      return;
    }
    identity = nextIdentity;
    authenticated = Boolean(next && Date.parse(next.expiresAt) > Date.now());
    renderAuth();
    void refreshPanels();
  });

  ui.signIn.addEventListener('click', async () => {
    if (busy || flowBusy) return;
    busy = true;
    renderAuth();
    try { if (await signIn()) await authorize(); await refreshPanels(); } finally { busy = false; renderAuth(); }
  });
  ui.authorize.addEventListener('click', async () => {
    if (busy || flowBusy || !authenticated) return;
    busy = true;
    renderAuth();
    try { await authorize(); await refreshPanels(); } finally { busy = false; renderAuth(); }
  });
  ui.signOut.addEventListener('click', async () => {
    if (busy || flowBusy) return;
    busy = true;
    renderAuth();
    try { await client.auth.logout(); }
    catch (error) { ui.signInStatus.textContent = `Sign-out failed (${describeSdkFailure(error)}). Saved records remain intact.`; }
    finally { busy = false; renderAuth(); }
  });
  window.addEventListener('storage', () => { void verifySession(); });
  window.addEventListener('pagehide', () => {
    unsubscribe();
    window.clearTimeout(expiryTimer);
    paidRound.disconnectRun();
    practice?.stop();
  }, { once: true });

  if (mode === 'loading') showEntry();
  (window as unknown as { __arcadeBoot?: string }).__arcadeBoot = 'ready';      // the page is up: the boot guard stands down
  void loadBoard();
  await verifySession();
}

export function startAppSafely(adapter: GameAdapter): void {
  void startApp(adapter).catch((error: unknown) => {
    (window as unknown as { __arcadeBoot?: string }).__arcadeBoot = 'ready';    // this overlay explains the failure itself
    ui.overlay.hidden = false;
    ui.actions.replaceChildren();
    ui.title.textContent = adapter.title;
    ui.status.textContent = `This cabinet could not start: ${describeSdkFailure(error)}`;
  });
}
