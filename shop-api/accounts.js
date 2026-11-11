// Sling & Slide web accounts: Google sign-in, cloud saves and global rankings.
//
// The Worker checks Google's sign-in token itself (signature, audience, expiry),
// then hands the verified Google account ID to one Durable Object ("Hub") that
// keeps everything in its own SQLite database:
//   users    Google account ID -> random public player ID + nickname (chosen
//            once, unique, filtered). Only the public ID appears in rankings.
//   sessions random sign-in tokens (only their SHA-256 is stored)
//   saves    one game save per account, with a revision number so two devices
//            can't silently overwrite each other
//   lb       one rankings entry per account (the game's own leaderboard format)
// No email address, name or photo from Google is stored.

const enc = new TextEncoder();
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

// ---- Google ID token check --------------------------------------------------
let jwks = null, jwksAt = 0;
async function googleKeys(env, force) {
  if (!force && jwks && Date.now() - jwksAt < 36e5) return jwks;
  const r = await fetch(env.GOOGLE_JWKS || 'https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('jwks ' + r.status);
  jwks = (await r.json()).keys || []; jwksAt = Date.now();
  return jwks;
}

export async function verifyGoogle(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let head, claims;
  try { head = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); claims = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch (_) { return null; }
  if (head.alg !== 'RS256' || !head.kid) return null;
  let jwk = (await googleKeys(env)).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(env, true)).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), enc.encode(parts[0] + '.' + parts[1]));
  if (!good) return null;
  const now = Date.now() / 1000;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return null;
  if (!env.GOOGLE_CLIENT_ID || claims.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!(claims.exp > now - 60) || (claims.iat && claims.iat > now + 300)) return null;
  if (typeof claims.sub !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(claims.sub)) return null;
  return claims.sub;
}

// ---- Game Center identity check (iPhone app) -------------------------------------
// The app asks Game Center for an identity signature (GKLocalPlayer
// fetchItemsForIdentityVerificationSignature). Apple signs
//   teamPlayerID + bundle ID + timestamp (UInt64, big-endian) + salt
// with a key whose certificate is published on an apple.com address. We fetch that
// certificate over HTTPS from Apple, check the signature and that it is recent.
export const BUNDLE_ID = 'com.slingandslide.game';
const certCache = new Map();

// Minimal DER reader: enough to find the public key in an X.509 certificate.
function der(buf, pos) {
  const tag = buf[pos]; let len = buf[pos + 1], hdr = 2;
  if (len & 0x80) { const n = len & 0x7f; if (n < 1 || n > 4) throw new Error('der'); len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i]; hdr = 2 + n; }
  if (pos + hdr + len > buf.length) throw new Error('der');
  return { tag, start: pos, body: pos + hdr, end: pos + hdr + len };
}
function children(buf, el) { const out = []; for (let p = el.body; p < el.end; ) { const c = der(buf, p); out.push(c); p = c.end; } return out; }
const oidHex = (buf, el) => hex(buf.slice(el.body, el.end));
const OID_RSA = '2a864886f70d010101', OID_EC = '2a8648ce3d0201', OID_P256 = '2a8648ce3d030107', OID_P384 = '2b81040022';

export function spkiFromCert(buf) {
  const cert = der(buf, 0); const tbs = children(buf, cert)[0]; const f = children(buf, tbs);
  let i = f[0].tag === 0xa0 ? 1 : 0; // optional version
  const spki = f[i + 5]; // serial, signature alg, issuer, validity, subject, then the public key
  if (!spki || spki.tag !== 0x30) throw new Error('spki');
  const alg = children(buf, children(buf, spki)[0]);
  const kind = oidHex(buf, alg[0]);
  let algo;
  if (kind === OID_RSA) algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  else if (kind === OID_EC) { const c = oidHex(buf, alg[1]); algo = { name: 'ECDSA', namedCurve: c === OID_P256 ? 'P-256' : c === OID_P384 ? 'P-384' : '' }; if (!algo.namedCurve) throw new Error('curve'); }
  else throw new Error('key type');
  return { spki: buf.slice(spki.start, spki.end), algo };
}
// ECDSA signatures arrive DER-encoded; WebCrypto wants r||s.
function ecRaw(sig, size) {
  const seq = der(sig, 0), [r, s] = children(sig, seq);
  const fix = (el) => { let b = sig.slice(el.body, el.end); while (b.length > size && b[0] === 0) b = b.slice(1); const o = new Uint8Array(size); o.set(b, size - b.length); return o; };
  const out = new Uint8Array(size * 2); out.set(fix(r), 0); out.set(fix(s), size); return out;
}
const b64d = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));

