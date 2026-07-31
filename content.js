/* ProfileLock content script — covers the page while locked.
 * Runs at document_start, fail-closed: a dark veil goes up synchronously
 * BEFORE first paint, then the service worker is asked whether this device
 * is actually locked. Unlock UI lives inside a closed shadow root so page
 * CSS/JS can't restyle it; removal is countered by a MutationObserver.
 *
 * Two lock layers:
 *   global — the whole profile is locked (per device, per browser run)
 *   site   — this hostname is on the protected list and needs the
 *            password once per browser run, even while globally unlocked
 *
 * Honest threat model: stops shoulder-surfers and casual snooping on a
 * shared machine. It cannot stop someone who disables the extension at
 * chrome://extensions — nothing in this product category can. */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__plkReady) return;
  window.__plkReady = true;

  var locked = false;      // confirmed global lock
  var siteLocked = false;  // confirmed site lock (only when globally unlocked)
  var pending = true;      // true until first PLK_GET answer
  var theme = null;        // theme object from PLK_THEMES
  var host = null, input = null, errEl = null, cardEl = null, h1El = null, subEl = null;

  function T() {
    if (theme) return theme;
    var th = (typeof PLK_THEMES !== 'undefined' && PLK_THEMES.dark) ? PLK_THEMES.dark : {
      bg: '#0b0d12', fg: '#e8eaed', sub: 'rgba(232,234,237,.55)', inputBg: '#202124',
      inputBorder: '#3c4043', accent: '#8ab4f8', accentFg: '#202124', err: '#f28b82'
    };
    return th;
  }

  function css() {
    var t = T();
    return '.veil{position:fixed;inset:0;background:' + t.bg + ';display:flex;align-items:center;justify-content:center;' +
      'z-index:2147483647;font-family:system-ui,"Segoe UI",sans-serif}' +
      '.card{text-align:center;color:' + t.fg + ';width:300px;padding:24px}' +
      '.lock{font-size:42px}' +
      'h1{font-size:16px;font-weight:600;margin:12px 0 2px;color:' + t.fg + '}' +
      '.sub{font-size:12px;color:' + t.sub + ';margin-bottom:18px}' +
      'input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid ' + t.inputBorder + ';' +
      'background:' + t.inputBg + ';color:' + t.fg + ';font-size:14px;outline:none;text-align:center}' +
      'input:focus{border-color:' + t.accent + '}' +
      'button{width:100%;margin-top:10px;padding:9px 0;border:0;border-radius:8px;background:' + t.accent + ';' +
      'color:' + t.accentFg + ';font-size:14px;font-weight:600;cursor:pointer}' +
      '.err{color:' + t.err + ';font-size:12px;min-height:16px;margin-top:8px}' +
      '.foot{font-size:11px;opacity:.4;margin-top:22px;color:' + t.fg + '}';
  }

  function buildOverlay() {
    if (host) return;
    host = document.createElement('plk-shield');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;display:block;visibility:visible;';
    var sh = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = css();
    var veil = document.createElement('div');
    veil.className = 'veil';

    cardEl = document.createElement('div');
    cardEl.className = 'card';
    cardEl.style.display = 'none'; // veil-only until a lock is confirmed

    var lockIcon = document.createElement('div');
    lockIcon.className = 'lock';
    lockIcon.textContent = '🔒';
    h1El = document.createElement('h1');
    h1El.textContent = 'Profile Locked';
    subEl = document.createElement('div');
    subEl.className = 'sub';
    subEl.textContent = 'Enter password to unlock this device';

    var form = document.createElement('form');
    input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'Password';
    input.autocomplete = 'off';
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Unlock';
    form.appendChild(input);
    form.appendChild(btn);
    form.addEventListener('submit', onSubmit);

    errEl = document.createElement('div');
    errEl.className = 'err';
    var foot = document.createElement('div');
    foot.className = 'foot';
    foot.textContent = 'ProfileLock · Lock state is per-device and never syncs';

    cardEl.appendChild(lockIcon);
    cardEl.appendChild(h1El);
    cardEl.appendChild(subEl);
    cardEl.appendChild(form);
    cardEl.appendChild(errEl);
    cardEl.appendChild(foot);
    veil.appendChild(cardEl);
    sh.appendChild(style);
    sh.appendChild(veil);

    (document.documentElement || document).appendChild(host);
  }

  function showForm(mode) {
    if (!host) buildOverlay();
    if (mode === 'site') {
      h1El.textContent = 'Site Protected';
      subEl.textContent = location.hostname + ' requires your password';
    } else {
      h1El.textContent = 'Profile Locked';
      subEl.textContent = 'Enter password to unlock this device';
    }
    cardEl.style.display = 'block';
    if (input) input.value = '';
    setTimeout(function () { try { input.focus(); } catch (e) { /* noop */ } }, 30);
  }

  function removeOverlay() {
    if (!host) return;
    var h = host;
    host = null; input = null; errEl = null; cardEl = null; h1El = null; subEl = null;
    try { h.remove(); } catch (e) { /* noop */ }
  }

  function anyLock() { return locked || siteLocked || pending; }

  function setLocked(v) {
    pending = false;
    locked = v;
    if (v) { siteLocked = false; buildOverlay(); showForm('global'); }
    else { removeOverlay(); checkSite(); }
  }

  function setSiteLocked(v) {
    pending = false;
    siteLocked = v;
    if (v) { buildOverlay(); showForm('site'); }
    else removeOverlay();
  }

  // Per-site layer — only consulted once the global lock is off.
  function checkSite() {
    if (locked) return;
    chrome.runtime.sendMessage({ type: 'PLK_SITE_CHECK', host: location.hostname }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.protected && !resp.unlocked) setSiteLocked(true);
    });
  }

  // Post-unlock "while you were away" notice (top-right, auto-dismiss).
  function toast(text, ms) {
    try {
      var t = T();
      var th = document.createElement('plk-toast');
      th.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647;display:block;';
      var sh = th.attachShadow({ mode: 'closed' });
      var box = document.createElement('div');
      box.style.cssText = 'background:#2d1b1b;color:' + t.err + ';border:1px solid ' + t.err + ';border-radius:10px;' +
        'padding:12px 16px;font:13px/1.5 system-ui,"Segoe UI",sans-serif;max-width:300px;box-shadow:0 4px 18px rgba(0,0,0,.4)';
      box.textContent = text;
      sh.appendChild(box);
      (document.documentElement || document).appendChild(th);
      setTimeout(function () { try { th.remove(); } catch (e) { /* noop */ } }, ms || 8000);
    } catch (e) { /* noop */ }
  }

  function showError(resp) {
    if (!errEl) return;
    if (resp.waitMs) errEl.textContent = 'Too many attempts — wait ' + Math.ceil(resp.waitMs / 1000) + 's';
    else errEl.textContent = 'Wrong password' + (resp.tries ? ' (attempt ' + resp.tries + ')' : '');
  }

  function onSubmit(e) {
    e.preventDefault();
    var pw = input ? input.value : '';

    if (siteLocked && !locked) {
      chrome.runtime.sendMessage({ type: 'PLK_SITE_UNLOCK', host: location.hostname, password: pw }, function (resp) {
        if (chrome.runtime.lastError || !resp) return;
        if (resp.ok) { setSiteLocked(false); return; }
        showError(resp);
        if (input) { input.value = ''; input.focus(); }
      });
      return;
    }

    chrome.runtime.sendMessage({ type: 'PLK_UNLOCK', password: pw }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.ok) {
        setLocked(false);
        if (resp.report && resp.report.fails > 0) {
          var when = resp.report.lastFailAt ? new Date(resp.report.lastFailAt).toLocaleString() : '';
          toast('⚠️ ' + resp.report.fails + ' failed password attempt(s) while locked' + (when ? ' (last: ' + when + ')' : ''));
        }
        return;
      }
      showError(resp);
      if (input) { input.value = ''; input.focus(); }
    });
  }

  // While locked, swallow every interaction that isn't aimed at the overlay.
  function guard(e) {
    if (!anyLock()) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (host && path.indexOf(host) >= 0) return;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }
  ['keydown', 'keypress', 'keyup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu',
   'wheel', 'touchstart', 'touchmove', 'pointerdown', 'copy', 'cut', 'dragstart'].forEach(function (t) {
    window.addEventListener(t, guard, { capture: true, passive: false });
  });

  // Profile-scoped idle clock: page interaction heartbeats (throttled) let the
  // service worker know THIS profile is in use. Others using the computer via
  // their own profiles never touch this clock — that's the point.
  var lastPing = 0;
  function ping() {
    if (anyLock()) return;
    var now = Date.now();
    if (now - lastPing < 20000) return;
    lastPing = now;
    try { chrome.runtime.sendMessage({ type: 'PLK_ACTIVITY' }); } catch (e) { /* noop */ }
  }
  ['mousemove', 'keydown', 'mousedown', 'wheel', 'touchstart', 'scroll'].forEach(function (t) {
    window.addEventListener(t, ping, { capture: true, passive: true });
  });

  // Focus trap: anything trying to focus the page gets bounced to the input.
  window.addEventListener('focusin', function (e) {
    if (!anyLock()) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (host && path.indexOf(host) < 0) {
      try { input && input.focus(); } catch (err) { /* noop */ }
    }
  }, { capture: true });

  // Tamper resistance: page JS removing our host gets it rebuilt.
  var mo = new MutationObserver(function () {
    if (anyLock() && host && !document.documentElement.contains(host)) {
      host = null; input = null; errEl = null; cardEl = null; h1El = null; subEl = null;
      buildOverlay();
      if (locked) showForm('global');
      else if (siteLocked) showForm('site');
    }
  });

  function armObserver() {
    if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: false });
  }

  function applyState(resp) {
    theme = (typeof PLK_THEMES !== 'undefined' && PLK_THEMES[resp.theme]) ? PLK_THEMES[resp.theme] : null;
    if (resp.locked) {
      // rebuild so the confirmed theme paints the lock screen
      removeOverlay();
      setLocked(true);
    } else {
      setLocked(false);
    }
  }

  // ------------------------------------------------------------ bootstrap
  buildOverlay();   // fail closed before paint
  armObserver();

  chrome.runtime.sendMessage({ type: 'PLK_GET' }, function (resp) {
    if (chrome.runtime.lastError || !resp) { setLocked(false); return; } // extension broken → don't brick browsing
    applyState(resp);
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'PLK_STATE') setLocked(!!msg.locked);
  });

  // Safety net for missed broadcasts (service worker restarts, etc.)
  window.addEventListener('focus', function () {
    chrome.runtime.sendMessage({ type: 'PLK_GET' }, function (resp) {
      if (!chrome.runtime.lastError && resp) {
        theme = (typeof PLK_THEMES !== 'undefined' && PLK_THEMES[resp.theme]) ? PLK_THEMES[resp.theme] : theme;
        if (!!resp.locked !== locked) setLocked(!!resp.locked);
      }
    });
  });
})();
