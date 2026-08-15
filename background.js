/* Nightlatch service worker — the single source of truth for lock state.
 *
 * THE core design decision (and the fix for a bug shared by several similar
 * extensions): unlocking on one computer must never unlock another.
 *
 *   password hash + shared prefs → chrome.storage.sync    (follow the account)
 *   lock STATE                   → chrome.storage.session (this device, this
 *                                  browser run; never synced, cleared on
 *                                  restart → always starts locked)
 *   per-device switches          → chrome.storage.local   (never synced)
 *
 * Every feature is free. There is no telemetry, no account, and no network
 * request anywhere in this extension.
 */
importScripts('crypto.js');

const PLK = NightlatchCrypto;
const IDLE_ALARM = 'plk-idle-check';
const DEFAULT_AUTOLOCK_MIN = 5;

// Data-leaking pages we cannot inject into. While locked (strict mode) they
// get redirected to locked.html. chrome://extensions is deliberately NOT here:
// it is the documented escape hatch (forgotten password / bugs) — anyone able
// to disable the extension defeats every product in this category anyway.
const GUARD_RE = /^(chrome:\/\/(settings|history|downloads|bookmarks|password-manager|new-tab-page|newtab)\b|https:\/\/chromewebstore\.google\.com\/)/i;

// ------------------------------------------------------------------- state
async function getCfg() {
  const o = await chrome.storage.sync.get({ plk_cfg: null });
  return o.plk_cfg;
}

async function setCfgPatch(patch) {
  const c = (await getCfg()) || {};
  const next = Object.assign({}, c, patch);
  await chrome.storage.sync.set({ plk_cfg: next });
  return next;
}

// Per-device overrides — same reasoning as lock state: turning idle auto-lock
// off on a personal machine must not weaken a shared one.
async function getLocalPrefs() {
  const o = await chrome.storage.local.get({ plk_device: { idleAutolock: true } });
  return o.plk_device;
}
async function setLocalPrefs(patch) {
  const p = await getLocalPrefs();
  const next = Object.assign({}, p, patch);
  // null clears a key rather than storing it: that is how a device drops its
  // own timer and goes back to following the synced default.
  Object.keys(next).forEach(function (k) { if (next[k] === null) delete next[k]; });
  await chrome.storage.local.set({ plk_device: next });
  return next;
}

// Minutes that actually apply on THIS device. 0 = idle auto-lock off (screen
// lock and browser restart still lock — those are non-negotiable).
//
// Precedence: this device's own timer, then the synced default, then the
// built-in. The device layer has to win, for the same reason lock state is
// per-device: relaxing the timer on a personal machine must never stretch the
// timer on a shared lab machine. cfg.autolockMin stays the value a freshly
// installed profile inherits, so a new machine is never left unprotected.
function effectiveAutolockMin(cfg, devicePrefs) {
  if (devicePrefs && devicePrefs.idleAutolock === false) return 0;
  if (devicePrefs && typeof devicePrefs.autolockMin === 'number') return devicePrefs.autolockMin;
  return cfg && typeof cfg.autolockMin === 'number' ? cfg.autolockMin : DEFAULT_AUTOLOCK_MIN;
}

async function isLocked() {
  const c = await getCfg();
  if (!c || !c.hash) return false; // no password set → setup mode, unlocked
  const s = await chrome.storage.session.get({ plk_unlocked: false });
  return !s.plk_unlocked;
}

async function noteActivity() {
  await chrome.storage.session.set({ plk_lastActive: Date.now() });
}

async function getReport() {
  const o = await chrome.storage.local.get({
    plk_report: { fails: 0, lastFailAt: 0, lastUnlockAt: 0, lastReportFails: 0, lastReportFailAt: 0 }
  });
  return o.plk_report;
}
async function saveReport(r) { await chrome.storage.local.set({ plk_report: r }); }

// Shared wrong-password handling (global unlock and site unlock use one
// cooldown pool so brute force can't shop between the two doors).
async function checkCooldown() {
  const s = await chrome.storage.session.get({ plk_fail: { n: 0, until: 0 } });
  const f = s.plk_fail;
  const now = Date.now();
  if (f.until && now < f.until) return { blocked: true, waitMs: f.until - now };
  return { blocked: false, f: f, now: now };
}
async function recordFail(f, now) {
  const n = (f.n || 0) + 1;
  const wait = PLK.backoffMs(n);
  await chrome.storage.session.set({ plk_fail: { n: n, until: wait ? now + wait : 0 } });
  const r = await getReport();
  r.fails += 1; r.lastFailAt = now;
  await saveReport(r);
  return { tries: n, waitMs: wait };
}