export async function verifyGameCenter(b, env) {
  b = b && typeof b === 'object' ? b : {};
  const pid = String(b.playerId || '');
  if (!/^[A-Za-z0-9:._\-]{3,120}$/.test(pid)) return null;
  if (b.bundleId !== BUNDLE_ID) return null;
  let url; try { url = new URL(String(b.publicKeyUrl || '')); } catch (_) { return null; }
  const testOk = env.GC_TEST_KEY_ORIGIN && url.origin === env.GC_TEST_KEY_ORIGIN;
  if (!testOk && (url.protocol !== 'https:' || !/(^|\.)apple\.com$/i.test(url.hostname))) return null;
  const ts = Number(b.timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > 20 * 60e3) return null;
  let sig, salt; try { sig = b64d(b.signature); salt = b64d(b.salt); } catch (_) { return null; }
  if (!sig.length || !salt.length || salt.length > 64) return null;
  let key = certCache.get(url.href);
  if (!key) {
    const r = await fetch(url.href);
    if (!r.ok) return null;
    const { spki, algo } = spkiFromCert(new Uint8Array(await r.arrayBuffer()));
    key = { algo, k: await crypto.subtle.importKey('spki', spki, algo, false, ['verify']) };
    if (certCache.size > 20) certCache.clear();
    certCache.set(url.href, key);
  }
  const p = enc.encode(pid), bid = enc.encode(BUNDLE_ID), msg = new Uint8Array(p.length + bid.length + 8 + salt.length);
  msg.set(p, 0); msg.set(bid, p.length);
  new DataView(msg.buffer).setBigUint64(p.length + bid.length, BigInt(ts), false);
  msg.set(salt, p.length + bid.length + 8);
  let good = false;
  try {
    if (key.algo.name === 'ECDSA') good = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.k, ecRaw(sig, key.algo.namedCurve === 'P-256' ? 32 : 48), msg);
    else good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key.k, sig, msg);
  } catch (_) { good = false; }
  return good ? 'gc:' + pid : null;
}

// ---- Google Play Games (Android) ----------------------------------------------
// The app asks Play Games for a one-time "server auth code" made out to our web OAuth client.
// We swap it with Google for an access token (only our server has the client secret, so a code
// made for any other app is useless here), then ask Play Games which player it belongs to.
export async function verifyPlayGames(b, env) {
  const code = String((b && b.serverAuthCode) || '');
  if (!code || code.length > 1024 || /[\s"'<>]/.test(code)) return null;
  const cid = env.PGS_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  if (!cid || !env.PGS_CLIENT_SECRET) return null;
  const t = await fetch(env.PGS_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cid, client_secret: env.PGS_CLIENT_SECRET, grant_type: 'authorization_code', redirect_uri: '' }),
  });
  if (!t.ok) return null;
  const at = (await t.json().catch(() => ({}))).access_token;
  if (!at) return null;
  const p = await fetch((env.PGS_API || 'https://games.googleapis.com') + '/games/v1/players/me', { headers: { Authorization: 'Bearer ' + at } });
  if (!p.ok) return null;
  const pl = await p.json().catch(() => ({}));
  const id = String(pl.playerId || '');
  if (!/^[A-Za-z0-9_\-.:]{3,120}$/.test(id)) return null;
  return { sub: 'pg:' + id, name: pl.displayName };
}

