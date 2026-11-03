// Web version of Sling & Slide (slingandslide.com/play). Loaded after the game.
// Real purchases only exist in the app, so in the browser the Shop's diamond packs
// and Starter Pack point players to the app instead of giving free test items.
(() => {
  'use strict';
  const MSG = 'Diamond packs and the Starter Pack are in the Sling & Slide app, coming soon to the App Store';
  const say = () => { try { smsg = MSG; showMenu(lastMsg); } catch (_) {} };
  window.IAP = { native: false, web: true, ready: true, busy: false, starterPrice: 'In app', buy: say, restore: say };
  try { PACKS.forEach((p) => { p[1] = 'In app'; }); } catch (_) {}
  window.testBuy = say;
  window.buyStarter = say;
  try { if (st === 'menu' && tab === 'shop') showMenu(lastMsg); } catch (_) {}
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
