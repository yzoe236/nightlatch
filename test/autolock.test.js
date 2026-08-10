/* Per-device auto-lock timer tests.
 * Run: node test/autolock.test.js
 *
 * These pull the real functions out of background.js instead of copying them,
 * so the test cannot quietly drift away from the shipped code. background.js
 * starts with importScripts() and cannot be require()d, hence the text slice.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function sliceBetween(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  if (a < 0 || b <= a) throw new Error('background.js 里找不到 ' + from + ' … ' + to + '（结构被改过？）');
  return src.slice(a, b);
}

const defaultLine = (src.match(/const DEFAULT_AUTOLOCK_MIN = \d+;/) || [])[0];
if (!defaultLine) throw new Error('background.js 里找不到 DEFAULT_AUTOLOCK_MIN');
const block = sliceBetween('async function getLocalPrefs', 'async function isLocked');

// Minimal chrome.storage.local stand-in.
let store = {};
const chromeStub = {
  storage: {
    local: {
      get: async function (defaults) {
        const out = {};
        Object.keys(defaults).forEach(function (k) {
          out[k] = Object.prototype.hasOwnProperty.call(store, k) ? store[k] : defaults[k];
        });
        return out;
      },
      set: async function (obj) { Object.assign(store, obj); }
    }
  }
};

const api = new Function('chrome',
  defaultLine + '\n' + block +
  '\nreturn { getLocalPrefs, setLocalPrefs, effectiveAutolockMin, DEFAULT_AUTOLOCK_MIN };'
)(chromeStub);

const eff = api.effectiveAutolockMin;

(async function () {
  let pass = 0, fail = 0;
  function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
  }

  console.log('时长优先级:');
  ok('没有设备覆盖 → 用同步的默认值',
    eff({ autolockMin: 30 }, { idleAutolock: true }) === 30);

  // 这条就是 Leo 报的 bug：以前设备值被忽略，所有机器跟着同步值走
  ok('⭐ 设备覆盖压过同步值（本次修的 bug）',
    eff({ autolockMin: 30 }, { idleAutolock: true, autolockMin: 5 }) === 5,
    eff({ autolockMin: 30 }, { idleAutolock: true, autolockMin: 5 }));

  ok('实验室 5 分钟不受办公室 480 分钟影响',
    eff({ autolockMin: 480 }, { idleAutolock: true, autolockMin: 5 }) === 5);

  ok('两边都没设 → 内置默认值',
    eff(null, {}) === api.DEFAULT_AUTOLOCK_MIN);

  ok('只有设备值、同步值缺失 → 用设备值',
    eff(null, { autolockMin: 12 }) === 12);

  console.log('关掉空闲自动锁:');
  ok('idleAutolock=false → 0，压过设备值',
    eff({ autolockMin: 30 }, { idleAutolock: false, autolockMin: 5 }) === 0);
  ok('idleAutolock=false → 0，也压过同步值',
    eff({ autolockMin: 30 }, { idleAutolock: false }) === 0);

  console.log('脏数据不该炸:');
  ok('devicePrefs 为 undefined',
    eff({ autolockMin: 7 }, undefined) === 7);
  ok('设备值是字符串 → 忽略，退回同步值',
    eff({ autolockMin: 7 }, { autolockMin: '5' }) === 7);
  ok('设备值是 null → 忽略，退回同步值',
    eff({ autolockMin: 7 }, { autolockMin: null }) === 7);

  console.log('setLocalPrefs 写入:');
  store = {};
  await api.setLocalPrefs({ autolockMin: 5 });
  let p = await api.getLocalPrefs();
  ok('写入设备时长', p.autolockMin === 5, p);

  await api.setLocalPrefs({ idleAutolock: false });
  p = await api.getLocalPrefs();
  ok('改别的字段不会抹掉时长', p.autolockMin === 5 && p.idleAutolock === false, p);

  await api.setLocalPrefs({ autolockMin: null });
  p = await api.getLocalPrefs();
  ok('⭐ null 是删除键，不是存 null',
    !Object.prototype.hasOwnProperty.call(p, 'autolockMin'), p);
  ok('删掉覆盖后回到跟随同步值',
    eff({ autolockMin: 30 }, p) === 0 /* idleAutolock 仍是 false */, p);

  await api.setLocalPrefs({ idleAutolock: true });
  p = await api.getLocalPrefs();
  ok('恢复后确实跟随同步值', eff({ autolockMin: 30 }, p) === 30, p);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
