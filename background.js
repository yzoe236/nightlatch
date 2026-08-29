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

// Shared wrong-secret handling. Every door that checks a credential (unlock,
// site unlock, recovery, and the current-password field when changing it)
// draws on one cooldown pool, so brute force cannot shop between them.
//
// Reading the counter, verifying, and writing the counter back straddle
// awaits, so a burst of concurrent guesses could each read the same
// pre-increment value and collect its own free try. Every check queues on
// this chain instead, which both closes that race and serialises a burst
// rather than letting it run in parallel.
let credentialGate = Promise.resolve();

// verify() must resolve to a boolean. Resolves to one of:
//   { blocked: true, waitMs }            cooling down, nothing was checked
//   { ok: true, now }                    correct
//   { ok: false, tries, waitMs }         wrong, and now counted
function guardedVerify(verify) {
  const run = credentialGate.then(async function () {
    const s = await chrome.storage.session.get({ plk_fail: { n: 0, until: 0 } });
    const f = s.plk_fail;
    const now = Date.now();
    if (f.until && now < f.until) return { blocked: true, waitMs: f.until - now };
    if (await verify()) return { ok: true, now: now };
    const n = (f.n || 0) + 1;
    const wait = PLK.backoffMs(n);
    await chrome.storage.session.set({ plk_fail: { n: n, until: wait ? now + wait : 0 } });
    const r = await getReport();
    r.fails += 1; r.lastFailAt = now;
    await saveReport(r);
    return { ok: false, tries: n, waitMs: wait };
  });
  // Keep the chain alive even if a verify throws, or one bad call would wedge
  // every future credential check.
  credentialGate = run.then(function () {}, function () {});
  return run;
}

async function clearFails() {
  await chrome.storage.session.set({ plk_fail: { n: 0, until: 0 } });
}

// Locking and unlocking both read state, decide, and write back across several
// awaits. Run two at once and one silently overwrites the other — an idle
// timeout that started deciding before the password was typed still gets to
// throw the unlock away, which reads to the user as "it asked me again".
// Both queue on one chain, the same technique the credential checks use.
let stateGate = Promise.resolve();
function serialise(fn) {
  const run = stateGate.then(fn);
  stateGate = run.then(function () {}, function () {});
  return run;
}

