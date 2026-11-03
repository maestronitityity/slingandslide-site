// Web version of Sling & Slide (slingandslide.com/play). Loaded after the game.
//
// Shop: diamond packs and the Starter Pack are sold with Stripe Checkout through
// the shop API (shop-api/worker.js). The API sets the prices and rewards, and only
// takes the money once this game has collected the reward, so an abandoned checkout
// or a card from outside Australia is never charged. Until the API is set up (or
// while it is still on a Stripe test key) the Shop points players to the app, except
// with ?shoptest in the address, which is how test payments are tried out.
(() => {
  'use strict';
  const API = 'https://sling-shop.slingandslide.workers.dev';
  const APP_MSG = 'Diamond packs and the Starter Pack are in the Sling & Slide app, coming soon to the App Store';
  const ITEM_OF = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} },
  };
  const qs = new URLSearchParams(location.search);
  if (qs.has('shoptest')) ss.set('ss_shoptest', '1');

  let device = ls.get('ss_dev');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(device || '')) {
    const b = new Uint8Array(18); crypto.getRandomValues(b);
    device = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    ls.set('ss_dev', device);
  }

  const say = (msg, open) => {
    try {
      smsg = msg;
      if (st === 'menu') { if (open) tab = 'shop'; showMenu(lastMsg); }
    } catch (_) {}
  };
  const money = (c) => '$' + (c / 100).toFixed(2);
  let shopOn = false, busy = false;
  const toApp = () => say(APP_MSG);

  // ---- pending purchases (saved before leaving for checkout, cleared once credited)
  const pend = () => { try { const a = JSON.parse(ls.get('ss_pend') || '[]'); return Array.isArray(a) ? a.filter((x) => x && typeof x.id === 'string') : []; } catch (_) { return []; } };
  const setPend = (a) => ls.set('ss_pend', JSON.stringify(a.slice(-10)));
  const addPend = (id) => { if (!pend().some((x) => x.id === id)) setPend([...pend(), { id, t: Date.now() }]); };
  const dropPend = (id) => setPend(pend().filter((x) => x.id !== id));

  const post = async (path, body) => {
    const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  };

  function credit(id, rw) {
    if (!Array.isArray(save.wp)) save.wp = [];
    if (save.wp.includes(id)) return false;
    save.wp.push(id); if (save.wp.length > 50) save.wp = save.wp.slice(-50);
    save.gems += rw.gems | 0; save.coins += rw.coins | 0;
    if (rw.once) save.st1 = true;
    persist();
    try { fxOk = 1; } catch (_) {}
    return true;
  }

  let claiming = false;
  async function claimAll(fromReturn) {
    if (!API || claiming) return;
    claiming = true;
    const got = [], notes = [];
    try {
      for (const p of pend()) {
        let r;
        try { r = await post('/claim', { id: p.id, device }); }
        catch (_) { notes.push("We couldn't confirm your purchase yet. It will be checked again next time you open the Shop, and you're only charged once it's added."); continue; }
        if (r.state === 'paid') { if (credit(p.id, r.reward)) got.push(r.reward); dropPend(p.id); }
        else if (r.state === 'country') { dropPend(p.id); notes.push("Sorry, web purchases are for Australian cards for now. You haven't been charged."); }
        else if (r.state === 'open') { if (Date.now() - p.t > 2 * 36e5) dropPend(p.id); else if (fromReturn === 'return') notes.push('Your payment is still processing. Tap Restore purchases in a moment.'); }
        else dropPend(p.id);
      }
    } finally { claiming = false; }
    if (got.length) {
      const g = got.reduce((a, r) => a + (r.gems | 0), 0), c = got.reduce((a, r) => a + (r.coins | 0), 0);
      say('Thank you! +' + g.toLocaleString() + ' 💎' + (c ? ' +' + c.toLocaleString() + ' 🪙' : ''), true);
    } else if (notes.length) say(notes[0], true);
    else if (fromReturn === 'restore') say('All your web purchases are already added', true);
    else if (fromReturn === 'cancel') say("Checkout cancelled. You haven't been charged.", true);
  }

  async function buy(item) {
    if (!shopOn) return toApp();
    if (busy) return;
    busy = true; say('Opening secure checkout…');
    try {
      const r = await post('/checkout', { item, device });
      addPend(r.id);
      persist();
      location.href = r.url;
      setTimeout(() => { busy = false; }, 8000);
    } catch (_) {
      busy = false;
      say("Couldn't open checkout. Check your connection and try again.");
    }
  }

  window.IAP = {
    native: false, web: true, ready: true, busy: false, starterPrice: 'In app',
    buy: (i) => buy(ITEM_OF[i]),
    restore: () => (API ? claimAll('restore') : toApp()),
  };
  try { PACKS.forEach((p) => { p[1] = 'In app'; }); } catch (_) {}
  window.testBuy = (i) => (ITEM_OF[i] ? buy(ITEM_OF[i]) : toApp());
  window.buyStarter = () => { try { if (save.st1) return; } catch (_) {} buy('starter'); };
  const baseShop = window.shopHTML;
  window.shopHTML = function () {
    const h = baseShop.apply(this, arguments);
    return shopOn ? h.replace('<div class=gh>Diamonds</div>', '<div class=gh>Diamonds · AUD, Australian cards</div>') : h;
  };
  const redraw = () => { try { if (st === 'menu' && tab === 'shop') showMenu(lastMsg); } catch (_) {} };
  redraw();

  // Returning from Stripe Checkout
  const paid = qs.get('paid'), cancel = qs.get('shop') === 'cancel';
  if (paid || cancel || qs.has('shoptest')) {
    try { history.replaceState(null, '', location.pathname + location.hash); } catch (_) {}
  }
  if (paid && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(paid)) addPend(paid);

  if (API) {
    // Prices first, then any purchase result, so the result message isn't redrawn away.
    fetch(API + '/config').then((r) => r.json()).then((c) => {
      if (!c || !c.items) return;
      if (c.mode === 'live' || ss.get('ss_shoptest') === '1') {
        shopOn = true;
        try { PACKS.forEach((p, i) => { const it = c.items[ITEM_OF[i]]; if (it) p[1] = money(it.aud); }); } catch (_) {}
        if (c.items.starter) window.IAP.starterPrice = money(c.items.starter.aud);
        redraw();
      }
    }).catch(() => {}).then(() => {
      const why = paid ? 'return' : cancel ? 'cancel' : '';
      if (pend().length) claimAll(why);
      else if (why === 'cancel') say("Checkout cancelled. You haven't been charged.", true);
    });
  }
})();

