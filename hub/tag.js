// THE WALL ARCADE's tags on the hub's three pages, for /stats on the card service (cards/src/events.ts): fire and
// forget (sendBeacon, text/plain), no cookie, no device id, nothing waits for it. The page's own view (data-view on
// this script), then one delegated listener: PLAY (its data-app), CREATE MY OWN GAME / MAKE MY GAME, COPY THE KIT, a kit DOWNLOAD,
// PEOPLE's SIGN IN and ADD YOURSELF.
(function () {
  var URL_EVENTS = 'https://wall-arcade-cards.netlify.app/api/events';
  function tag(event, more) {
    try {
      var o = { event: event }; for (var k in more || {}) o[k] = more[k];
      var body = JSON.stringify(o);
      if (!(navigator.sendBeacon && navigator.sendBeacon(URL_EVENTS, body))) fetch(URL_EVENTS, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
    } catch (e) { /* stats only */ }
  }
  var view = document.currentScript && document.currentScript.getAttribute('data-view');
  if (view) tag(view);
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('a,button') : null;
    if (!el) return;
    var href = el.getAttribute('href') || '', text = (el.textContent || '').trim().toUpperCase();
    if (el.getAttribute('data-app')) tag('click_play', { game: el.getAttribute('data-app') });   // the game's app id: any app of the credit group
    else if (text.indexOf('CREATE MY OWN GAME') === 0 || text.indexOf('MAKE MY GAME') === 0) tag('click_make_my_game', { extra: { from: view === 'hub_view' ? 'hub' : 'builders' } });
    else if (el.classList.contains('copy')) tag('copy_kit');
    else if (el.hasAttribute('download') || el.id === 'dlPeople') tag('kit_download', { extra: { file: (el.getAttribute('download') || href.split('/').pop() || '').slice(0, 60) } });
    else if (el.id === 'signIn') tag('people_sign_in');
    else if (el.id === 'addYourself' && href) tag('add_yourself');
  }, true);
})();
