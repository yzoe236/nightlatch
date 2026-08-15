/* locked.html — landing page for guarded tabs (chrome://settings etc. get
 * redirected here while locked). Unlocking returns you to where you were. */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const from = params.get('from') || '';
  const fromOk = /^(https?|file):/i.test(from); // never bounce back into chrome:// loops

  // Set once a recovery succeeds: the new code is on screen and must not be
  // yanked away by an auto-leave before the user has written it down.
  let holdOpen = false;

  function leave() {
    if (holdOpen) return;
    if (fromOk) { location.replace(from); return; }
    document.getElementById('err').style.color = '#81c995';
    document.getElementById('err').textContent = 'Unlocked. You can close this tab';
    setTimeout(function () { window.close(); }, 800);
  }

  // Theme + already-unlocked check (stale tab leaves immediately).
  chrome.runtime.sendMessage({ type: 'PLK_GET' }, function (resp) {
    if (chrome.runtime.lastError || !resp) return;
    var t = (typeof PLK_THEMES !== 'undefined') && PLK_THEMES[resp.theme];
    if (t) {
      var r = document.documentElement.style;
      r.setProperty('--bg', t.bg); r.setProperty('--fg', t.fg); r.setProperty('--sub', t.sub);
      r.setProperty('--input-bg', t.inputBg); r.setProperty('--input-border', t.inputBorder);
      r.setProperty('--accent', t.accent); r.setProperty('--accent-fg', t.accentFg); r.setProperty('--err', t.err);
    }
    // No code was ever issued (profile set up before this feature shipped),
    // so offering the door would only be confusing.
    if (!resp.hasRecovery) document.getElementById('toggleRecover').hidden = true;
    if (!resp.locked) leave();
  });

  const $ = function (id) { return document.getElementById(id); };

  $('toggleRecover').addEventListener('click', function () {
    const showing = !$('rf').hidden;
    $('rf').hidden = showing;
    $('f').hidden = !showing;
    $('err').textContent = '';
    this.textContent = showing ? 'Forgot your password?' : 'Back to the password';
    if (!showing) $('rcode').focus(); else $('pw').focus();
  });

  $('rf').addEventListener('submit', function (e) {
    e.preventDefault();
    const err = $('err');
    if ($('rnew').value.length < 4) { err.textContent = 'New password must be at least 4 characters'; return; }
    if ($('rnew').value !== $('rconf').value) { err.textContent = 'Passwords do not match'; return; }
    chrome.runtime.sendMessage({
      type: 'PLK_RECOVER', code: $('rcode').value, next: $('rnew').value
    }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      if (!resp.ok) {
        err.textContent = resp.waitMs
          ? 'Too many attempts. Wait ' + Math.ceil(resp.waitMs / 1000) + 's'
          : (resp.msg || 'Recovery failed');
        return;
      }
      holdOpen = true; // keep the new code on screen
      err.textContent = '';
      $('rf').hidden = true;
      $('toggleRecover').hidden = true;
      $('rcnew').textContent = resp.recoveryCode || '';
      $('rdone').hidden = false;
    });
  });

  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    const pw = document.getElementById('pw').value;
    chrome.runtime.sendMessage({ type: 'PLK_UNLOCK', password: pw }, function (resp) {
      const err = document.getElementById('err');
      if (chrome.runtime.lastError || !resp) return;
      if (resp.ok) {
        if (resp.report && resp.report.fails > 0) {
          err.style.color = '#fdd663';
          err.textContent = '⚠️ ' + resp.report.fails + ' failed password attempt(s) while locked';
          setTimeout(leave, 2000);
        } else leave();
        return;
      }
      if (resp.waitMs) err.textContent = 'Too many attempts. Wait ' + Math.ceil(resp.waitMs / 1000) + 's';
      else err.textContent = 'Wrong password' + (resp.tries ? ' (attempt ' + resp.tries + ')' : '');
      document.getElementById('pw').value = '';
      document.getElementById('pw').focus();
    });
  });

  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'PLK_STATE' && !msg.locked) leave();
  });
})();
