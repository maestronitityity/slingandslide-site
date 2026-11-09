// Global Rankings in the app (iPhone/iPad): the game's own Distance / Score / Height
// boards for this hour, this month and all time, shared with slingandslide.com.
// Loaded after native.js. In a normal browser it does nothing (the website has its own).
//
// Players join automatically with their Game Center name: Game Center gives the app a
// signed proof of who the player is (verified by our server against Apple's key), so
// nobody has to make an account or pick a name. Settings has "Remove me", which deletes
// their rankings data from the server and stops the app from re-joining until they
// choose to join again.
(() => {
  'use strict';
  const C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return;
  const API = 'https://sling-shop.slingandslide.workers.dev';
  const d = document;
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const esc = (x) => String(x).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  let tok = /^[0-9a-f]{64}$/.test(ls.get('ss_tok') || '') ? ls.get('ss_tok') : null;
  let me = null; try { me = JSON.parse(ls.get('ss_me') || 'null'); } catch (_) {}
  if (!tok) me = null;
  const off = () => ls.get('ss_lb_off') === '1';
  const gcOn = () => !!(window.GC && window.GC.ok);

  async function api(m, path, body) {
    const r = await fetch(API + path, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && tok && path !== '/auth/gamecenter') { tok = null; me = null; ls.del('ss_tok'); ls.del('ss_me'); link(); }
    return { s: r.status, j };
  }

  // ---- the game's database interface, backed by the server ------------------
  let snapCb = null, snapErr = null, docs = [], loaded = false, pollT = 0;
  const emit = () => { if (snapCb) snapCb({ docs: docs.map((x) => ({ id: x.id, data: () => x })) }); };
  async function pull() {
    try { const r = await fetch(API + '/lb'); const j = await r.json(); if (Array.isArray(j.docs)) { docs = j.docs; loaded = true; emit(); } }
    catch (_) { if (!loaded && snapErr) snapErr(new Error('offline')); }
  }
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
  const user = { id: async () => (me && me.id) || 'guest', can: async () => !!(tok && me && me.nick) };
  if (!window.claude) window.claude = { use: async (k) => (k === 'db' ? db : k === 'user' ? user : null) };

  function link() {
    try {
      lbUid = (tok && me && me.id) || 'guest';
      lbCan = !!(tok && me && me.nick);
      if (!lbDb) lbInit(); else if (snapCb) emit();
      if (lbCan) setTimeout(() => { try { lbPost(); } catch (_) {} }, 1500);
    } catch (_) {}
    refresh();
  }

  // ---- join with Game Center ----------------------------------------------------
  let joining = false, joinErr = '';
  async function join() {
    if (off() || joining || !gcOn() || !window.GCP || !window.GCP.identity) return;
    joining = true; joinErr = '';
    try {
      const idn = await window.GCP.identity();
      const r = await api('POST', '/auth/gamecenter', idn);
      if (r.s === 200 && r.j.token) {
        tok = r.j.token; me = { id: r.j.id, nick: r.j.nick };
        ls.set('ss_tok', tok); ls.set('ss_me', JSON.stringify(me));
        link();
      } else joinErr = 'the rankings server said ' + ((r.j && r.j.error) || 'HTTP ' + r.s);
    } catch (e) { joinErr = String((e && e.message) || e) || 'no connection'; }
    joining = false;
    if (joinErr) refresh();
  }
  addEventListener('gc-auth', () => join());
  addEventListener('gc-state', () => refresh());
  // Why Game Center isn't signed in (Apple's own message where there is one), with Try again.
  const gcWhy = () => {
    const i = (window.GC && window.GC.info) || {};
    if (i.waitingForSheet) return 'Game Center wants to show a sign-in screen. Tap Try again.';
    if (i.error) return 'Game Center says: “' + esc(i.error) + '”';
    return window.GC && window.GC.info ? 'Game Center isn\u2019t signed in for this game yet.' : 'Connecting to Game Center…';
  };
  const retryBtn = (id) => (window.GC && window.GC.retry ? `<button id=${id}>Try again</button>` : '');
  const wireRetry = (root, id) => { const b = root.querySelector('#' + id); if (b) b.onclick = () => { b.disabled = true; b.textContent = 'Trying…'; window.GC.retry().finally(() => refresh()); }; };
  d.addEventListener('visibilitychange', () => { if (!d.hidden && !tok) join(); });

  // ---- rankings window: who you are, or how to join ---------------------------
  const baseShow = window.lbShow;
  window.lbShow = function () {
    const r = baseShow.apply(this, arguments);
    const row = d.querySelector('#lbm .lbn');
    if (row) {
      const gcb = gcOn() ? '<button id=ssgc>Game Center</button>' : '';
      if (off()) row.innerHTML = `<div class=ssme>You're not in Global Rankings.</div><button id=ssjn>Join</button>`;
      else if (tok && me) row.innerHTML = `<div class=ssme>Playing as <b>${esc(me.nick || '')}</b></div>${gcb}`;
      else if (gcOn()) { row.innerHTML = joinErr ? `<div class=ssme>Couldn't join Global Rankings (${esc(joinErr)}).</div><button id=ssjr>Try again</button>${gcb}` : `<div class=ssme>Joining Global Rankings…</div>${gcb}`; const jr = row.querySelector('#ssjr'); if (jr) jr.onclick = () => { jr.disabled = true; join(); }; }
      else { row.innerHTML = `<div class=ssme>${gcWhy()} Your scores post once you're signed in to Game Center.</div>${retryBtn('ssgr')}`; wireRetry(row, 'ssgr'); }
      const g = row.querySelector('#ssgc'); if (g) g.onclick = () => { try { window.GCP.showLeaderboard({}); } catch (_) {} };
      const jn = row.querySelector('#ssjn'); if (jn) jn.onclick = () => { ls.del('ss_lb_off'); join(); refresh(); };
    }
    pull(); if (!tok) join();
    return r;
  };
  const baseRender = window.lbRender;
  window.lbRender = function () {
    const r = baseRender.apply(this, arguments);
    const f = d.getElementById('lbf');
    if (f) f.textContent = f.textContent.replace(' View-only access: ask for Contributor access to post your score.', tok ? '' : ' Sign in to Game Center to post your scores.');
    return r;
  };

  // ---- Settings: rankings section with "Remove me" ----------------------------
  let delArm = 0;
  const baseSet = window.renderSet;
  window.renderSet = function () {
    const r = baseSet.apply(this, arguments);
    const e = d.getElementById('setm'), dataBox = e && e.querySelector('.spd');
    if (!dataBox) return r;
    const box = d.createElement('div'); box.className = 'spd ssacc';
    if (off()) {
      box.innerHTML = `<b>Global Rankings</b><div class=ssme>You're not in Global Rankings.</div><div class=ssrow><button class=ssb2 id=ssjn2>Join Global Rankings</button></div>`;
      box.querySelector('#ssjn2').onclick = () => { ls.del('ss_lb_off'); join(); renderSet(); };
    } else if (tok && me) {
      box.innerHTML = `<b>Global Rankings</b><div class=ssme>Playing as <b>${esc(me.nick || '')}</b> (your Game Center name).</div><div class=ssrow><button class="ssb2 ssdel" id=ssrm>${delArm ? 'Tap again to remove' : 'Remove me from Global Rankings'}</button></div><small>Removes your name and scores from Global Rankings. Your progress in the game stays.</small>`;
      box.querySelector('#ssrm').onclick = async () => {
        if (!delArm) { delArm = 1; renderSet(); setTimeout(() => { delArm = 0; }, 5000); return; }
        delArm = 0; let ok = false; try { ok = (await api('POST', '/me/delete', {})).s === 200; } catch (_) {}
        if (ok) { ls.set('ss_lb_off', '1'); tok = null; me = null; ls.del('ss_tok'); ls.del('ss_me'); docs = docs.filter((x) => x.id !== lbUid); link(); toast('Removed from Global Rankings'); }
        else toast("Couldn't remove right now. Check your connection and try again.");
      };
    } else {
      box.innerHTML = `<b>Global Rankings</b><div class=ssme>${gcOn() ? (joinErr ? 'Couldn\u2019t join: ' + esc(joinErr) : 'Joining…') : gcWhy() + ' Your scores post to Global Rankings once you\u2019re signed in to Game Center.'}</div>${gcOn() ? '' : '<div class=ssrow>' + retryBtn('ssgr2').replace('<button', '<button class=ssb2') + '</div>'}`;
      wireRetry(box, 'ssgr2');
    }
    dataBox.parentNode.insertBefore(box, dataBox);
    return r;
  };
  function refresh() {
    try { if (setOpen) renderSet(); } catch (_) {}
    try { if (lbOpen) lbShow(); } catch (_) {}
    try { const e = d.getElementById('rkb'); if (e) e.textContent = lbTxt(); } catch (_) {}
  }

  const css = d.createElement('style');
  css.textContent = `.ssacc .ssme,#lbm .ssme{font-size:13px;line-height:1.35;margin:4px 0;flex:1}
#lbm .lbn{align-items:center;flex-wrap:wrap}
.ssacc .ssrow{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.ssacc .ssb2{border:0;border-radius:10px;font-family:inherit;font-weight:900;font-size:12px;color:#fff;background:#4d6f93;box-shadow:0 3px 0 #3a5673;padding:8px 12px}
.ssacc .ssdel{background:#7a3a3a;box-shadow:0 3px 0 #552525}
#sstoast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 96px);transform:translateX(-50%);z-index:96;max-width:calc(100% - 32px);box-sizing:border-box;padding:10px 16px;border-radius:14px;background:rgba(19,40,61,.95);color:#fff;font:800 13px/1.35 system-ui,-apple-system,sans-serif;border:2px solid #ffd23d;text-align:center;pointer-events:none}`;
  d.head.appendChild(css);
  let toastT = 0;
  function toast(msg) {
    let e = d.getElementById('sstoast');
    if (!e) { e = d.createElement('div'); e.id = 'sstoast'; e.setAttribute('role', 'status'); d.body.appendChild(e); }
    e.textContent = msg; clearTimeout(toastT); toastT = setTimeout(() => e.remove(), 3800);
  }

  link();
  if (gcOn()) join();
})();