// ------------------------------------------------------------------ action
async function applyBadge(locked) {
  try {
    await chrome.action.setBadgeText({ text: locked ? '🔒' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } catch (e) { /* noop */ }
}

async function broadcastState() {
  const locked = await isLocked();
  applyBadge(locked);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (typeof t.id === 'number') {
      chrome.tabs.sendMessage(t.id, { type: 'PLK_STATE', locked: locked }).catch(function () {});
    }
  }
  if (locked) await guardSweep();
}

// Pages opened before install/enable have no content script yet — inject.
async function coverAll() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (typeof t.id !== 'number') continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['themes.js', 'content.js'] });
    } catch (e) { /* chrome:// etc. — handled by guardSweep */ }
  }
}

function redirectToLockPage(tabId, fromUrl) {
  const url = chrome.runtime.getURL('locked.html') + '?from=' + encodeURIComponent(fromUrl || '');
  chrome.tabs.update(tabId, { url: url }).catch(function () {});
}

async function guardSweep() {
  const c = await getCfg();
  if (!c || c.strict === false) return;
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.url && GUARD_RE.test(t.url) && typeof t.id === 'number') redirectToLockPage(t.id, t.url);
  }
}

async function lockNow() {
  await chrome.storage.session.remove(['plk_unlocked', 'plk_siteUnlocks']); // site passes die with the global lock
  await coverAll();
  await broadcastState();
}

async function unlockNow() {
  await chrome.storage.session.set({ plk_unlocked: true });
  await noteActivity();
  await broadcastState();
}

// -------------------------------------------------------- site protection
function siteMatches(host, sites) {
  host = String(host || '').toLowerCase();
  return (sites || []).some(function (s) {
    s = String(s || '').toLowerCase().trim();
    return s && (host === s || host.endsWith('.' + s));
  });
}

async function siteUnlocked(host) {
  const s = await chrome.storage.session.get({ plk_siteUnlocks: {} });
  return !!s.plk_siteUnlocks[host];
}

async function markSiteUnlocked(host) {
  const s = await chrome.storage.session.get({ plk_siteUnlocks: {} });
  s.plk_siteUnlocks[host] = true;
  await chrome.storage.session.set({ plk_siteUnlocks: s.plk_siteUnlocks });
}

