// The hub's PEOPLE section, token-gated: ADD YOURSELF only for a player signed in with SuperRare Connect whose wallet
// holds a name of the wall (the wall's owners, as for the 3 free plays). Bundled by scripts/build-hub.ts as
// people-gate.js. The Sprite Party capture link is never in the page: the card service gives it, with the wallet's
// names, to a holder (/people/capture); anyone else keeps the line "People of the wall only." and SIGN IN.
// Sign-in only: no game authorization, no credit, no payment on this page. Connect opens in a popup on the click.
import { ConnectPopupBlockedError, createSuperRareClient } from '@rareprotocol/connect';

const CARDS = 'https://wall-arcade-cards.netlify.app';
const CAPTURE = /^https:\/\/www\.spriteparty\.com\/p\/[A-Za-z0-9_-]+\/capture$/;
type Capture = { url: string; names: { name: string; panel: number; character: boolean }[] };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const out = $('gateOut'), inside = $('gateIn'), signIn = $<HTMLButtonElement>('signIn'), status = $('gateStatus');
const add = $<HTMLAnchorElement>('addYourself'), myName = $('myName'), hint = $('gateHint');

const client = createSuperRareClient({ studioUrl: 'https://studio.superrare.com', apiUrl: 'https://api.superrare.com', connectUrl: 'https://connect.superrare.com' });
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function captureFor(wallet: string): Promise<Capture | null> {
  const response = await fetch(`${CARDS}/people/capture?wallet=${wallet}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json() as Capture;
  if (typeof data?.url !== 'string' || !CAPTURE.test(data.url) || !Array.isArray(data.names) || !data.names.length) throw new Error('unexpected answer');
  return data;
}

/** Shows the section for whoever is signed in: a holder gets their name, the button and the instruction. */
async function render(): Promise<void> {
  const wallet = client.auth.getSession()?.address.toLowerCase();
  inside.hidden = true; out.hidden = false; add.removeAttribute('href');
  if (!wallet) { status.textContent = ''; return; }
  status.textContent = 'Checking your wallet…';
  try {
    const capture = await captureFor(wallet);
    if (client.auth.getSession()?.address.toLowerCase() !== wallet) return;
    if (!capture) { status.textContent = `${short(wallet)} holds no name of the wall.`; return; }
    const name = (capture.names[0] as Capture['names'][number]).name;
    myName.textContent = name;
    hint.textContent = `Type exactly ${name} as your Player name. Skip the email, we already know you.`;
    add.href = capture.url;
    out.hidden = true; inside.hidden = false; status.textContent = '';
  } catch {
    status.textContent = 'Your wallet could not be checked. Try again in a minute.';
  }
}

// prepared when the section comes into view, so the tap opens Connect at once (iOS keeps a blank window otherwise)
let prepared = false;
new IntersectionObserver((entries, observer) => {
  if (!entries.some((e) => e.isIntersecting) || prepared || client.auth.getSession()) return;
  prepared = true; observer.disconnect();
  void client.auth.prepareLogin().catch(() => { prepared = false; });
}).observe($('people'));

signIn.addEventListener('click', async () => {
  signIn.disabled = true;
  status.textContent = 'SuperRare Connect is open in a popup.';
  try {
    if (client.auth.getSession()) await client.auth.logout().catch(() => client.auth.clearSession());   // another wallet
    const result = await client.auth.login();
    if (result.status !== 'authenticated') status.textContent = `Sign-in ${result.status}.`;
    await render();
  } catch (error) {
    status.textContent = error instanceof ConnectPopupBlockedError ? 'Allow pop-ups for this page, then press SIGN IN again.' : 'Sign-in failed. Try again.';
  } finally {
    signIn.disabled = false;
  }
});
void render();