// Full screen, app style. Browsers only allow full screen from a tap, so the
// first tap on a phone or tablet (and every tap after leaving full screen)
// switches it on. iPhones can't do this in Safari, so there they get a one-time
// tip to add the game to the Home Screen, which opens it full screen like an app.
(() => {
  'use strict';
  const d = document, el = d.documentElement;
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
  const touch = matchMedia('(pointer: coarse)').matches;
  if (standalone || !touch) return;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  const isFs = () => !!(d.fullscreenElement || d.webkitFullscreenElement);
  if (req) {
    const go = () => {
      if (isFs()) return;
      try {
        const p = req.call(el, { navigationUI: 'hide' });
        if (p && p.then) p.then(() => { try { screen.orientation.lock('portrait').catch(() => {}); } catch (_) {} }).catch(() => {});
      } catch (_) {}
    };
    d.addEventListener('pointerup', go, true);
    d.addEventListener('touchend', go, true);
    return;
  }
  // No full screen support (iPhone): show the Home Screen tip once.
  let seen = false;
  try { seen = localStorage.getItem('ss_a2hs') === '1'; } catch (_) {}
  if (seen) return;
  const tip = d.createElement('div');
  tip.id = 'a2hs'; tip.setAttribute('role', 'status');
  tip.innerHTML = '<b>Play full screen</b><span>Tap <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Share"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8"/></svg> then <b>Add to Home Screen</b></span><button aria-label="Close">✕</button>';
  tip.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 54px);transform:translateX(-50%);z-index:9999;width:min(340px,calc(100% - 32px));box-sizing:border-box;padding:10px 40px 10px 14px;border-radius:14px;background:rgba(19,40,61,.94);color:#fff;font:700 13px/1.35 system-ui,-apple-system,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.3);border:2px solid #ffd23d';
  tip.querySelector('b').style.cssText = 'display:block;color:#ffd23d;font-size:14px';
  tip.querySelector('svg').style.cssText = 'vertical-align:-3px;margin:0 2px';
  const x = tip.querySelector('button');
  x.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);width:32px;height:32px;border:0;background:none;color:#fff;font-size:16px;font-family:inherit';
  const close = (ev) => { if (ev) { ev.stopPropagation(); ev.preventDefault(); } tip.remove(); try { localStorage.setItem('ss_a2hs', '1'); } catch (_) {} };
  x.addEventListener('pointerdown', close);
  const show = () => { d.body.appendChild(tip); setTimeout(() => { if (tip.isConnected) close(); }, 12000); };
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', show); else setTimeout(show, 600);
})();
