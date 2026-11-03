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
