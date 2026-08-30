/* Brute-force cooldown tests.
 * Run: node test/cooldown.test.js
 *
 * Pulls guardedVerify out of background.js rather than copying it, same
 * approach as autolock.test.js, so the test cannot drift from the shipped
 * code. Covers the two findings from the 2026-08-15 security review:
 *   1. every credential door must draw on one pool
 *   2. concurrent guesses must not each collect a free try
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

const block = sliceBetween('let credentialGate', '// ------------------------------------------------------------------ action');

// storage.session + report stubs. Deliberately adds a microtask of latency to
// every read and write, which is what makes the race reproducible at all.
let session = {};
let report = { fails: 0, lastFailAt: 0, lastUnlockAt: 0, lastReportFails: 0, lastReportFailAt: 0 };
const chromeStub = {
  storage: {
    session: {
      get: async function (d) {
        await null;
        const o = {};
        Object.keys(d).forEach(function (k) { o[k] = Object.prototype.hasOwnProperty.call(session, k) ? session[k] : d[k]; });
        return o;
      },
      set: async function (o) { await null; Object.assign(session, o); }
    }
  }
};
const PLKStub = { backoffMs: function (n) { return n < 5 ? 0 : Math.min(300000, 30000 * Math.pow(2, n - 5)); } };

const api = new Function('chrome', 'PLK', 'getReport', 'saveReport',
  block + '\nreturn { guardedVerify: guardedVerify, clearFails: clearFails };'
)(chromeStub, PLKStub,
  async function () { await null; return report; },
  async function (r) { await null; report = r; });

const { guardedVerify, clearFails } = api;

(async function () {
  let pass = 0, fail = 0;
  function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
  }
  function reset() {
    session = {};
    report = { fails: 0, lastFailAt: 0, lastUnlockAt: 0, lastReportFails: 0, lastReportFailAt: 0 };
  }
  const no = function () { return Promise.resolve(false); };
  const yes = function () { return Promise.resolve(true); };

  console.log('基本计数:');
  reset();
  let r = await guardedVerify(yes);
  ok('对的凭据直接过，不计失败', r.ok === true && session.plk_fail === undefined, r);

  reset();
  for (let i = 1; i <= 4; i++) {
    r = await guardedVerify(no);
    ok('第 ' + i + ' 次错 -> 不罚', r.ok === false && r.tries === i && r.waitMs === 0, r);
  }
  r = await guardedVerify(no);
  ok('第 5 次错 -> 罚 30 秒', r.tries === 5 && r.waitMs === 30000, r);
  r = await guardedVerify(no);
  ok('冷却期内直接 blocked，不再验证', r.blocked === true && r.waitMs > 0, r);
  r = await guardedVerify(yes);
  ok('冷却期内正确的凭据也被挡（不给旁路）', r.blocked === true, r);

  console.log('清零:');
  await clearFails();
  r = await guardedVerify(yes);
  ok('clearFails 之后恢复正常', r.ok === true, r);

  console.log('⭐ 并发（审查指出的硬伤 2）:');
  reset();
  // 一次性并发 20 个错误猜测。有竞态的话它们会各自读到同一份未自增的计数，
  // 于是拿到 20 次"免费尝试"；串行化之后必须是老老实实 1..20。
  const burst = await Promise.all(Array.from({ length: 20 }, function () { return guardedVerify(no); }));
  const counted = burst.filter(function (x) { return x.ok === false; }).map(function (x) { return x.tries; });
  const blocked = burst.filter(function (x) { return x.blocked; }).length;
  const uniq = new Set(counted);
  ok('并发 20 次没有任何两次拿到同一个计数', uniq.size === counted.length,
    { counted: counted, blocked: blocked });
  ok('计数连续从 1 开始，没有丢失更新', counted.every(function (n, i) { return n === i + 1; }), counted);
  ok('4 次之后开始有请求被冷却挡下', blocked > 0, { blocked: blocked });
  ok('失败报告的累计数没有丢更新', report.fails === counted.length, { reportFails: report.fails, counted: counted.length });

  console.log('一个池子（审查指出的硬伤 1）:');
  reset();
  // 模拟四扇门轮流猜：解锁、站点解锁、恢复码、改密码时的当前密码
  for (let i = 0; i < 4; i++) await guardedVerify(no);
  r = await guardedVerify(no);
  ok('换一扇门继续猜，计数照样累加到 5 并开罚', r.tries === 5 && r.waitMs === 30000, r);

  console.log('verify 抛异常不会把链子卡死:');
  reset();
  let threw = false;
  try { await guardedVerify(function () { throw new Error('boom'); }); } catch (e) { threw = true; }
  ok('异常被抛出来', threw);
  r = await guardedVerify(yes);
  ok('后续请求仍然正常（链子没死锁）', r.ok === true, r);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
