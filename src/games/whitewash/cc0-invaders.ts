// CC0 INVADERS: the invader game with other CC0 collections (Nouns, CrypToadz, mfers); a fan-made game, affiliated
// with none of them. Same rules and verifier as NFT INVADERS.
import { AIPORIUM, INVADERS_RULES, invadersAdapter } from './client.js';
import { CC0_ART } from './art-cc0.js';

export const cc0InvadersAdapter = invadersAdapter({
  id: 'cc0-invaders', title: 'CC0 INVADERS', feed: 'cc0-invaders', art: CC0_ART, by: AIPORIUM,
  heading: 'Keep the invaders off the names',
  tagline: 'Nouns, toadz and mfers invade the wall: down them before they whitewash its names.',
  lede: 'Eight names of the wall stand behind the dragon. Invaders sway in formation and dive at a name to whitewash it, a different CC0 collection each wave: Nouns, CrypToadz, mfers and XCOPY (a fan-made game, affiliated with none of them). Move the dragon left and right: it sprays by itself. An invader downed mid-dive pays triple, and every 8 downed without losing a name raise the multiplier, up to ×4. Down a whole wave for a bonus on every name still standing and one name repainted. Lose all eight and the run is over. Three minutes on the server clock, one credit per run.',
  howTo: [
    { title: 'How to play', text: 'Waves of Nouns, CrypToadz and mfers dive at the eight names of the wall along the bottom. Keep them off: a name an invader reaches gets whitewashed.' },
    ...INVADERS_RULES,
    { title: 'The art', text: 'Each wave is a different CC0 collection, in turn: Nouns (their on-chain artwork, by Nouns DAO), MAX PAIN AND FRENS by XCOPY, CrypToadz (by Gremplin), TRAITORS by XCOPY, mfers (by sartoshi) and early works by XCOPY. Their creators dedicated them to the public domain (CC0; XCOPY: “XCOPY works are licensed under CC0 (Public Domain)”, xcopy.art/creative-commons), which lets anyone use them; it does not mean they are involved. CC0 INVADERS is a fan-made game: it is not made by, endorsed by or affiliated with any of these projects or their creators.' },
  ],
});