// Game Center and Play Games names are chosen and checked by Apple / Google; we only tidy them up.
export function gcName(raw) {
  const n = String(raw || '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>]/g, '').replace(/\s+/g, ' ').trim();
  return [...n].slice(0, 20).join('') || 'Player';
}

// ---- Nicknames ----------------------------------------------------------------
// Rude-word check on a normalised copy (lowercase, common look-alike characters
// mapped, everything except letters removed).
const BAD_ANY = ['fuck', 'fuk', 'shit', 'cunt', 'bitch', 'nigg', 'nigga', 'faggot', 'slut', 'whore', 'rape', 'rapist', 'nazi', 'hitler', 'porn', 'penis', 'vagina', 'pussy', 'dildo', 'boob', 'retard', 'molest', 'pedo', 'paedo', 'wanker', 'bollock', 'asshole', 'arsehole', 'blowjob', 'handjob', 'masturb', 'orgasm', 'horny', 'kike', 'spic', 'chink', 'tranny', 'coon', 'heil', 'isis', 'jihad', 'suicide', 'killyourself', 'kys'];
const BAD_WORD = ['ass', 'arse', 'dick', 'cock', 'tit', 'tits', 'cum', 'sex', 'kkk', 'jizz', 'wank', 'twat', 'prick', 'fag', 'hoe', 'nude', 'nudes', 'anal', 'piss', 'crap', 'damn', 'sexy'];
const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'official', 'slingandslide', 'support', 'staff', 'developer', 'dev', 'system', 'guest', 'player', 'null', 'undefined'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i' };
const norm = (s) => s.toLowerCase().replace(/[0-9@$!|]/g, (c) => LEET[c] || c);

export function checkNick(raw) {
  const n = String(raw || '').replace(/\s+/g, ' ').trim();
  if (n.length < 3 || n.length > 14) return { error: 'length' };
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(n)) return { error: 'chars' };
  const flat = norm(n).replace(/[^a-z]/g, '');
  const squash = flat.replace(/(.)\1+/g, '$1');
  const words = norm(n).split(/[^a-z]+/).filter(Boolean);
  if (BAD_ANY.some((w) => flat.includes(w) || squash.includes(w))) return { error: 'rude' };
  if (words.some((w) => BAD_WORD.includes(w) || BAD_WORD.includes(w.replace(/s$/, '')))) return { error: 'rude' };
  if (BAD_WORD.some((w) => flat === w || squash === w)) return { error: 'rude' };
  if (RESERVED.includes(flat) || RESERVED.includes(words.join(''))) return { error: 'reserved' };
  return { nick: n };
}

// ---- Rankings entry checks ----------------------------------------------------
const MAX = { b: 5e6, s: 2e9, h: 1e6 };
const int = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0; };
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const prevMonth = (k) => { const p = k.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 2, 1)).toISOString().slice(0, 7); };
const hourKey = () => Math.floor(Date.now() / 36e5);

export function cleanEntry(d, nick) {
  d = d && typeof d === 'object' ? d : {};
  const K = monthKey(), P = prevMonth(K), H = hourKey();
  const o = { n: nick };
  for (const c of ['b', 's', 'h']) o[c] = int(d[c], MAX[c]);
  o.c = /^[a-z0-9_]{1,24}$/i.test(d.c || '') ? d.c : 'chick';
  o.d = /^[a-z0-9_]{1,24}$/i.test(d.d || '') ? d.d : 'lid';
  o.l = Math.max(1, int(d.l, 1e5));
  // month / previous month / hour / previous hour blocks (only current keys are kept)
  const blk = (kf, pre, okKeys) => {
    if (!okKeys.includes(d[kf])) return;
    const v = ['b', 's', 'h'].map((c) => Math.min(int(d[pre + c], MAX[c]), o[c]));
    if (v.some(Boolean) || kf === 'mk' || kf === 'uk') { o[kf] = d[kf]; ['b', 's', 'h'].forEach((c, i) => { o[pre + c] = v[i]; }); }
  };
  blk('mk', 'm', [K]);
  blk('pk', 'p', [P]);
  blk('uk', 'u', [H, H - 1]);
  blk('qk', 'q', [H - 1, H - 2]);
  o.t = Date.now();
  return o;
}

// ---- Durable Object -------------------------------------------------------------
const SESSION_DAYS = 365;
const MAX_SAVE = 300000;