// ---------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    try {
      if (!msg || !msg.type) { sendResponse({}); return; }

      // Config operations are only accepted from our own extension pages.
      const fromExtPage = sender && sender.url && sender.url.indexOf(chrome.runtime.getURL('')) === 0;

      if (msg.type === 'PLK_ACTIVITY') {
        if (!(await isLocked())) await noteActivity();
        sendResponse({});
        return;
      }

      if (msg.type === 'PLK_GET') {
        const c = await getCfg();
        const dev = await getLocalPrefs();
        const r = await getReport();
        sendResponse({
          locked: await isLocked(),
          hasPassword: !!(c && c.hash),
          hasRecovery: !!(c && c.rcHash),
          idleAutolock: dev.idleAutolock !== false,
          autolockMin: effectiveAutolockMin(c, dev),
          storedAutolockMin: c && typeof c.autolockMin === 'number' ? c.autolockMin : DEFAULT_AUTOLOCK_MIN,
          deviceAutolockMin: typeof dev.autolockMin === 'number' ? dev.autolockMin : null,
          strict: c ? c.strict !== false : true,
          theme: (c && c.theme) || 'dark',
          sites: (c && Array.isArray(c.sites)) ? c.sites : [],
          report: {
            lastUnlockAt: r.lastUnlockAt,
            pendingFails: r.fails,
            lastReportFails: r.lastReportFails,
            lastReportFailAt: r.lastReportFailAt
          }
        });
        return;
      }

      if (msg.type === 'PLK_UNLOCK') {
        const c = await getCfg();
        if (!c || !c.hash) { sendResponse({ ok: true, note: 'no-password' }); return; }
        const cd = await checkCooldown();
        if (cd.blocked) { sendResponse({ ok: false, waitMs: cd.waitMs, cooldown: true }); return; }
        const good = await PLK.verifyPassword(String(msg.password || ''), c);
        if (good) {
          await chrome.storage.session.set({ plk_fail: { n: 0, until: 0 } });
          const r = await getReport();
          const reportOut = { fails: r.fails, lastFailAt: r.lastFailAt };
          await saveReport({
            fails: 0, lastFailAt: 0, lastUnlockAt: cd.now,
            lastReportFails: r.fails, lastReportFailAt: r.lastFailAt
          });
          await unlockNow();
          sendResponse({ ok: true, report: reportOut });
        } else {
          const res = await recordFail(cd.f, cd.now);
          sendResponse({ ok: false, tries: res.tries, waitMs: res.waitMs });
        }
        return;
      }

      if (msg.type === 'PLK_SITE_CHECK') {
        const c = await getCfg();
        if (!c || !c.hash || !Array.isArray(c.sites) || !siteMatches(msg.host, c.sites)) {
          sendResponse({ protected: false });
          return;
        }
        sendResponse({ protected: true, unlocked: await siteUnlocked(String(msg.host || '').toLowerCase()) });
        return;
      }

      if (msg.type === 'PLK_SITE_UNLOCK') {
        const c = await getCfg();
        if (!c || !c.hash) { sendResponse({ ok: true }); return; }
        const cd = await checkCooldown();
        if (cd.blocked) { sendResponse({ ok: false, waitMs: cd.waitMs, cooldown: true }); return; }
        const good = await PLK.verifyPassword(String(msg.password || ''), c);
        if (good) {
          await chrome.storage.session.set({ plk_fail: { n: 0, until: 0 } });
          await markSiteUnlocked(String(msg.host || '').toLowerCase());
          sendResponse({ ok: true });
        } else {
          const res = await recordFail(cd.f, cd.now);
          sendResponse({ ok: false, tries: res.tries, waitMs: res.waitMs });
        }
        return;
      }

      if (msg.type === 'PLK_LOCK') { await lockNow(); sendResponse({ ok: true }); return; }

      if (msg.type === 'PLK_SET_DEVICE') {
        if (!fromExtPage) { sendResponse({ ok: false, msg: 'denied' }); return; }
        if (await isLocked()) { sendResponse({ ok: false, msg: 'locked' }); return; }
        const patch = {};
        if (typeof msg.idleAutolock === 'boolean') patch.idleAutolock = msg.idleAutolock;
        // Same 1–480 clamp as the synced timer. null drops the override.
        if (typeof msg.autolockMin === 'number') {
          patch.autolockMin = Math.max(1, Math.min(480, Math.round(msg.autolockMin)));
        } else if (msg.autolockMin === null) {
          patch.autolockMin = null;
        }
        await setLocalPrefs(patch);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'PLK_SET_PASSWORD') {
        if (!fromExtPage) { sendResponse({ ok: false, msg: 'denied' }); return; }
        const c = await getCfg();
        if (c && c.hash) {
          const good = await PLK.verifyPassword(String(msg.current || ''), c);
          if (!good) { sendResponse({ ok: false, msg: 'Wrong current password' }); return; }
        }
        const next = String(msg.next || '');
        if (next.length < 4) { sendResponse({ ok: false, msg: 'New password must be at least 4 characters' }); return; }
        const rec = await PLK.hashPassword(next);
        // A recovery code is a password-equivalent credential, so it is
        // rotated whenever the password is. Changing the password because you
        // think it leaked would be pointless if an old code kept working.
        const code = PLK.makeRecoveryCode();
        const rcRec = await PLK.hashPassword(PLK.normalizeRecoveryCode(code));
        await setCfgPatch({
          hash: rec.hash, salt: rec.salt, iter: rec.iter,
          rcHash: rcRec.hash, rcSalt: rcRec.salt, rcIter: rcRec.iter
        });
        await unlockNow(); // you just proved you're the owner
        // Returned exactly once. Only the hash was stored, so if the user
        // loses this there is no way to show it again.
        sendResponse({ ok: true, recoveryCode: code });
        return;
      }

      // Forgotten password. Trades a valid recovery code for a new password,
      // and issues a fresh code so the used one stops working.
      if (msg.type === 'PLK_RECOVER') {
        if (!fromExtPage) { sendResponse({ ok: false, msg: 'denied' }); return; }
        const c = await getCfg();
        if (!c || !c.rcHash) { sendResponse({ ok: false, msg: 'No recovery code is set on this profile' }); return; }
        // Shares the cooldown pool with the password door, so an attacker
        // cannot shop between the two.
        const cd = await checkCooldown();
        if (cd.blocked) { sendResponse({ ok: false, waitMs: cd.waitMs, cooldown: true }); return; }
        const typed = PLK.normalizeRecoveryCode(msg.code);
        const good = typed.length === PLK.recoveryCodeLength() && await PLK.verifyPassword(
          typed, { hash: c.rcHash, salt: c.rcSalt, iter: c.rcIter });
        if (!good) {
          const res = await recordFail(cd.f, cd.now);
          sendResponse({ ok: false, msg: 'That recovery code is not valid', tries: res.tries, waitMs: res.waitMs });
          return;
        }
        const next = String(msg.next || '');
        if (next.length < 4) { sendResponse({ ok: false, msg: 'New password must be at least 4 characters' }); return; }
        const rec = await PLK.hashPassword(next);
        const code = PLK.makeRecoveryCode();
        const rcRec = await PLK.hashPassword(PLK.normalizeRecoveryCode(code));
        await chrome.storage.session.set({ plk_fail: { n: 0, until: 0 } });
        await setCfgPatch({
          hash: rec.hash, salt: rec.salt, iter: rec.iter,
          rcHash: rcRec.hash, rcSalt: rcRec.salt, rcIter: rcRec.iter
        });
        await unlockNow();
        sendResponse({ ok: true, recoveryCode: code });
        return;
      }

      if (msg.type === 'PLK_SET_CFG') {
        if (!fromExtPage) { sendResponse({ ok: false, msg: 'denied' }); return; }
        if (await isLocked()) { sendResponse({ ok: false, msg: 'locked' }); return; }
        const patch = {};
        if (typeof msg.autolockMin === 'number') {
          patch.autolockMin = Math.max(1, Math.min(480, Math.round(msg.autolockMin)));
        }
        if (typeof msg.strict === 'boolean') patch.strict = msg.strict;
        if (typeof msg.theme === 'string') patch.theme = msg.theme;
        if (Array.isArray(msg.sites)) {
          patch.sites = msg.sites
            .map(function (s) { return String(s || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); })
            .filter(function (s) { return /^[a-z0-9.-]+$/.test(s); })
            .slice(0, 100);
        }
        await setCfgPatch(patch);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({});
    } catch (e) {
      try { sendResponse({ ok: false, msg: String(e && e.message || e) }); } catch (_) { /* channel gone */ }
    }
  })();
  return true; // keep channel open for async response
});

