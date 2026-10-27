// GET /stats: the numbers of cards/src/stats.ts for John, on a phone, in French. One page, not linked from anywhere;
// the three windows (today, this week, since the launch) are all in it and switched in the page. Lisbon time.
import { GAME_KEYS, TITLES, type PlayRow, type Stats } from './stats.js';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const n = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));
const p = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')} %`);
const time = (iso: string): string => new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Lisbon', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const dayLabel = (day: string): string => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${day}T12:00:00Z`));

type Win = Stats['windows'][string] & Record<string, any>;

function playsTable(w: Win): string {
  const row = (label: string, r: PlayRow, total = false): string => `<tr${total ? ' class="tot"' : ''}><th>${label}</th><td class="big">${n(r.started)}</td><td>${n(r.completed)}</td><td>${n(r.abandoned)}</td><td>${n(r.free)}</td><td>${n(r.paid)}</td><td>${n(r.practice)}</td></tr>`;
  const t = w.plays.total as PlayRow;
  const notes: string[] = [];
  if (!t.official) notes.push('Rapport SuperRare indisponible : commencées et terminées viennent de nos balises.');
  else if (t.diff) notes.push(`Nos balises comptent ${n(t.tagged.started)} parties commencées (écart ${t.diff > 0 ? '+' : ''}${t.diff} avec le rapport SuperRare).`);
  if (t.unattributed) notes.push(`${n(t.unattributed)} partie${t.unattributed > 1 ? 's' : ''} sans wallet connu (avant les balises, ou balise perdue) : ni gratuite ni payante.`);
  return `<div class="scroll"><table><thead><tr><th></th><th>Commencées</th><th>Terminées</th><th>Abandonnées</th><th>Gratuites</th><th>Payantes</th><th>Practice</th></tr></thead><tbody>
${GAME_KEYS.map((g) => row(TITLES[g], w.plays.games[g])).join('')}${row('Total', t, true)}</tbody></table></div>
${notes.map((x) => `<p class="note">${esc(x)}</p>`).join('')}`;
}

const tile = (label: string, value: string, sub = ''): string => `<div class="tile"><span class="lbl">${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

function windowBlock(key: string, w: Win, s: Stats): string {
  const pl = w.players, m = w.money, sh = w.share, ar = w.artists;
  const boards = GAME_KEYS.map((g) => {
    const b = pl.leaderboards[g];
    return `<div class="board"><span class="lbl">${TITLES[g]} · top 3</span>${b && b.top3.length ? `<ol>${b.top3.map((r: { name: string; score: number }) => `<li>${esc(r.name)} <i>${n(r.score)}</i></li>`).join('')}</ol><small>${n(b.players)} joueur${b.players > 1 ? 's' : ''} au classement</small>` : '<p class="note">Personne encore.</p>'}</div>`;
  }).join('');
  return `<div class="win" data-win="${key}"${key === 'today' ? '' : ' hidden'}>