export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql; this.lbCache = null;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, pid TEXT UNIQUE NOT NULL, nick TEXT, nick_l TEXT UNIQUE, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, sub TEXT NOT NULL, exp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_sub ON sessions(sub);
      CREATE TABLE IF NOT EXISTS saves (sub TEXT PRIMARY KEY, data TEXT NOT NULL, rev INTEGER NOT NULL, t INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lb (sub TEXT PRIMARY KEY, pid TEXT NOT NULL, doc TEXT NOT NULL, b INTEGER, s INTEGER, h INTEGER,
        mk TEXT, mb INTEGER, ms INTEGER, mh INTEGER, pk TEXT, pb INTEGER, ps INTEGER, ph INTEGER,
        uk INTEGER, ub INTEGER, us INTEGER, uh INTEGER, qk INTEGER, qb INTEGER, qs INTEGER, qh INTEGER, t INTEGER);
      CREATE INDEX IF NOT EXISTS lb_b ON lb(b);`);
  }

  one(q, ...a) { const r = this.sql.exec(q, ...a).toArray(); return r[0] || null; }

  async fetch(req) {
    const { op, sub, tok, body } = await req.json();
    const R = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
    if (op === 'lb_get') return R({ docs: this.lbDocs() });
    if (op === 'login' || op === 'login_gc') {
      if (!this.one('SELECT sub FROM users WHERE sub = ?', sub)) this.sql.exec('INSERT INTO users (sub, pid, nick, nick_l, created) VALUES (?, ?, NULL, NULL, ?)', sub, 'p' + hex(crypto.getRandomValues(new Uint8Array(10))), Date.now());
      // Game Center players appear under their Game Center name (kept up to date; not
      // part of the website's unique-nickname list)
      if (op === 'login_gc') this.sql.exec('UPDATE users SET nick = ?, nick_l = NULL WHERE sub = ?', gcName(body && body.name), sub);
      this.sql.exec('DELETE FROM sessions WHERE sub = ? AND exp < ?', sub, Date.now());
      const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.sql.exec('INSERT INTO sessions (th, sub, exp) VALUES (?, ?, ?)', await sha256(raw), sub, Date.now() + SESSION_DAYS * 864e5);
      return R({ token: raw, ...this.me(sub) });
    }
    // everything else needs a signed-in session
    const s = tok && /^[0-9a-f]{64}$/.test(tok) ? this.one('SELECT sub, exp FROM sessions WHERE th = ?', await sha256(tok)) : null;
    if (!s || s.exp < Date.now()) return R({ error: 'signed_out' }, 401);
    const u = s.sub;
    switch (op) {
      case 'me': return R(this.me(u));
      case 'signout': this.sql.exec('DELETE FROM sessions WHERE th = ?', await sha256(tok)); return R({ ok: true });
      case 'nick': {
        const cur = this.one('SELECT nick FROM users WHERE sub = ?', u);
        if (cur && cur.nick) return R({ error: 'already_set', nick: cur.nick }, 409);
        const c = checkNick(body && body.nick);
        if (c.error) return R({ error: c.error }, 400);
        if (this.one('SELECT sub FROM users WHERE nick_l = ?', c.nick.toLowerCase())) return R({ error: 'taken' }, 409);
        this.sql.exec('UPDATE users SET nick = ?, nick_l = ? WHERE sub = ?', c.nick, c.nick.toLowerCase(), u);
        return R({ nick: c.nick });
      }
      case 'save_get': {
        const v = this.one('SELECT data, rev, t FROM saves WHERE sub = ?', u);
        return R(v ? { rev: v.rev, t: v.t, data: v.data } : { rev: 0, data: null });
      }
      case 'save_put': {
        const data = body && body.data;
        if (typeof data !== 'string' || data.length > MAX_SAVE) return R({ error: 'bad_save' }, 400);
        try { const o = JSON.parse(data); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; } catch (_) { return R({ error: 'bad_save' }, 400); }
        const v = this.one('SELECT rev, data, t FROM saves WHERE sub = ?', u), cur = v ? v.rev : 0;
        if (!body.force && (body.base | 0) !== cur) return R({ error: 'conflict', rev: cur, t: v && v.t, data: v && v.data }, 409);
        const rev = cur + 1, t = Date.now();
        this.sql.exec('INSERT INTO saves (sub, data, rev, t) VALUES (?, ?, ?, ?) ON CONFLICT(sub) DO UPDATE SET data = excluded.data, rev = excluded.rev, t = excluded.t', u, data, rev, t);
        return R({ rev, t });
      }
      case 'lb_set': {
        const n = this.one('SELECT nick, pid FROM users WHERE sub = ?', u);
        if (!n || !n.nick) return R({ error: 'no_nick' }, 409);
        const o = cleanEntry(body && body.doc, n.nick);
        this.sql.exec(`INSERT INTO lb (sub, pid, doc, b, s, h, mk, mb, ms, mh, pk, pb, ps, ph, uk, ub, us, uh, qk, qb, qs, qh, t)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(sub) DO UPDATE SET pid=excluded.pid, doc=excluded.doc, b=excluded.b, s=excluded.s, h=excluded.h, mk=excluded.mk, mb=excluded.mb, ms=excluded.ms, mh=excluded.mh,
          pk=excluded.pk, pb=excluded.pb, ps=excluded.ps, ph=excluded.ph, uk=excluded.uk, ub=excluded.ub, us=excluded.us, uh=excluded.uh,
          qk=excluded.qk, qb=excluded.qb, qs=excluded.qs, qh=excluded.qh, t=excluded.t`,
          u, n.pid, JSON.stringify(o), o.b, o.s, o.h, o.mk ?? null, o.mb ?? 0, o.ms ?? 0, o.mh ?? 0, o.pk ?? null, o.pb ?? 0, o.ps ?? 0, o.ph ?? 0,
          o.uk ?? null, o.ub ?? 0, o.us ?? 0, o.uh ?? 0, o.qk ?? null, o.qb ?? 0, o.qs ?? 0, o.qh ?? 0, o.t);
        this.lbCache = null;
        return R({ ok: true, id: n.pid, doc: o });
      }
      case 'delete': {
        for (const tb of ['sessions', 'saves', 'lb', 'users']) this.sql.exec(`DELETE FROM ${tb} WHERE sub = ?`, u);
        this.lbCache = null;
        return R({ ok: true });
      }
    }
    return R({ error: 'bad_op' }, 400);
  }

  me(u) {
    const n = this.one('SELECT nick, pid FROM users WHERE sub = ?', u);
    const v = this.one('SELECT data, rev, t FROM saves WHERE sub = ?', u);
    let sum = null;
    if (v) { try { const o = JSON.parse(v.data); sum = { lvl: (o.lvl | 0) + 1, best: Math.floor(o.best || 0), gems: o.gems | 0, coins: o.coins | 0, runs: o.runs | 0 }; } catch (_) {} }
    return { id: n && n.pid, nick: (n && n.nick) || null, save: v ? { rev: v.rev, t: v.t, sum } : null };
  }

  // Everyone who could appear on any board the game shows (all-time, this and last
  // month, this and last hour, for distance, score and height).
  lbDocs() {
    if (this.lbCache && Date.now() - this.lbCache.at < 5000) return this.lbCache.docs;
    const K = monthKey(), P = prevMonth(K), H = hourKey(), seen = new Map();
    const add = (q, ...a) => { for (const r of this.sql.exec(q, ...a).toArray()) if (!seen.has(r.pid)) seen.set(r.pid, r); };
    add('SELECT pid, doc FROM lb WHERE b > 0 ORDER BY b DESC LIMIT 300');
    for (const c of ['s', 'h']) add(`SELECT pid, doc FROM lb WHERE ${c} > 0 ORDER BY ${c} DESC LIMIT 100`);
    for (const c of ['b', 's', 'h']) {
      add(`SELECT pid, doc FROM lb WHERE mk = ? AND m${c} > 0 ORDER BY m${c} DESC LIMIT 100`, K);
      add(`SELECT pid, doc FROM lb WHERE mk = ? AND m${c} > 0 ORDER BY m${c} DESC LIMIT 60`, P);
      add(`SELECT pid, doc FROM lb WHERE pk = ? AND p${c} > 0 ORDER BY p${c} DESC LIMIT 60`, P);
      add(`SELECT pid, doc FROM lb WHERE uk = ? AND u${c} > 0 ORDER BY u${c} DESC LIMIT 50`, H);
      add(`SELECT pid, doc FROM lb WHERE uk = ? AND u${c} > 0 ORDER BY u${c} DESC LIMIT 20`, H - 1);
      add(`SELECT pid, doc FROM lb WHERE qk = ? AND q${c} > 0 ORDER BY q${c} DESC LIMIT 20`, H - 1);
    }
    const docs = [...seen.values()].map((r) => ({ ...JSON.parse(r.doc), id: r.pid }));
    this.lbCache = { at: Date.now(), docs };
    return docs;
  }
}