// ----------------------------------------------- profile-scoped auto-lock
// Interacting with this profile's windows counts as activity too (clicks on
// the browser UI itself produce no page events, but focus/tab switches do).
chrome.windows.onFocusChanged.addListener(function (windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  (async function () { if (!(await isLocked())) await noteActivity(); })();
});
chrome.tabs.onActivated.addListener(function () {
  (async function () { if (!(await isLocked())) await noteActivity(); })();
});

// The minute-tick that decides "this profile has sat untouched long enough".
chrome.alarms.onAlarm.addListener(function (a) {
  if (a.name !== IDLE_ALARM) return;
  (async function () {
    const c = await getCfg();
    if (!c || !c.hash) return;
    const min = effectiveAutolockMin(c, await getLocalPrefs());
    if (min <= 0) return; // idle auto-lock off on this device
    if (await isLocked()) return;
    const s = await chrome.storage.session.get({ plk_lastActive: 0 });
    if (!s.plk_lastActive) { await noteActivity(); return; } // first tick: start the clock
    if (Date.now() - s.plk_lastActive < min * 60000) return;
    // media exception: a tab playing sound (video call, music) counts as in use
    try {
      const audible = await chrome.tabs.query({ audible: true });
      if (audible.length) { await noteActivity(); return; }
    } catch (e) { /* noop */ }
    await lockNow();
  })();
});

function ensureAlarm() {
  chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
}
ensureAlarm(); // idempotent — runs on every service-worker wake

// OS screen lock (Win+L / walk-away lock) → lock this profile immediately.
// System-wide "idle" is deliberately ignored: on a shared computer someone
// else's activity must not keep your profile unlocked.
chrome.idle.onStateChanged.addListener(function (state) {
  (async function () {
    const c = await getCfg();
    if (!c || !c.hash) return;
    if (state === 'locked') await lockNow();
  })();
});

chrome.commands.onCommand.addListener(function (cmd) {
  if (cmd === 'lock-now') lockNow();
});

// While locked (strict), keep data pages unreachable — including mid-session
// navigations and freshly opened tabs.
chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  (async function () {
    const url = info.url || info.pendingUrl || (info.status === 'loading' ? tab.url : null);
    if (!url || !GUARD_RE.test(url)) return;
    if (!(await isLocked())) return;
    const c = await getCfg();
    if (c && c.strict === false) return;
    redirectToLockPage(tabId, url);
  })();
});

// ------------------------------------------------------------- lifecycle
chrome.runtime.onInstalled.addListener(function () {
  (async function () {
    ensureAlarm();
    await coverAll();
    await broadcastState();
    const c = await getCfg();
    if (!c || !c.hash) chrome.runtime.openOptionsPage(); // first-run setup
  })();
});

// Browser restart: session storage is empty → locked by definition. Just
// repaint badges and overlays.
chrome.runtime.onStartup.addListener(function () {
  (async function () {
    ensureAlarm();
    await broadcastState();
  })();
});