<h2>Parties</h2>${playsTable(w)}
<h2>Joueurs</h2><div class="tiles">
${tile('Wallets', n(pl.wallets))}${tile('Holders', n(pl.holders))}${tile('Non-holders', n(pl.nonHolders))}
${tile('Nouveaux aujourd’hui', n(pl.newToday))}${tile('Revenus (2 jours +)', n(pl.returning))}
${tile('Parties par joueur', pl.playsPerPlayer ? String(pl.playsPerPlayer.avg).replace('.', ',') : '—', pl.playsPerPlayer ? `max ${pl.playsPerPlayer.max}` : '')}
</div><div class="boards">${boards}</div>
<h2>Argent</h2><div class="tiles">
${tile('Packs achetés', n(m.packs), `${String(m.eth).replace('.', ',')} ETH`)}${tile('Conversion', p(m.conversion), 'acheteurs / joueurs payants')}${tile('Clics « Pay »', n(m.buyClicks))}
</div>${m.buyers.length ? `<ul class="list">${m.buyers.map((b: { name: string; at: string; eth: number }) => `<li>${esc(b.name)} <i>${time(b.at)} · ${String(b.eth).replace('.', ',')} ETH</i></li>`).join('')}</ul>` : ''}
<h2>Partage</h2><div class="tiles">
${tile('Cartes créées', n(sh.cards))}${tile('POST ON X', n(sh.postOnX))}${tile('Vues /r/', n(sh.cardViews))}${tile('Venues de X', n(sh.fromX), sh.clicksPerCard === null ? '' : `${String(sh.clicksPerCard).replace('.', ',')} par carte`)}
</div>
<h2>Artistes</h2><div class="tiles">
${tile('Vues builders', n(ar.buildersViews))}${tile('MAKE MY GAME', n(ar.makeMyGame))}${tile('COPY THE KIT', n(ar.copyKit))}${tile('Vues assets', n(ar.assetsViews))}${tile('Téléchargements kit', n(ar.kitDownloads))}
</div><p class="note">Les DM reçus ne sont pas comptés ici.</p>
<h2>Hub</h2><div class="tiles">
${tile('Vues du hub', n(w.hub.views))}${tile('Clics PLAY', n(w.hub.clickPlay))}${tile('SIGN IN (People)', n(w.hub.peopleSignIn))}${tile('ADD YOURSELF', n(w.hub.addYourself))}
</div>
</div>`;
}

export function statsPage(s: Stats): string {
  const wins = s.windows as Record<string, Win>;
  const maxHour = Math.max(1, ...s.hours.map((h) => h.paid + h.practice));
  const hours = s.hours.map((h) => `<div class="bar" title="${h.hour} h : ${h.paid} payantes, ${h.practice} practice"><i style="height:${Math.round(((h.paid) / maxHour) * 100)}%"></i><u style="height:${Math.round((h.practice / maxHour) * 100)}%"></u><span>${h.hour % 3 === 0 ? h.hour : ''}</span></div>`).join('');
  const sources = Object.entries(s.sources).filter(([, v]) => v !== 'ok');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Arcade Stats</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--paper:#FBF8EC;--ink:#14161F;--blue:#3F4BA2;--yellow:#FFF8A7;--grey:#464A5E;--anton:Anton,Impact,sans-serif;--mono:'IBM Plex Mono',ui-monospace,monospace}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{margin:0;background:var(--paper);color:var(--ink)}
body{font:400 14px/1.45 var(--mono);-webkit-font-smoothing:antialiased;padding:0 16px 64px;max-width:860px;margin:0 auto;overflow-x:hidden}
h1,h2{font-family:var(--anton);font-weight:400;text-transform:uppercase;letter-spacing:-.01em;margin:0}
h1{font-size:clamp(36px,9vw,56px);line-height:1;padding-top:24px}
h2{font-size:28px;margin:36px 0 12px;border-top:2px solid var(--blue);padding-top:14px}
.lbl{font:500 11px/1.3 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--grey)}
.meta{color:var(--grey);font-size:12px;margin:6px 0 16px}
.tabs{position:sticky;top:0;z-index:5;background:var(--paper);display:flex;gap:6px;padding:10px 0;border-bottom:2px solid var(--blue)}
.tabs button{flex:1;min-height:44px;border:2px solid var(--blue);background:var(--paper);color:var(--blue);font:600 12px/1.1 var(--mono);letter-spacing:.06em;text-transform:uppercase;cursor:pointer;padding:6px}
.tabs button[aria-pressed=true]{background:var(--blue);color:var(--paper)}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
@media (min-width:620px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}}
.tile{border:2px solid var(--ink);padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}
.tile b{font:400 34px/1.05 var(--anton);overflow-wrap:anywhere}
.tile small{color:var(--grey);font-size:11px}
.now .tile{background:var(--yellow)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:2px solid var(--ink)}
table{border-collapse:collapse;width:100%;min-width:560px}
th,td{padding:8px 10px;text-align:right;border-bottom:1px solid #14161F22;white-space:nowrap}
thead th{font:500 10px/1.2 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--grey)}
tbody th{text-align:left;font-weight:600}
td.big{font:400 22px/1 var(--anton)}
tr.tot{background:var(--yellow)}
.note{color:var(--grey);font-size:12px;margin:8px 0 0}
.boards{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px}
@media (min-width:620px){.boards{grid-template-columns:1fr 1fr}}
.board{border:2px solid var(--ink);padding:10px 12px}
.board ol{margin:6px 0;padding-left:22px}.board i,.list i{font-style:normal;color:var(--grey)}
.list{margin:8px 0 0;padding-left:18px}
.hours{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;height:90px;align-items:end;border-bottom:2px solid var(--ink);margin-top:8px}
.bar{position:relative;height:100%;display:flex;flex-direction:column-reverse}
.bar i{display:block;background:var(--blue)}.bar u{display:block;background:#3F4BA255}
.bar span{position:absolute;bottom:-18px;left:0;font-size:10px;color:var(--grey)}
.legend{margin-top:22px;font-size:11px;color:var(--grey)}.legend b{display:inline-block;width:10px;height:10px;background:var(--blue);vertical-align:middle}.legend b.l{background:#3F4BA255}
.funnel li{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #14161F22}
.funnel{list-style:none;margin:0;padding:0}.funnel b{font:400 22px/1 var(--anton)}.funnel i{font-style:normal;color:var(--blue);min-width:64px;text-align:right}
.warn{background:var(--yellow);border:2px solid var(--ink);padding:8px 12px;font-size:12px;margin-top:12px}
</style></head><body>
<h1>Arcade Stats</h1>
<p class="meta">Mis à jour ${time(s.generatedAt)} (Lisbonne), toutes les 15 minutes. Lancement ${time(s.launch)}.</p>
<div class="now"><div class="tiles">
${tile('Jackpot', s.now.pot ? `${s.now.pot.replace('.', ',')} ETH` : '—')}${tile('Fin de semaine', `<span data-countdown="${esc(s.now.weekEndsAt)}">—</span>`, time(s.now.weekEndsAt))}
${tile('Joueurs aujourd’hui', n(s.now.playersToday), 'wallets vus par nos balises')}${tile('Parties aujourd’hui', n(s.now.playsToday))}
</div></div>
${sources.length ? `<div class="warn">${sources.map(([k, v]) => `${esc(k)} : ${esc(v)}`).join('<br>')}</div>` : ''}
<div class="tabs" role="group">
<button type="button" data-tab="today" aria-pressed="true">Aujourd’hui</button><button type="button" data-tab="week" aria-pressed="false">Cette semaine</button><button type="button" data-tab="launch" aria-pressed="false">Depuis le lancement</button>
</div>
${Object.entries(wins).map(([k, w]) => windowBlock(k, w, s)).join('\n')}
<h2>Par jour</h2>
<div class="scroll"><table><thead><tr><th></th><th>Parties</th><th>Joueurs</th><th>Packs</th><th>Cartes</th><th>Sprites</th></tr></thead><tbody>
${s.days.map((d) => `<tr><th>${dayLabel(d.day)}</th><td class="big">${n(d.plays)}</td><td>${n(d.players)}</td><td>${n(d.packs)}</td><td>${n(d.cards)}</td><td>${n(d.sprites)}</td></tr>`).join('')}
</tbody></table></div>
<p class="lbl" style="margin-top:20px">Aujourd’hui, heure par heure</p>
<div class="hours">${hours}</div>
<p class="legend"><b></b> parties payantes commencées &nbsp; <b class="l"></b> practice</p>
<h2>Crédits</h2><div class="tiles">
${tile('Offerts', n(s.credits.granted), '190 holders × 3 par semaine')}${tile('Achetés', n(s.credits.bought), 'packs × 50 depuis le lancement')}${tile('Consommés', n(s.credits.consumed), 'rapport SuperRare')}${tile('En circulation', n(s.credits.inCirculation))}
</div>
<h2>People</h2><div class="tiles">
${s.people ? `${tile('Noms du mur', n(s.people.names))}${tile('Avec sprite', n(s.people.withSprite), s.people.lastSpriteAt ? `dernier ${time(s.people.lastSpriteAt)}` : '')}${tile('Non rattachés', n(s.people.unmatched))}` : tile('People', '—')}
</div>
<h2>Tunnel</h2><p class="note" style="margin:0 0 8px">Depuis le lancement. Le pourcentage compare chaque étape à la précédente.</p>
<ol class="funnel">${s.funnel.map((f) => `<li><span>${esc(f.step)}</span><span><b>${n(f.count)}</b> <i>${f.pct === null ? '' : p(f.pct)}</i></span></li>`).join('')}</ol>
<p class="note" style="margin-top:24px">Vues et clics comptés depuis la pose des balises (pas de cookie, pas d’identifiant d’appareil). <a href="/stats.json">stats.json</a></p>
<script>
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => {
  for (const x of document.querySelectorAll('[data-tab]')) x.setAttribute('aria-pressed', String(x === b));
  for (const w of document.querySelectorAll('[data-win]')) w.hidden = w.dataset.win !== b.dataset.tab;
  try { localStorage.setItem('stats-tab', b.dataset.tab); } catch {}
});
try { const t = localStorage.getItem('stats-tab'); if (t) document.querySelector('[data-tab="' + t + '"]')?.click(); } catch {}
const cd = document.querySelector('[data-countdown]');
const tick = () => { const ms = Date.parse(cd.dataset.countdown) - Date.now(); if (ms <= 0) { cd.textContent = 'terminée'; return; }
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60; cd.textContent = (d ? d + ' j ' : '') + h + ' h ' + String(m).padStart(2, '0'); };
tick(); setInterval(tick, 30000);
setTimeout(() => location.reload(), 5 * 60 * 1000);
</script>
</body></html>`;
}
