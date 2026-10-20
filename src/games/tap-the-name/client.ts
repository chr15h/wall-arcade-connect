// TAP THE NAME: the browser side. The stage draws the question the server issued (or the prediction of it) and turns
// a tap into one ordered input. It never decides what is correct or what a score is: the verifier does.
import type { GameAdapter, Stage, StageIO } from '../../shell/adapter.js';
import { createSavedRoundParser } from '../../shell/saved-round.js';
import { HitFeed } from '../../shell/hits.js';
import { nameOf } from '../../shell/wall-data.js';
import { diag } from '../../shell/diagnostics.js';
import { TAP_POOL } from '../../generated/wall.js';
import { createEngine, inputSchema, snapshotSchema, stateSchema, TICK_MS, type TapQuestion, type TapState } from './engine.js';

const engine = createEngine(TAP_POOL);

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createStage(host: HTMLElement, io: StageIO): Stage {
  const hits = new HitFeed('tap-the-name-connect');
  host.classList.add('tap-arena');
  host.replaceChildren();

  const run = node('div', 'tap-run');
  const hud = node('div', 'tap-hud'); hud.append(node('span', undefined, 'STREAK'));
  const streak = node('strong', 'tap-streak', '0'); hud.append(streak);
  const timer = node('div', 'tap-timer'); const fill = node('div', 'tap-timer-fill'); timer.append(fill);
  const prompt = node('div', 'tap-prompt'); prompt.append(node('div', 'tap-label', 'FIND THIS NAME'));
  const promptName = node('div', 'tap-name', '—'); prompt.append(promptName);
  const options = node('div', 'tap-options');
  run.append(hud, timer, prompt, options);
  run.hidden = true;
  const message = node('p', 'stage-message', 'Start a round to play.');
  host.append(run, message);

  let builtFor = -1;                       // the question id the option buttons were built for
  let tapped: number | null = null;        // what the player pressed on the last question (display only)
  let seenScore = 0;

  function build(question: TapQuestion): void {
    builtFor = question.id;
    tapped = null;
    promptName.textContent = nameOf(question.target) || `PANEL #${question.target}`;
    promptName.style.animation = 'none'; void promptName.offsetWidth; promptName.style.animation = '';
    options.replaceChildren();
    for (const position of question.options) {
      const button = node('button', 'tap-option', nameOf(position) || `PANEL #${position}`);
      button.type = 'button';
      button.dataset.pos = String(position);
      button.addEventListener('click', () => {
        diag.add('click', { questionId: question.id, pos: position, name: button.textContent, target: question.target, targetName: promptName.textContent,
          correctByName: button.textContent === promptName.textContent, startTick: question.startTick, deadlineTick: question.deadlineTick,
          estTick: io.estimatedTick(), canInput: io.canInput(), pending: io.pendingCount() });
        if (!io.canInput()) return;
        tapped = position;
        io.sendInput({ action: 'choose', questionId: question.id, pos: position });
      });
      options.append(button);
    }
  }
  function lock(question: TapQuestion | null, over: boolean): void {
    for (const button of options.querySelectorAll<HTMLButtonElement>('button')) {
      const pos = Number(button.dataset.pos);
      button.disabled = over || question === null || !io.canInput();
      button.classList.toggle('correct', over && question !== null && pos === question.target);
      button.classList.toggle('wrong', over && tapped !== null && pos === tapped && question !== null && pos !== question.target);
    }
  }

  return {
    setMessage(text: string): void {
      run.hidden = true; message.hidden = false; message.textContent = text;
      hits.flush();
    },
    hideRun(): void { run.hidden = true; },
    showRun(authoritative: TapState, info): void {
      // the authoritative state is as of the last snapshot (plus the player's queued answers): bring it to "now"
      const view = info.tick > authoritative.tick ? engine.advance(authoritative, info.tick) : authoritative;
      run.hidden = false; message.hidden = true;
      streak.textContent = String(view.score);
      if (view.score > seenScore && view.lastTarget !== null) hits.add(view.lastTarget);
      seenScore = Math.max(seenScore, view.score);
      const question = view.question;
      if (question && question.id !== builtFor) build(question);
      const open = question !== null && info.tick >= question.startTick && !view.gameOver;
      if (question === null) {                                   // short pause after a correct answer
        promptName.textContent = '—'; options.replaceChildren(); builtFor = -1; fill.style.width = '0%';
      } else if (open) {
        const span = Math.max(1, question.deadlineTick - question.startTick);
        const left = Math.max(0, Math.min(1, (question.deadlineTick - info.tick) / span));
        fill.style.width = `${(left * 100).toFixed(1)}%`;
        fill.classList.toggle('danger', left < 0.35);
      }
      lock(question, view.gameOver);
      if (view.gameOver) hits.flush();
    },
  };
}

export const tapAdapter: GameAdapter = {
  id: 'tap-the-name',
  title: 'TAP THE NAME',
  heading: 'Find the name',
  lede: 'A real name of the wall flashes among three decoys. Tap it before the timer runs out: every right answer shortens the next timer. One wrong tap or one timeout ends the run. Each run costs one credit.',
  stateSchema: stateSchema as never,
  snapshotSchema: snapshotSchema as never,
  parseSavedRound: createSavedRoundParser(stateSchema as never, inputSchema as never),
  applyInput: (state: TapState, input: unknown, tick: number) => engine.applyInput(state, input, tick),
  scoreOf: (state: TapState) => state.score,
  statusLine(state: TapState, tick: number): string {
    if (state.gameOver) return 'Waiting for the platform’s recorded result…';
    if (!state.started) return 'Starting your server-validated round…';
    const question = state.question;
    if (!question) return `Streak ${state.score}`;
    const left = Math.max(0, question.deadlineTick - tick) * TICK_MS / 1000;
    return `Streak ${state.score} · ${left.toFixed(1)}s`;
  },
  createStage,
  diagSummary: (s: TapState) => ({
    tick: s.tick, started: s.started, startTick: s.startTick, score: s.score, last: s.last, gameOver: s.gameOver, nextRoundAt: s.nextRoundAt,
    q: s.question ? { id: s.question.id, start: s.question.startTick, deadline: s.question.deadlineTick, target: s.question.target, options: s.question.options } : null,
  }),
};
