// Sling & Slide web shop API (Cloudflare Worker).
//
// The browser game never sees the Stripe key and never decides what a purchase is
// worth: prices and rewards live here. Flow:
//   POST /checkout {item, device}  -> Stripe Checkout session (card is only authorised)
//   POST /claim    {id, device}    -> checks the session, then
//        Australian card -> captures the payment and returns the reward
//        other card      -> cancels the authorisation (player is not charged)
// Because the money is only captured when the player's own game collects the reward,
// an abandoned or failed return never charges anyone (Stripe drops the hold).
// Claiming again with the same device returns the same reward, and the game
// ignores sessions it has already credited, so retries are safe.

export const ITEMS = {
  p0: { name: '80 Diamonds', aud: 99, gems: 80, coins: 0 },
  p1: { name: '500 Diamonds', aud: 499, gems: 500, coins: 0 },
  p2: { name: '1,200 Diamonds', aud: 999, gems: 1200, coins: 0 },
  p3: { name: '3,000 Diamonds', aud: 1999, gems: 3000, coins: 0 },
  p4: { name: '6,500 Diamonds', aud: 4999, gems: 6500, coins: 0 },
  p5: { name: '14,000 Diamonds', aud: 9999, gems: 14000, coins: 0 },
  starter: { name: 'Starter Pack', aud: 299, gems: 200, coins: 10000, once: true },
};

const ALLOWED_ORIGINS = [
  'https://slingandslide.com',
  'https://www.slingandslide.com',
  'https://maestronitityity.github.io',
];
const SITE = 'https://slingandslide.com/play/';
const COUNTRIES = ['AU'];
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

const modeOf = (key) => (/^(sk|rk)_live_/.test(key || '') ? 'live' : 'test');

function cors(origin, env) {
  const extra = (env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = ALLOWED_ORIGINS.includes(origin) || extra.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, headers) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

// Minimal Stripe REST client (form encoded, no SDK needed in a Worker).
function form(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(env, method, path, params) {
  const url = `https://api.stripe.com/v1/${path}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_KEY}`, 'Stripe-Version': '2024-06-20' },
  };
  let target = url;
  if (params && method === 'GET') target += `?${form(params)}`;
  else if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = form(params).toString();
  }
  const r = await fetch(target, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((body.error && body.error.message) || `Stripe ${r.status}`);
    e.stripe = body.error || {};
    e.status = r.status;
    throw e;
  }
  return body;
}

const reward = (itemId) => {
  const it = ITEMS[itemId];
  return { item: itemId, gems: it.gems, coins: it.coins, once: !!it.once, name: it.name };
};

async function checkout(req, env, h) {
  const b = await req.json().catch(() => ({}));
  const it = ITEMS[b.item];
  if (!it) return json({ error: 'unknown_item' }, 400, h);
  if (!DEVICE_RE.test(b.device || '')) return json({ error: 'bad_device' }, 400, h);
  const base = env.SITE_URL || SITE;
  const s = await stripe(env, 'POST', 'checkout/sessions', {
    mode: 'payment',
    payment_method_types: ['card'], // cards, Apple Pay and Google Pay
    line_items: { 0: { quantity: 1, price_data: { currency: 'aud', unit_amount: it.aud, product_data: { name: `Sling & Slide: ${it.name}` } } } },
    payment_intent_data: {
      capture_method: 'manual',
      description: `Sling & Slide web: ${it.name}`,
      metadata: { app: 'sling-web', item: b.item, device: b.device },
    },
    metadata: { app: 'sling-web', item: b.item, device: b.device },
    success_url: `${base}?paid={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}?shop=cancel`,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    custom_text: { submit: { message: 'Australian cards only for now (you are not charged if your card is from elsewhere). Your items are added to the browser you are playing in.' } },
    locale: 'auto',
  });
  return json({ id: s.id, url: s.url }, 200, h);
}

async function claim(req, env, h) {
  const b = await req.json().catch(() => ({}));
  if (!SESSION_RE.test(b.id || '') || !DEVICE_RE.test(b.device || '')) return json({ error: 'bad_request' }, 400, h);
  let s;
  try {
    s = await stripe(env, 'GET', `checkout/sessions/${b.id}`, { 'expand[]': 'payment_intent.latest_charge' });
  } catch (e) {
    if (e.status === 404) return json({ state: 'gone' }, 200, h);
    throw e;
  }
  const md = s.metadata || {};
  if (md.app !== 'sling-web' || !ITEMS[md.item]) return json({ state: 'gone' }, 200, h);
  if (md.device !== b.device) return json({ state: 'other_device' }, 200, h);
  if (s.status === 'open') return json({ state: 'open' }, 200, h);
  if (s.status === 'expired') return json({ state: 'gone' }, 200, h);
  const pi = s.payment_intent;
  if (!pi || typeof pi !== 'object') return json({ state: 'gone' }, 200, h);

  if (pi.status === 'succeeded') return json({ state: 'paid', reward: reward(md.item) }, 200, h);
  if (pi.status === 'canceled') {
    return json({ state: pi.metadata && pi.metadata.reason === 'country' ? 'country' : 'gone' }, 200, h);
  }
  if (pi.status !== 'requires_capture') return json({ state: 'open' }, 200, h);

  const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const country = ch && ch.payment_method_details && ch.payment_method_details.card && ch.payment_method_details.card.country;
  if (!COUNTRIES.includes(country)) {
    await stripe(env, 'POST', `payment_intents/${pi.id}`, { metadata: { reason: 'country', card_country: country || 'unknown' } });
    await stripe(env, 'POST', `payment_intents/${pi.id}/cancel`, { cancellation_reason: 'abandoned' });
    return json({ state: 'country' }, 200, h);
  }
  let done;
  try {
    done = await stripe(env, 'POST', `payment_intents/${pi.id}/capture`, {});
  } catch (e) {
    // Two claims racing: the other one captured it first.
    const again = await stripe(env, 'GET', `payment_intents/${pi.id}`);
    if (again.status === 'succeeded') return json({ state: 'paid', reward: reward(md.item) }, 200, h);
    throw e;
  }
  if (done.status !== 'succeeded') return json({ state: 'open' }, 200, h);
  return json({ state: 'paid', reward: reward(md.item) }, 200, h);
}

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get('Origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const { pathname } = new URL(req.url);
    try {
      if (!env.STRIPE_KEY) return json({ error: 'not_configured' }, 503, h);
      if (req.method === 'GET' && pathname === '/config') {
        const items = Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [k, { aud: v.aud }]));
        return json({ mode: modeOf(env.STRIPE_KEY), currency: 'aud', countries: COUNTRIES, items }, 200, h);
      }
      if (req.method === 'POST' && pathname === '/checkout') return await checkout(req, env, h);
      if (req.method === 'POST' && pathname === '/claim') return await claim(req, env, h);
      return json({ error: 'not_found' }, 404, h);
    } catch (e) {
      console.log('shop error', pathname, e.status || '', e.message);
      return json({ error: 'server' }, 502, h);
    }
  },
};
