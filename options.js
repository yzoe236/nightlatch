/* ProfileLock options — password, auto-lock, themes, protected sites.
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

  function paintTimerRow() {
    const idleOn = $('idleAutolock').checked;
    $('autolockRow').dataset.dim = idleOn ? '0' : '1';
    $('autolock').disabled = !idleOn;
    $('autolockHint').textContent = idleOn
      ? 'Counts activity in THIS Chrome profile only — other people using the computer never reset your timer. A tab playing audio counts as in use.'
      : 'Idle auto-lock is off on this computer. The profile still locks on OS screen lock, on browser restart, and with Ctrl+Shift+L.';
  }

  function load() {
    chrome.runtime.sendMessage({ type: 'PLK_GET' }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      $('curLabel').hidden = !resp.hasPassword;
      $('idleAutolock').checked = resp.idleAutolock !== false;
      $('autolock').value = String(resp.storedAutolockMin || 5);
      $('strict').checked = !!resp.strict;
      $('theme').value = resp.theme || 'dark';
      $('sites').value = (resp.sites || []).join('\n');
      paintTimerRow();
    });
  }

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

  function saveTimerStrict() {
    let min = parseInt($('autolock').value, 10);
    if (isNaN(min) || min < 1) min = 1;
    if (min > 480) min = 480;
    $('autolock').value = String(min);
    chrome.runtime.sendMessage({ type: 'PLK_SET_CFG', autolockMin: min, strict: $('strict').checked }, function (resp) {
      cfgResult($('cfgStatus'), resp);
    });
  }
  $('autolock').onchange = saveTimerStrict;
  $('strict').onchange = saveTimerStrict;

  // Per-device (storage.local) — deliberately never synced.
  $('idleAutolock').onchange = function () {
    chrome.runtime.sendMessage({ type: 'PLK_SET_DEVICE', idleAutolock: $('idleAutolock').checked }, function (resp) {
      cfgResult($('cfgStatus'), resp);
      if (resp && !resp.ok) $('idleAutolock').checked = !$('idleAutolock').checked; // revert on refusal
      paintTimerRow();
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
