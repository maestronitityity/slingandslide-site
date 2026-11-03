// Native app glue for Sling & Slide: real in-app purchases (StoreKit / Google Play)
// and Game Center leaderboards. Loaded after the game script.
//
// In a normal browser this file does nothing, so the game keeps its test shop and
// local leaderboard for development and the claude.ai preview.
(() => {
  'use strict';
  const C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return;

  const platform = C.getPlatform();
  const NP = C.registerPlugin('NativePurchases');
  const GCP = platform === 'ios' ? C.registerPlugin('GameCenter') : null;

  // ---- Product and leaderboard IDs (must match App Store Connect) ----------
  const PRE = 'com.slingandslide.game.';
  const PACK_IDS = PACKS.map((p) => PRE + 'gems' + p[0]); // gems80 … gems14000
  const STARTER_ID = PRE + 'starter';
  const ALL_IDS = [...PACK_IDS, STARTER_ID];
  const LB_ALL_TIME = 'best_distance';
  const LB_WEEKLY = 'weekly_distance';

  // ---- Helpers -------------------------------------------------------------
  const say = (msg) => {
    try {
      smsg = msg;
      if (st === 'menu' || st === 'over') showMenu(lastMsg);
    } catch (_) {}
  };
  const errText = (e) => String((e && (e.message || e.errorMessage)) || e || 'Unknown error');

  // Transaction IDs already credited, so a purchase can never be granted twice
  // (e.g. if the app closes between paying and finishing the transaction).
  const seen = () => (save.iapTx = Array.isArray(save.iapTx) ? save.iapTx : []);
  const remember = (txId) => {
    if (!txId) return;
    const list = seen();
    list.push(String(txId));
    if (list.length > 200) list.splice(0, list.length - 200);
  };

  function grant(productId, txId) {
    if (txId && seen().includes(String(txId))) return false;
    const i = PACK_IDS.indexOf(productId);
    let msg = null;
    if (i >= 0) {
      save.gems += PACKS[i][0];
      msg = '+' + PACKS[i][0].toLocaleString() + ' 💎';
    } else if (productId === STARTER_ID) {
      if (!save.st1) {
        save.gems += 200;
        save.coins += 10000;
        save.st1 = true;
        msg = 'Starter Pack: +200 💎 +10,000 🪙';
      }
    } else {
      return false; // unknown product: leave the transaction alone
    }
    remember(txId);
    try { fxOk = 1; } catch (_) {}
    persist();
    if (msg) say(msg);
    return true;
  }

  async function finish(tx) {
    if (!tx || !tx.transactionId) return;
    try {
      if (platform === 'ios') {
        await NP.finishTransaction({ transactionId: tx.transactionId });
      } else if (tx.purchaseToken) {
        // Google Play: diamond packs are consumed so they can be bought again;
        // the one-time Starter Pack is acknowledged instead.
        if (tx.productIdentifier === STARTER_ID) await NP.acknowledgePurchase({ purchaseToken: tx.purchaseToken });
        else await NP.consumePurchase({ purchaseToken: tx.purchaseToken });
      }
    } catch (_) {}
  }

  // ---- App version (shown at the bottom of Settings) ---------------------
  C.registerPlugin('App').getInfo()
    .then((i) => { window.APP_VER = i.version + ' (' + i.build + ')'; try { if (setOpen) renderSet(); } catch (_) {} })
    .catch(() => {});

  // ---- In-app purchases ----------------------------------------------------
  const IAP = (window.IAP = { native: true, ready: false, busy: false, starterPrice: null });

  NP.configure({ autoFinishTransactions: false }).catch(() => {});

  // Purchases completed outside the buy button (Ask to Buy approval, a purchase
  // interrupted by the app closing, etc.) arrive here.
  NP.addListener('transactionUpdated', async (tx) => {
    if (!tx || ALL_IDS.indexOf(tx.productIdentifier) < 0) return;
    if (tx.revocationDate) return;
    grant(tx.productIdentifier, tx.transactionId);
    await finish(tx);
  }).catch(() => {});

  // Show the store's real, localised prices (e.g. "A$1.49") instead of the
  // placeholder dollar prices in the game.
  NP.getProducts({ productIdentifiers: ALL_IDS, productType: 'inapp' })
    .then(({ products }) => {
      for (const p of products || []) {
        const i = PACK_IDS.indexOf(p.identifier);
        if (i >= 0 && p.priceString) PACKS[i][1] = p.priceString;
        if (p.identifier === STARTER_ID && p.priceString) IAP.starterPrice = p.priceString;
      }
      IAP.ready = true;
      try { if (st === 'menu' && tab === 'shop') showMenu(lastMsg); } catch (_) {}
    })
    .catch(() => {});

  IAP.buy = async (productId) => {
    if (IAP.busy) return;
    IAP.busy = true;
    try {
      const tx = await NP.purchaseProduct({
        productIdentifier: productId,
        productType: 'inapp',
        quantity: 1,
        isConsumable: productId !== STARTER_ID,
        autoAcknowledgePurchases: false,
      });
      if (tx && tx.productIdentifier) {
        grant(tx.productIdentifier, tx.transactionId);
        await finish(tx);
      }
    } catch (e) {
      const m = errText(e);
      if (!/cancel/i.test(m)) say('Purchase didn’t go through: ' + m);
    } finally {
      IAP.busy = false;
    }
  };

  // Apple requires a way to restore one-time purchases (the Starter Pack).
  IAP.restore = async () => {
    if (IAP.busy) return;
    IAP.busy = true;
    say('Restoring purchases…');
    try {
      await NP.restorePurchases();
      const { purchases } = await NP.getPurchases({ productType: 'inapp', onlyCurrentEntitlements: true });
      const owned = (purchases || []).some((t) => t.productIdentifier === STARTER_ID && !t.revocationDate);
      if (owned && !save.st1) {
        save.st1 = true;
        persist();
        say('Starter Pack restored');
      } else {
        say(owned ? 'Purchases are up to date' : 'Nothing to restore');
      }
    } catch (e) {
      say('Restore failed: ' + errText(e));
    } finally {
      IAP.busy = false;
    }
  };

  // Route the shop's buttons to the real store.
  window.testBuy = (i) => IAP.buy(PACK_IDS[i]);
  window.buyStarter = () => { if (!save.st1) IAP.buy(STARTER_ID); };

  // ---- Game Center leaderboards (iOS) --------------------------------------
  const GC = (window.GC = { ok: false });
  if (GCP) {
    const submit = (score, ids) => {
      if (!GC.ok || !(score > 0)) return;
      GCP.submitScore({ leaderboardIds: ids, score: Math.floor(score) }).catch(() => {});
    };

    GCP.addListener('authChanged', (r) => { GC.ok = !!(r && r.authenticated); }).catch(() => {});
    GCP.authenticate()
      .then((r) => {
        GC.ok = !!(r && r.authenticated);
        // Carry over a best distance set before Game Center was signed in.
        if (GC.ok) submit(save.best, [LB_ALL_TIME]);
      })
      .catch(() => {});

    // Post every finished run; Game Center keeps each player's best.
    const origEnd = window.end;
    window.end = function () {
      let runDist = 0;
      try { runDist = dist; } catch (_) {} // read first: end() resets dist for the next run
      const r = origEnd.apply(this, arguments);
      submit(runDist, [LB_ALL_TIME, LB_WEEKLY]);
      return r;
    };

    // The 🏆 button opens the Game Center leaderboards when signed in.
    const origLb = window.lbShow;
    window.lbShow = function () {
      if (!GC.ok) return origLb.apply(this, arguments);
      GCP.showLeaderboard({ leaderboardId: LB_ALL_TIME }).catch(() => origLb());
    };
  }
})();
