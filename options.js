/* Nightlatch options — password, auto-lock, themes, protected sites.
 * Every feature is free; the only gating here is "does this control apply
 * on this machine right now". */
(function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  // theme dropdown from the shared registry
  Object.keys(PLK_THEMES).forEach(function (key) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PLK_THEMES[key].name;
    $('theme').appendChild(opt);
  });

  // The synced default, and this device's own timer (null = follow the default).
  let storedMin = 5;
  let deviceMin = null;

  function paintTimerRow() {
    const idleOn = $('idleAutolock').checked;
    $('autolockRow').dataset.dim = idleOn ? '0' : '1';
    $('deviceTimerRow').dataset.dim = idleOn ? '0' : '1';
    $('autolock').disabled = !idleOn;
    $('deviceTimer').disabled = !idleOn;
    $('autolockHint').textContent = idleOn
      ? 'Counts activity in THIS Chrome profile only — other people using the computer never reset your timer. A tab playing audio counts as in use.'
      : 'Idle auto-lock is off on this computer. The profile still locks on OS screen lock, on browser restart, and with Ctrl+Shift+L.';
    paintTimerScope();
  }

  // Says plainly which machines the number above is about to change.
  function paintTimerScope() {
    $('deviceTimerHint').textContent = $('deviceTimer').checked
      ? 'This computer locks after ' + $('autolock').value + ' minutes. Every other computer keeps the account default of ' + storedMin + ' minutes.'
      : 'Following the account default of ' + storedMin + ' minutes. Changing the number changes it on every computer that has no number of its own.';
  }

  function load() {
    chrome.runtime.sendMessage({ type: 'PLK_GET' }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      $('curLabel').hidden = !resp.hasPassword;
      $('rcState').textContent = !resp.hasPassword ? ''
        : (resp.hasRecovery
            ? 'A recovery code exists for this profile. Saving a new password replaces it with a new one.'
            : 'No recovery code yet. Save your password again to generate one, and you will be able to get back in if you forget it.');
      $('idleAutolock').checked = resp.idleAutolock !== false;
      storedMin = resp.storedAutolockMin || 5;
      deviceMin = typeof resp.deviceAutolockMin === 'number' ? resp.deviceAutolockMin : null;
      $('deviceTimer').checked = deviceMin !== null;
      $('autolock').value = String(deviceMin !== null ? deviceMin : storedMin);
      $('strict').checked = !!resp.strict;
      $('theme').value = resp.theme || 'dark';
      $('sites').value = (resp.sites || []).join('\n');
      paintLockLog(resp.lockLog || []);
      paintTimerRow();
    });
  }

  // Plain English for each reason the service worker records. Entries where
  // did=false are locks that were considered and dropped, so they need their
  // own wording — "no activity" would be a lie about a lock that never
  // happened.
  const LOCK_REASONS = {
    'screen-lock': 'The computer screen locked',
    'screen-lock-stale': 'Ignored an out-of-date screen-lock signal (you were using the computer)',
    'idle-timeout': 'No activity in this profile for the auto-lock time',
    'shortcut': 'You pressed Ctrl+Shift+L',
    'popup': 'You clicked Lock now',
    'manual': 'Locked on request'
  };
  const LOCK_SKIPPED = {
    'idle-timeout': 'Auto-lock cancelled: you came back before it took effect'
  };

  function paintLockLog(entries) {
    const ul = $('lockLog');
    ul.textContent = '';
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'skip';
      li.textContent = 'Nothing recorded yet on this computer.';
      ul.appendChild(li);
      return;
    }
    entries.forEach(function (e) {
      const li = document.createElement('li');
      if (!e.did) li.className = 'skip';
      const t = document.createElement('time');
      t.textContent = new Date(e.at).toLocaleString();
      const what = document.createElement('span');
      what.textContent = (!e.did && LOCK_SKIPPED[e.why]) || LOCK_REASONS[e.why] || e.why;
      li.appendChild(t);
      li.appendChild(what);
      ul.appendChild(li);
    });
  }

  // --------------------------------------------------- recovery code
  // The plaintext arrives once in the save response and is never stored, so
  // this panel is the only chance the user gets to write it down.
  function showRecoveryCode(code) {
    $('rcValue').textContent = code;
    $('rcCard').hidden = false;
    $('rcStatus').textContent = '';
    $('rcCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('rcCopy').onclick = function () {
    navigator.clipboard.writeText($('rcValue').textContent).then(function () {
      $('rcStatus').className = 'status ok';
      $('rcStatus').textContent = 'Copied. Paste it somewhere off this computer.';
    }, function () {
      $('rcStatus').className = 'status bad';
      $('rcStatus').textContent = 'Copy failed. Select the code and copy it by hand.';
    });
  };

  $('rcDone').onclick = function () {
    $('rcValue').textContent = '';
    $('rcCard').hidden = true;
  };

  // --------------------------------------------------------------- password
  $('savePw').onclick = function () {
    const pwStatus = $('pwStatus');
    pwStatus.className = 'status';
    if ($('next').value.length < 4) { pwStatus.className = 'status bad'; pwStatus.textContent = 'New password must be at least 4 characters'; return; }
    if ($('next').value !== $('confirm').value) { pwStatus.className = 'status bad'; pwStatus.textContent = 'Passwords do not match'; return; }
    pwStatus.textContent = 'Saving…';
    chrome.runtime.sendMessage({ type: 'PLK_SET_PASSWORD', current: $('cur').value, next: $('next').value }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.ok) {
        pwStatus.className = 'status ok';
        pwStatus.textContent = '✅ Saved. Lock with Ctrl+Shift+L or the toolbar icon.';
        $('cur').value = ''; $('next').value = ''; $('confirm').value = '';
        if (resp.recoveryCode) showRecoveryCode(resp.recoveryCode);
        load();
      } else {
        pwStatus.className = 'status bad';
        pwStatus.textContent = resp.msg || 'Save failed';
      }
    });
  };

  // ------------------------------------------------------------------- cfg
  function cfgResult(el, resp) {
    el.className = 'status ' + (resp && resp.ok ? 'ok' : 'bad');
    el.textContent = resp && resp.ok ? '✅ Saved'
      : (resp && resp.msg === 'locked' ? 'Unlock this device first' : (resp && resp.msg || 'Save failed'));
    setTimeout(function () { el.textContent = ''; }, 2500);
  }

  function readMin() {
    let min = parseInt($('autolock').value, 10);
    if (isNaN(min) || min < 1) min = 1;
    if (min > 480) min = 480;
    $('autolock').value = String(min);
    return min;
  }

  // One number field, two destinations. The checkbox below it decides which.
  $('autolock').onchange = function () {
    const min = readMin();
    const toDevice = $('deviceTimer').checked;
    const msg = toDevice
      ? { type: 'PLK_SET_DEVICE', autolockMin: min }
      : { type: 'PLK_SET_CFG', autolockMin: min };
    chrome.runtime.sendMessage(msg, function (resp) {
      if (resp && resp.ok) { if (toDevice) deviceMin = min; else storedMin = min; }
      cfgResult($('cfgStatus'), resp);
      paintTimerScope();
    });
  };

  $('strict').onchange = function () {
    chrome.runtime.sendMessage({ type: 'PLK_SET_CFG', strict: $('strict').checked }, function (resp) {
      cfgResult($('cfgStatus'), resp);
    });
  };

  // Per-device (storage.local) — deliberately never synced.
  $('idleAutolock').onchange = function () {
    chrome.runtime.sendMessage({ type: 'PLK_SET_DEVICE', idleAutolock: $('idleAutolock').checked }, function (resp) {
      cfgResult($('cfgStatus'), resp);
      if (resp && !resp.ok) $('idleAutolock').checked = !$('idleAutolock').checked; // revert on refusal
      paintTimerRow();
    });
  };

  // Claiming a per-device timer pins whatever is showing; releasing it snaps
  // the field back to the synced default so what you see is what applies.
  $('deviceTimer').onchange = function () {
    const claim = $('deviceTimer').checked;
    const min = claim ? readMin() : null;
    chrome.runtime.sendMessage({ type: 'PLK_SET_DEVICE', autolockMin: min }, function (resp) {
      if (resp && resp.ok) {
        deviceMin = min;
        if (!claim) $('autolock').value = String(storedMin);
      } else {
        $('deviceTimer').checked = !claim; // revert on refusal
      }
      cfgResult($('cfgStatus'), resp);
      paintTimerScope();
    });
  };

  $('theme').onchange = function () {
    chrome.runtime.sendMessage({ type: 'PLK_SET_CFG', theme: $('theme').value }, function (resp) {
      cfgResult($('cfgStatus'), resp);
    });
  };

  $('saveSites').onclick = function () {
    const sites = $('sites').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    chrome.runtime.sendMessage({ type: 'PLK_SET_CFG', sites: sites }, function (resp) {
      cfgResult($('sitesStatus'), resp);
      if (resp && resp.ok) load();
    });
  };

  load();
})();