// Why this profile locked, so a lock nobody expected can be explained after
// the fact. Timestamps and a reason string only — no URLs, no credentials.
//
// Read-modify-write, so two triggers landing together would otherwise drop an
// entry, and a log that quietly loses the interesting line is worse than none.
// Its own chain, not the state one: writing the log must never be able to wait
// on a lock that is waiting on the log.
const LOCK_LOG_MAX = 20;
let lockLogGate = Promise.resolve();
function noteLockEvent(why, did) {
  const run = lockLogGate.then(async function () {
    try {
      const o = await chrome.storage.local.get({ plk_lockLog: [] });
      const log = Array.isArray(o.plk_lockLog) ? o.plk_lockLog : [];
      log.unshift({ at: Date.now(), why: why, did: !!did });
      await chrome.storage.local.set({ plk_lockLog: log.slice(0, LOCK_LOG_MAX) });
    } catch (e) { /* diagnostics must never break locking */ }
  });
  lockLogGate = run.then(function () {}, function () {});
  return run;
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

// `confirm` is for callers whose decision was made earlier and may since have
// gone stale. It is re-run at the moment of writing, with the gate held, so a
// timer that decided to lock cannot act on a clock reading that an unlock or a
// keystroke has already replaced. Callers who mean "lock right now" (screen
// lock, Ctrl+Shift+L, the popup button) pass nothing and always win.
async function lockNow(why, confirm) {
  const did = await serialise(async function () {
    if (confirm && !(await confirm())) return false;
    await chrome.storage.session.remove(['plk_unlocked', 'plk_siteUnlocks']); // site passes die with the global lock
    return true;
  });
  await noteLockEvent(why || 'manual', did);
  if (!did) return false;
  await coverAll();
  await broadcastState();
  return true;
}

async function unlockNow() {
  // One write, not two: between setting the flag and stamping the clock there
  // used to be a window where the profile was unlocked but still looked hours
  // idle, and an alarm landing in it locked straight back.
  //
  // plk_unlockedAt is separate from plk_lastActive on purpose. Ordinary
  // browsing keeps refreshing plk_lastActive, so it cannot answer "did a human
  // just prove they hold the password"; only this one can, and the screen-lock
  // listener needs exactly that question answered.
  await serialise(function () {
    const now = Date.now();
    return chrome.storage.session.set({ plk_unlocked: true, plk_lastActive: now, plk_unlockedAt: now });
  });
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
        // Content scripts run inside whatever page is open, so they get only
        // what the overlay actually needs: is it locked, and which theme.
        // The protected-site list, the failed-attempt log and the rest are
        // for the extension's own pages. All three fields below are already
        // inferable from whether a lock screen appears.
        if (!fromExtPage) {
          sendResponse({
            locked: await isLocked(),
            hasPassword: !!(c && c.hash),
            theme: (c && c.theme) || 'dark'
          });
          return;
        }
        const dev = await getLocalPrefs();
        const r = await getReport();
        const lg = await chrome.storage.local.get({ plk_lockLog: [] });
        sendResponse({
          lockLog: Array.isArray(lg.plk_lockLog) ? lg.plk_lockLog : [],
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
        const v = await guardedVerify(function () { return PLK.verifyPassword(String(msg.password || ''), c); });
        if (v.blocked) { sendResponse({ ok: false, waitMs: v.waitMs, cooldown: true }); return; }
        if (v.ok) {
          await clearFails();
          const r = await getReport();
          const reportOut = { fails: r.fails, lastFailAt: r.lastFailAt };
          await saveReport({
            fails: 0, lastFailAt: 0, lastUnlockAt: v.now,
            lastReportFails: r.fails, lastReportFailAt: r.lastFailAt
          });
          await unlockNow();
          sendResponse({ ok: true, report: reportOut });
        } else {
          sendResponse({ ok: false, tries: v.tries, waitMs: v.waitMs });
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
        const v = await guardedVerify(function () { return PLK.verifyPassword(String(msg.password || ''), c); });
        if (v.blocked) { sendResponse({ ok: false, waitMs: v.waitMs, cooldown: true }); return; }
        if (v.ok) {
          await clearFails();
          await markSiteUnlocked(String(msg.host || '').toLowerCase());
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, tries: v.tries, waitMs: v.waitMs });
        }
        return;
      }

      if (msg.type === 'PLK_LOCK') { await lockNow('popup'); sendResponse({ ok: true }); return; }


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
        const next = String(msg.next || '');
        if (next.length < 4) { sendResponse({ ok: false, msg: 'New password must be at least 4 characters' }); return; }
        if (c && c.hash) {
          // Changing the password is an unlock path: it ends in unlockNow()
          // and hands back a fresh recovery code. Unlock first, so the only
          // ways into a locked profile stay PLK_UNLOCK and PLK_RECOVER.
          if (await isLocked()) { sendResponse({ ok: false, msg: 'locked' }); return; }
          // fromExtPage is satisfied by the extension's own lock screen, so
          // without this the current-password field was an unthrottled door
          // into the same account the throttled ones protect.
          const v = await guardedVerify(function () { return PLK.verifyPassword(String(msg.current || ''), c); });
          if (v.blocked) { sendResponse({ ok: false, msg: 'Too many attempts', waitMs: v.waitMs, cooldown: true }); return; }
          if (!v.ok) { sendResponse({ ok: false, msg: 'Wrong current password', tries: v.tries, waitMs: v.waitMs }); return; }
          // guardedVerify queues behind every other credential check, so the
          // isLocked() above can be minutes old by now. Ask again, or a lock
          // that landed while this waited would be undone by the unlockNow()
          // at the end of this branch — the exact thing the check above is
          // there to prevent.
          if (await isLocked()) { sendResponse({ ok: false, msg: 'locked' }); return; }
          await clearFails();
        }
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
        // Shape of the request is checked before the credential is, so a
        // malformed password can never produce a different answer depending on
        // whether the code was right. Nothing is learnable from the error text.
        const next = String(msg.next || '');
        if (next.length < 4) { sendResponse({ ok: false, msg: 'New password must be at least 4 characters' }); return; }
        const typed = PLK.normalizeRecoveryCode(msg.code);
        const v = await guardedVerify(function () {
          if (typed.length !== PLK.recoveryCodeLength()) return false;
          return PLK.verifyPassword(typed, { hash: c.rcHash, salt: c.rcSalt, iter: c.rcIter });
        });
        if (v.blocked) { sendResponse({ ok: false, msg: 'Too many attempts', waitMs: v.waitMs, cooldown: true }); return; }
        if (!v.ok) {
          sendResponse({ ok: false, msg: 'That recovery code is not valid', tries: v.tries, waitMs: v.waitMs });
          return;
        }
        const rec = await PLK.hashPassword(next);
        const code = PLK.makeRecoveryCode();
        const rcRec = await PLK.hashPassword(PLK.normalizeRecoveryCode(code));
        await clearFails();
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
    // Everything above straddles awaits, and the tab query in particular is
    // slow enough to cover a whole unlock. Ask the clock again on the way in.
    await lockNow('idle-timeout', async function () {
      const now = await chrome.storage.session.get({ plk_lastActive: 0 });
      return !!now.plk_lastActive && Date.now() - now.plk_lastActive >= min * 60000;
    });
  })();
});

