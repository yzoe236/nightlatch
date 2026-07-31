/* ProfileLock popup — status + lock-now + quick unlock. */
(function () {
  'use strict';

  const icon = document.getElementById('icon');
  const stateText = document.getElementById('stateText');
  const note = document.getElementById('note');
  const setupBox = document.getElementById('setupBox');
  const unlockedBox = document.getElementById('unlockedBox');
  const lockedBox = document.getElementById('lockedBox');

  document.getElementById('openOptions').onclick = function () { chrome.runtime.openOptionsPage(); };
  document.getElementById('setupBtn').onclick = function () { chrome.runtime.openOptionsPage(); };

  function refresh() {
    chrome.runtime.sendMessage({ type: 'PLK_GET' }, function (resp) {
      if (chrome.runtime.lastError || !resp) return;
      setupBox.hidden = true; unlockedBox.hidden = true; lockedBox.hidden = true;
      if (!resp.hasPassword) {
        icon.textContent = '⚠️';
        stateText.textContent = 'No password set yet';
        note.textContent = 'Once set, this profile locks on every browser restart, after idle time, and on demand.';
        setupBox.hidden = false;
      } else if (resp.locked) {
        icon.textContent = '🔒';
        stateText.textContent = 'Locked on this device';
        note.textContent = '';
        lockedBox.hidden = false;
      } else {
        icon.textContent = '🔓';
        stateText.textContent = 'Unlocked on this device';
        var lines = [resp.autolockMin > 0
          ? ('Auto-locks after ' + resp.autolockMin + ' min of no activity in this profile, and on OS screen lock.')
          : 'Idle auto-lock is OFF on this computer. Still locks on OS screen lock, restart, and Ctrl+Shift+L.'];
        if (resp.report && resp.report.lastUnlockAt) {
          lines.push('Last unlock: ' + new Date(resp.report.lastUnlockAt).toLocaleString() +
            (resp.report.lastReportFails > 0 ? (' — ' + resp.report.lastReportFails + ' failed attempt(s) while locked ⚠️') : ' — no failed attempts'));
        }
        note.textContent = lines.join(' ');
        document.getElementById('idleToggle').checked = resp.idleAutolock !== false;
        unlockedBox.hidden = false;
      }
    });
  }

  document.getElementById('lockBtn').onclick = function () {
    chrome.runtime.sendMessage({ type: 'PLK_LOCK' }, function () { window.close(); });
  };

  // Per-device toggle (never syncs) — handy on a machine only you use.
  document.getElementById('idleToggle').onchange = function () {
    const on = document.getElementById('idleToggle').checked;
    chrome.runtime.sendMessage({ type: 'PLK_SET_DEVICE', idleAutolock: on }, function (resp) {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        document.getElementById('idleToggle').checked = !on; // revert on refusal
        return;
      }
      refresh();
    });
  };

  document.getElementById('unlockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    const pw = document.getElementById('pw').value;
    chrome.runtime.sendMessage({ type: 'PLK_UNLOCK', password: pw }, function (resp) {
      const err = document.getElementById('err');
      if (chrome.runtime.lastError || !resp) return;
      if (resp.ok) {
        if (resp.report && resp.report.fails > 0) {
          err.style.color = '#b06000';
          err.textContent = 'Unlocked. ⚠️ ' + resp.report.fails + ' failed attempt(s) while locked';
          setTimeout(function () { window.close(); }, 2500);
        } else {
          window.close();
        }
        return;
      }
      if (resp.waitMs) err.textContent = 'Too many attempts — wait ' + Math.ceil(resp.waitMs / 1000) + 's';
      else err.textContent = 'Wrong password (attempt ' + (resp.tries || '?') + ')';
      document.getElementById('pw').value = '';
    });
  });

  refresh();
})();
