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

// Accounts: sign in with Google so progress is saved online and follows the
// player to any browser, plus global rankings. The game already has a full
// rankings screen built on a small database interface (window.claude); this
// provides that interface from the shop API, so the game code is unchanged.
//   Saving: every time the game saves, the save is also sent to the account
//   (a few seconds later, batched). Each upload carries the revision it was based
//   on, so if another device saved in between, the player chooses which to keep
//   instead of one silently overwriting the other.
(() => {
  'use strict';
  const API = 'https://sling-shop.slingandslide.workers.dev';
  const d = document, LS = (() => { try { return window.localStorage; } catch (_) { return null; } })();
  const ls = {
    get(k) { try { return LS.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { origSet.call(LS, k, v); } catch (_) {} },
    del(k) { try { LS.removeItem(k); } catch (_) {} },
  };
  const origSet = Storage.prototype.setItem;
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;
  const escH = (x) => String(x).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

  let tok = ls.get('ss_tok');
  if (!/^[0-9a-f]{64}$/.test(tok || '')) tok = null;
  let acct = null; try { acct = JSON.parse(ls.get('ss_acct') || 'null'); } catch (_) {}
  if (!tok) acct = null;
  let cfg = { google: null, accounts: false }, cfgP = null;
  let applying = false, timer = 0, firstDirty = 0, busy = false, again = false, status = 'idle', blocked = false;
  const getRev = () => parseInt(ls.get('ss_rev') || '0', 10) || 0;
  const isDirty = () => ls.get('ss_dirty') === '1';

  // Sign-in that came back from Google's redirect flow (home-screen app).
  const hm = location.hash.match(/ss_tok=([0-9a-f]{64})/);
  let fromRedirect = false;
  if (hm) {
    tok = hm[1]; ls.set('ss_tok', tok); fromRedirect = true;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
  }
  if (/ss_signin=fail/.test(location.hash)) { try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {} setTimeout(() => toast("Google sign-in didn't work. Please try again."), 800); }

  const api = async (m, path, body, opt = {}) => {
    const r = await fetch(API + path, {
      method: m, keepalive: !!opt.keepalive,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && tok && path !== '/auth/google') signedOut('You were signed out. Sign in again to keep saving online.');
    return { s: r.status, j };
  };
  const loadCfg = () => cfgP || (cfgP = fetch(API + '/config').then((r) => r.json()).then((c) => { cfg = c || cfg; return cfg; }).catch(() => { cfgP = null; return cfg; }));

  // ---- the game's saves -> account -----------------------------------------
  Storage.prototype.setItem = function (k, v) {
    if (k === 'vs' && this === LS) {
      if (applying) return; // an account save is being loaded; don't let the old one back in
      origSet.call(this, k, v);
      if (tok && !blocked) markDirty();
      return;
    }
    return origSet.call(this, k, v);
  };
  function markDirty() {
    ls.set('ss_dirty', '1');
    const now = Date.now();
    if (!firstDirty) firstDirty = now;
    clearTimeout(timer);
    timer = setTimeout(upload, now - firstDirty > 12000 ? 0 : 3000);
  }
  async function upload(keepalive) {
    if (!tok || blocked || applying) return;
    if (busy) { again = true; return; }
    const data = ls.get('vs'); if (!data) return;
    busy = true; firstDirty = 0; setStatus('saving');
    try {
      const r = await api('PUT', '/save', { base: getRev(), data }, { keepalive: keepalive === true && data.length < 60000 });
      if (r.s === 200) { ls.set('ss_rev', String(r.j.rev)); if (ls.get('vs') === data) ls.set('ss_dirty', '0'); setStatus('saved'); }
      else if (r.s === 409 && r.j.error === 'conflict') {
        if (r.j.data === data) { ls.set('ss_rev', String(r.j.rev)); ls.set('ss_dirty', '0'); setStatus('saved'); }
        else { blocked = true; setStatus('idle'); choose(r.j.data, r.j.rev, r.j.t); }
      } else if (r.s !== 401) setStatus('retry');
    } catch (_) { setStatus('retry'); }
    busy = false;
    if (again) { again = false; upload(); }
    else if (status === 'retry') { clearTimeout(timer); timer = setTimeout(upload, 20000); }
  }
  d.addEventListener('visibilitychange', () => { if (d.hidden && tok && isDirty()) { clearTimeout(timer); upload(true); } });
  addEventListener('online', () => { if (tok && isDirty()) upload(); });
  // another tab of the game saved and moved the revision on
  addEventListener('storage', (e) => { if (e.key === 'ss_tok' && !e.newValue && tok) { tok = null; acct = null; linkRankings(); refresh(); } });

  function setStatus(x) { status = x; const e = d.getElementById('ssst'); if (e) e.textContent = statusText(); }
  const statusText = () => ({ saving: 'Saving…', saved: '✓ Progress saved to your account', retry: "Couldn't reach the server. It will keep trying.", idle: isDirty() ? 'Waiting to save…' : '✓ Progress saved to your account' }[status]);

  function applyCloud(data, rev) {
    applying = true;
    try { origSet.call(LS, 'vs', data); } catch (_) {}
    ls.set('ss_rev', String(rev)); ls.set('ss_dirty', '0');
    location.reload();
  }
  const sum = (o) => ({ lvl: ((o && o.lvl) | 0) + 1, best: Math.floor((o && o.best) || 0), gems: (o && o.gems) | 0, coins: (o && o.coins) | 0, runs: (o && o.runs) | 0 });
  const localObj = () => { try { return JSON.parse(ls.get('vs') || '{}'); } catch (_) { return {}; } };
  const blank = (o) => !o || !((o.runs | 0) || (o.gems | 0) || (o.coins | 0) > 0 || (o.lvl | 0) || (o.best || 0) > 0);

  // ---- account state -------------------------------------------------------
  function setAcct(a) { acct = a; if (a) ls.set('ss_acct', JSON.stringify(a)); else ls.del('ss_acct'); }
  function signedOut(msg) {
    tok = null; setAcct(null); ls.del('ss_tok'); ls.del('ss_rev'); ls.set('ss_dirty', '0'); blocked = false;
    linkRankings(); refresh(); if (msg) toast(msg);
  }
  async function afterLogin(me, fresh) {
    setAcct({ id: me.id, nick: me.nick });
    if (me.nick) { try { if (save.nick !== me.nick) { save.nick = me.nick; persist(); } } catch (_) {} }
    const cloud = me.save, local = localObj();
    if (!cloud) { blocked = false; ls.set('ss_rev', '0'); await upForce(); }
    else if (!fresh && cloud.rev === getRev()) { if (isDirty()) upload(); else setStatus('saved'); }
    else if (!fresh && cloud.rev > getRev() && !isDirty()) { const g = await api('GET', '/save'); if (g.s === 200 && g.j.data) return applyCloud(g.j.data, g.j.rev); }
    else {
      const g = await api('GET', '/save');
      if (g.s === 200 && g.j.data) {
        if (g.j.data === ls.get('vs')) { ls.set('ss_rev', String(g.j.rev)); ls.set('ss_dirty', '0'); setStatus('saved'); }
        else if (blank(local)) return applyCloud(g.j.data, g.j.rev);
        else { blocked = true; choose(g.j.data, g.j.rev, g.j.t); }
      }
    }
    if (!me.nick && !blocked) nickPrompt();
    linkRankings();
    refresh();
  }
  async function upForce() {
    const data = ls.get('vs'); if (!data) return;
    const r = await api('PUT', '/save', { base: 0, force: true, data });
    if (r.s === 200) { ls.set('ss_rev', String(r.j.rev)); ls.set('ss_dirty', '0'); setStatus('saved'); }
  }
  async function signIn(credential) {
    toast('Signing in…', 1);
    let r; try { r = await api('POST', '/auth/google', { credential }); } catch (_) { return toast("Couldn't sign in. Check your connection and try again."); }
    if (r.s !== 200 || !r.j.token) return toast("Couldn't sign in. Please try again.");
    const prev = acct && acct.id;
    tok = r.j.token; ls.set('ss_tok', tok);
    if (prev && prev !== r.j.id) ls.set('ss_rev', '0');
    toast(r.j.nick ? 'Signed in as ' + r.j.nick : 'Signed in');
    await afterLogin(r.j, !(prev && prev === r.j.id));
  }

  // ---- "which progress do you keep?" -----------------------------------------
  function choose(cloudData, cloudRev, t) {
    let co = {}; try { co = JSON.parse(cloudData); } catch (_) {}
    const a = sum(localObj()), b = sum(co);
    const card = (k, title, x, sub) => `<button class=ssc data-c="${k}"><b>${title}</b><small>${sub}</small><span>⭐ Level ${x.lvl}</span><span>🏁 Best ${x.best.toLocaleString()} m</span><span>💎 ${x.gems.toLocaleString()} · 🪙 ${x.coins.toLocaleString()}</span><span>🎯 ${x.runs.toLocaleString()} runs</span></button>`;
    const when = t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    modal(`<div class=ssh><b>☁️ Which progress do you want to keep?</b></div>
      <p class=ssp>This device and your account have different progress. The one you don't pick will be replaced.</p>
      <div class=ssg2>${card('local', '📱 This device', a, 'Playing here now')}${card('cloud', '☁️ Your account', b, when ? 'Saved ' + escH(when) : 'Saved online')}</div>`, false, (m) => {
      m.querySelectorAll('.ssc').forEach((btn) => btn.addEventListener('click', async () => {
        m.querySelectorAll('.ssc').forEach((x) => { x.disabled = true; });
        if (btn.dataset.c === 'cloud') return applyCloud(cloudData, cloudRev);
        blocked = false; await upForce(); closeModal(); toast('Kept this device’s progress'); if (acct && !acct.nick) setTimeout(nickPrompt, 600);
      }));
    });
  }

  // ---- nickname (chosen once) ----------------------------------------------
  const NICK_ERR = { length: 'Use 3 to 14 characters.', chars: 'Letters, numbers, spaces, _ and - only.', rude: 'Please choose a friendlier name.', reserved: 'That name is reserved. Please choose another.', taken: 'Someone already has that name. Try another.', already_set: '' };
  function nickPrompt() {
    if (!tok || (acct && acct.nick)) return;
    let sug = ''; try { sug = /^Chick\d{4}$/.test(save.nick || '') ? '' : String(save.nick || '').slice(0, 14); } catch (_) {}
    modal(`<div class=ssh><b>🏷️ Pick your nickname</b><button class=ssx aria-label=Close>✕</button></div>
      <p class=ssp>This is how other players see you in Global Rankings. <b>It can't be changed later</b>, so choose carefully.</p>
      <input id=ssni maxlength=14 autocomplete=off autocapitalize=words spellcheck=false placeholder="Your nickname" value="${escH(sug)}">
      <div class=sse id=ssne></div>
      <button class=ssb id=ssnb>Save nickname</button>`, true, (m) => {
      const inp = m.querySelector('#ssni'), btn = m.querySelector('#ssnb'), er = m.querySelector('#ssne');
      let confirmFor = null;
      inp.addEventListener('input', () => { confirmFor = null; btn.textContent = 'Save nickname'; er.textContent = ''; });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      btn.addEventListener('click', async () => {
        const v = inp.value.replace(/\s+/g, ' ').trim();
        if (v.length < 3 || v.length > 14) { er.textContent = NICK_ERR.length; return; }
        if (confirmFor !== v) { confirmFor = v; btn.textContent = 'Tap again to confirm: ' + v; return; }
        btn.disabled = true; er.textContent = '';
        let r; try { r = await api('POST', '/me/nick', { nick: v }); } catch (_) { r = { s: 0, j: {} }; }
        btn.disabled = false;
        if (r.s === 200 || (r.j && r.j.error === 'already_set')) {
          const n = r.j.nick; setAcct({ ...acct, nick: n });
          try { save.nick = n; persist(); } catch (_) {}
          closeModal(); toast('You’re ' + n + ' in Global Rankings!'); linkRankings(); refresh();
        } else { confirmFor = null; btn.textContent = 'Save nickname'; er.textContent = (r.j && NICK_ERR[r.j.error]) || "Couldn't save. Check your connection and try again."; }
      });
      setTimeout(() => inp.focus(), 50);
    });
  }

  // ---- global rankings: the game's database interface ----------------------
  let snapCb = null, docs = [], pollT = 0, loaded = false;
  const emit = () => { if (snapCb) snapCb({ docs: docs.map((x) => ({ id: x.id, data: () => x })) }); };
  async function pull() {
    try { const r = await fetch(API + '/lb'); const j = await r.json(); if (Array.isArray(j.docs)) { docs = j.docs; loaded = true; emit(); } }
    catch (_) { if (!loaded && snapErr) snapErr(new Error('offline')); }
  }
  let snapErr = null;
  const db = {
    collection: () => { const q = { orderBy: () => q, limit: () => q, onSnapshot: (cb, err) => { snapCb = cb; snapErr = err; pull(); clearInterval(pollT); pollT = setInterval(() => { if (!d.hidden) pull(); }, 45000); return () => {}; } }; return q; },
    doc: () => ({
      set: async (o) => {
        const r = await api('POST', '/lb', { doc: o });
        if (r.s === 200 && r.j.doc) { const x = { ...r.j.doc, id: r.j.id }; docs = docs.filter((y) => y.id !== x.id).concat(x); emit(); return; }
        throw Object.assign(new Error('rankings'), { code: r.j && r.j.error });
      },
    }),
  };
  const user = { id: async () => (acct && acct.id) || 'guest', can: async () => !!(tok && acct && acct.nick) };
  if (!window.claude) window.claude = { use: async (k) => (k === 'db' ? db : k === 'user' ? user : null) };
  function linkRankings() {
    try {
      lbUid = (acct && acct.id) || 'guest'; lbCan = !!(tok && acct && acct.nick);
      if (acct && acct.nick && save.nick !== acct.nick) { save.nick = acct.nick; persist(); }
      lbInit();
      if (lbCan) setTimeout(() => { try { lbPost(); } catch (_) {} }, 1500);
    } catch (_) {}
  }
  setTimeout(() => { try { if (!lbDb) lbInit(); } catch (_) {} }, 0); // guests can view the rankings

  // In the rankings window: no free-text name box (the nickname is fixed);
  // show who you're playing as, or a sign-in button.
  const baseLbShow = window.lbShow;
  window.lbShow = function () {
    const r = baseLbShow.apply(this, arguments);
    const row = d.querySelector('#lbm .lbn');
    if (row) {
      if (tok && acct && acct.nick) row.innerHTML = `<div class=ssme>Playing as <b>${escH(acct.nick)}</b></div>`;
      else if (tok) { row.innerHTML = `<div class=ssme>Pick a nickname to post your scores</div><button id=ssnk>Pick</button>`; row.querySelector('#ssnk').onclick = nickPrompt; }
      else { row.innerHTML = `<div class=ssme>Sign in to post your scores and keep your progress</div><div class=ssgb id=ssgl></div>`; gButton(row.querySelector('#ssgl')); }
    }
    pull();
    return r;
  };
  const baseLbRender = window.lbRender;
  window.lbRender = function () {
    const r = baseLbRender.apply(this, arguments);
    const f = d.getElementById('lbf');
    if (f) f.textContent = f.textContent.replace(' View-only access: ask for Contributor access to post your score.', tok ? (acct && acct.nick ? '' : ' Pick a nickname to post your scores.') : ' Sign in with Google to post your scores.');
    return r;
  };

  // ---- Settings: account section -------------------------------------------
  const baseRenderSet = window.renderSet;
  let delArm = 0;
  window.renderSet = function () {
    const r = baseRenderSet.apply(this, arguments);
    const e = d.getElementById('setm'), dataBox = e && e.querySelector('.spd');
    if (!dataBox) return r;
    const box = d.createElement('div'); box.className = 'spd ssacc';
    if (tok && acct) {
      box.innerHTML = `<b>Account</b><div class=ssme>Signed in with Google${acct.nick ? ' as <b>' + escH(acct.nick) + '</b>' : ''}</div>
        <small id=ssst>${statusText()}</small>
        <div class=ssrow>${acct.nick ? '' : '<button class=ssb2 id=ssnk2>Pick nickname</button>'}<button class=ssb2 id=ssso>Sign out</button><button class="ssb2 ssdel" id=ssdl>${delArm ? 'Tap again: delete account' : 'Delete account'}</button></div>
        <small>Signing out or deleting your account keeps your progress on this device.</small>`;
      box.querySelector('#ssso').onclick = async () => { try { if (isDirty()) await upload(); await api('POST', '/signout', {}); } catch (_) {} signedOut('Signed out. Your progress stays on this device.'); };
      box.querySelector('#ssdl').onclick = async () => {
        if (!delArm) { delArm = 1; renderSet(); setTimeout(() => { delArm = 0; }, 5000); return; }
        delArm = 0; let ok = false; try { ok = (await api('POST', '/me/delete', {})).s === 200; } catch (_) {}
        if (ok) signedOut('Account deleted. Your progress stays on this device.'); else toast("Couldn't delete right now. Please try again.");
      };
      const nk = box.querySelector('#ssnk2'); if (nk) nk.onclick = nickPrompt;
    } else {
      box.innerHTML = `<b>Account</b><div class=ssme>Sign in to save your progress online, keep it if you clear your browser, play on any device, and post your scores to Global Rankings.</div><div class=ssgb id=ssgs></div>`;
      gButton(box.querySelector('#ssgs'));
    }
    dataBox.parentNode.insertBefore(box, dataBox);
    return r;
  };
  function refresh() {
    try { if (setOpen) renderSet(); } catch (_) {}
    try { if (lbOpen) lbShow(); } catch (_) {}
    try { const e = d.getElementById('rkb'); if (e) e.textContent = lbTxt(); } catch (_) {}
  }

  // ---- Google button -------------------------------------------------------
  let gsiP = null, gInit = false;
  const gsi = () => gsiP || (gsiP = new Promise((res, rej) => {
    const sc = d.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = () => res(); sc.onerror = () => { gsiP = null; rej(new Error('gsi')); }; d.head.appendChild(sc);
  }));
  async function gButton(el) {
    if (!el) return;
    el.innerHTML = '<small>Loading sign-in…</small>';
    await loadCfg();
    if (!cfg.google) { el.innerHTML = '<small>Google sign-in is coming soon.</small>'; return; }
    try { await gsi(); } catch (_) { el.innerHTML = "<small>Couldn't load Google sign-in. Check your connection.</small>"; return; }
    if (!el.isConnected) return;
    try {
      if (!gInit) {
        google.accounts.id.initialize({
          client_id: cfg.google, callback: (resp) => signIn(resp.credential), auto_select: false, itp_support: true,
          ux_mode: standalone ? 'redirect' : 'popup', login_uri: API + '/auth/google/redirect',
        });
        gInit = true;
      }
      el.innerHTML = '';
      google.accounts.id.renderButton(el, { type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'left', width: 250 });
    } catch (_) { el.innerHTML = "<small>Couldn't load Google sign-in.</small>"; }
  }

  // ---- small UI helpers ----------------------------------------------------
  const css = d.createElement('style');
  css.textContent = `#acm{position:fixed;inset:0;z-index:95;display:flex;align-items:center;justify-content:center;font-family:inherit}
#acm .ssbg{position:absolute;inset:0;background:rgba(8,12,24,.72)}
#acm .ssbox{position:relative;width:min(92vw,400px);max-height:86vh;overflow:auto;background:rgba(32,52,74,.98);border-radius:18px;padding:14px;color:#fff;box-shadow:0 6px 0 rgba(0,0,0,.3);box-sizing:border-box}
#acm .ssh{display:flex;justify-content:space-between;align-items:center;font-size:17px;gap:8px}
#acm .ssp{font-size:13px;line-height:1.4;opacity:.9;margin:8px 0 10px}
#acm button{border:0;border-radius:12px;font-family:inherit;font-weight:900;color:#fff;background:#4d6f93;box-shadow:0 3px 0 #3a5673}
#acm .ssx{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.14);box-shadow:none;flex:none}
#acm input{width:100%;box-sizing:border-box;border:2px solid #4d6f93;border-radius:12px;background:rgba(0,0,0,.25);color:#fff;font-family:inherit;font-weight:800;font-size:17px;padding:10px 12px}
#acm .sse{min-height:18px;font-size:12px;font-weight:800;color:#ffb3a8;margin:6px 2px}
#acm .ssb{width:100%;padding:12px;font-size:15px;background:#3faa55;box-shadow:0 3px 0 #2a7a3c}
#acm .ssg2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#acm .ssc{display:flex;flex-direction:column;gap:4px;align-items:flex-start;text-align:left;padding:10px;font-size:12px;font-weight:800;background:#2f5379;border:2px solid rgba(255,255,255,.2)}
#acm .ssc b{font-size:14px}#acm .ssc small{font-weight:700;opacity:.75;margin-bottom:4px}
#acm .ssc:active{transform:translateY(2px)}
.ssacc .ssme,#lbm .ssme{font-size:13px;line-height:1.35;margin:4px 0;flex:1}
#lbm .lbn{align-items:center;flex-wrap:wrap}
.ssacc .ssgb,#lbm .ssgb{min-height:44px;margin:6px 0;display:flex;align-items:center}
.ssacc .ssrow{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.ssacc .ssb2{border:0;border-radius:10px;font-family:inherit;font-weight:900;font-size:12px;color:#fff;background:#4d6f93;box-shadow:0 3px 0 #3a5673;padding:8px 12px}
.ssacc .ssdel{background:#7a3a3a;box-shadow:0 3px 0 #552525}
#sstoast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 96px);transform:translateX(-50%);z-index:96;max-width:calc(100% - 32px);box-sizing:border-box;padding:10px 16px;border-radius:14px;background:rgba(19,40,61,.95);color:#fff;font:800 13px/1.35 system-ui,-apple-system,sans-serif;border:2px solid #ffd23d;box-shadow:0 6px 18px rgba(0,0,0,.3);text-align:center;pointer-events:none}`;
  d.head.appendChild(css);
  let toastT = 0;
  function toast(msg, keep) {
    let e = d.getElementById('sstoast');
    if (!e) { e = d.createElement('div'); e.id = 'sstoast'; e.setAttribute('role', 'status'); d.body.appendChild(e); }
    e.textContent = msg; clearTimeout(toastT);
    if (!keep) toastT = setTimeout(() => e.remove(), 3800);
  }
  function modal(html, closable, wire) {
    closeModal();
    const m = d.createElement('div'); m.id = 'acm';
    m.innerHTML = `<div class=ssbg></div><div class=ssbox>${html}</div>`;
    const stop = (e) => e.stopPropagation();
    ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach((ev) => m.addEventListener(ev, stop));
    if (closable) { m.querySelector('.ssbg').onclick = closeModal; const x = m.querySelector('.ssx'); if (x) x.onclick = closeModal; }
    d.body.appendChild(m); if (wire) wire(m);
  }
  function closeModal() { const m = d.getElementById('acm'); if (m) m.remove(); }

  // ---- start -----------------------------------------------------------------
  (async () => {
    if (!tok) return;
    let r; try { r = await api('GET', '/me'); } catch (_) { setStatus('retry'); linkRankings(); return; }
    if (r.s !== 200) return;
    if (fromRedirect) { const prev = acct && acct.id; if (prev && prev !== r.j.id) ls.set('ss_rev', '0'); toast(r.j.nick ? 'Signed in as ' + r.j.nick : 'Signed in'); return afterLogin(r.j, !(prev && prev === r.j.id)); }
    afterLogin(r.j, false);
  })();
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