// What the screen is doing right now, asked rather than remembered.
//
// Callback form on purpose. chrome.idle gained promise support later than the
// oldest Chrome this runs on, and there the promise call returns undefined,
// which would read as "not locked" and skip a lock that should happen. Every
// way this can go wrong — old Chrome, an API error, no answer at all —
// resolves to 'locked', so a lost answer is never a lost lock.
function currentIdleState() {
  return new Promise(function (resolve) {
    let done = false;
    function finish(s) { if (!done) { done = true; resolve(s); } }
    setTimeout(function () { finish('locked'); }, 2000);
    try {
      chrome.idle.queryState(15, function (s) {
        finish(chrome.runtime.lastError || !s ? 'locked' : s);
      });
    } catch (e) { finish('locked'); }
  });
}

function ensureAlarm() {
  chrome.alarms.create(IDLE_ALARM, { periodInMinutes: 1 });
}
ensureAlarm(); // idempotent — runs on every service-worker wake

// OS screen lock (Win+L / walk-away lock) → lock this profile immediately.
// System-wide "idle" is deliberately ignored: on a shared computer someone
// else's activity must not keep your profile unlocked.
//
// The event says what the screen was doing when it was sent, and this listener
// can run much later: an idle service worker is torn down, and the event that
// wakes it back up has already waited. A 'locked' landing after the user has
// sat down and typed their password locks them straight back out, which is
// indistinguishable from the extension being broken.
//
// The tempting fix — ask chrome.idle what the screen is doing now, and skip
// the lock if it says 'active' — is wrong, and dangerously so. A late event
// after a walk-away looks identical: screen locked hours ago, machine slept,
// event arrives on resume once the user has unlocked Windows, so 'now' is
// 'active' there too. Skipping on that answer would leave the profile open in
// exactly the case this whole feature exists for.
//
// What separates the two is not the screen, it is whether somebody has proved
// they hold the password since. So the query only ever runs in the window just
// after a successful unlock, and only there can a lock be skipped. Reaching
// that window requires typing the correct password, which is already the way
// in, so nothing an attacker can do gets easier. Every other path locks
// immediately, exactly as before.
const RELOCK_GRACE_MS = 10000;
chrome.idle.onStateChanged.addListener(function (state) {
  if (state !== 'locked') return;
  (async function () {
    const c = await getCfg();
    if (!c || !c.hash) return;
    const s = await chrome.storage.session.get({ plk_unlockedAt: 0 });
    if (s.plk_unlockedAt && Date.now() - s.plk_unlockedAt < RELOCK_GRACE_MS) {
      // Still ask, rather than assuming. Hitting Win+L seconds after unlocking
      // is a real thing people do, and there the screen really is locked.
      if (await currentIdleState() !== 'locked') {
        await noteLockEvent('screen-lock-stale', false);
        return;
      }
    }
    await lockNow('screen-lock');
  })();
});

chrome.commands.onCommand.addListener(function (cmd) {
  if (cmd === 'lock-now') lockNow('shortcut');
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
