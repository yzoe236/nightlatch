/* 「输完密码 Chrome 整个退出,重开又要密码」的成因。
 * Run: node test/lasttab.test.js
 *
 * 链条(全部有下面的断言撑着):
 *   1. Chrome 冷启动,只有一个新标签页,profile 必然是锁着的(session 存储空)
 *   2. 新标签页的 URL 命中 GUARD_RE,strict 模式下被赶去 locked.html
 *   3. locked.js 的 fromOk 只认 http/https/file,chrome:// 一律不认
 *   4. 于是解锁成功之后走的是 window.close()
 *   5. 关掉唯一的标签页 = 关窗口 = 关掉最后一个窗口 = Chrome 退出
 *   6. 重开 → session 存储又是空的 → 又锁着 → 又要密码。循环闭合。
 *
 * 正则是从 background.js 和 locked.js 正文里抠出来的,不是抄的副本。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./sw-harness.js');

const ROOT = path.join(__dirname, '..');
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const lockedSrc = fs.readFileSync(path.join(ROOT, 'locked.js'), 'utf8');

function cut(src, re, what) {
  const m = src.match(re);
  if (!m) throw new Error('抠不出 ' + what + '(结构被改过?)');
  return eval(m[1]);
}
const GUARD_RE = cut(bgSrc, /const GUARD_RE = (\/.*\/i);/, 'GUARD_RE');
const FROM_OK_RE = cut(lockedSrc, /const fromOk = (\/.*\/i)\.test/, 'locked.js 的 fromOk');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
}

async function seedLocked(h) {
  const rec = await h.PLK.hashPassword('correct horse');
  h.sync.plk_cfg = { hash: rec.hash, salt: rec.salt, iter: rec.iter, autolockMin: 5, strict: true };
  // session 存储不填 → 按定义就是锁着,这正是每次浏览器重启后的状态
}

(async function () {

  console.log('第 1-3 步(纯判定,不用跑服务工作线程):');
  // Chrome 自己报的新标签页 URL。本次会话开头 tabs_context_mcp 拿到的就是这个值。
  ok('新标签页 chrome://newtab/ 命中 GUARD_RE', GUARD_RE.test('chrome://newtab/'));
  ok('新版新标签页 chrome://new-tab-page/ 也命中', GUARD_RE.test('chrome://new-tab-page/'));
  ok('locked.js 的 fromOk 不认 chrome://newtab/', FROM_OK_RE.test('chrome://newtab/') === false);
  ok('fromOk 认 https(普通网页解锁后能原地跳回去,这条没问题)',
    FROM_OK_RE.test('https://example.com/') === true);

  console.log('');
  console.log('第 2 步实跑:冷启动 + 唯一的新标签页');
  {
    const h = createHarness({ tabs: [{ id: 1, url: 'chrome://newtab/', audible: false }] });
    await seedLocked(h);
    ok('浏览器重启后 profile 是锁着的', await h.api.isLocked() === true);

    h.listeners.startup.forEach(function (f) { f(); });   // chrome.runtime.onStartup
    await h.settle();

    const redirect = h.log.filter(function (l) { return l.indexOf('tabs.update:1:') === 0; }).pop();
    ok('唯一的标签页被赶去了锁屏落地页',
      !!redirect && redirect.indexOf('locked.html') >= 0, redirect);

    const from = redirect
      ? decodeURIComponent((redirect.split('?from=')[1] || '')) : '';
    ok('落地页带回来的 from 就是那个新标签页', from === 'chrome://newtab/', from);

    console.log('');
    console.log('第 4-6 步:解锁之后会发生什么');
    ok('⭐ fromOk 判否 → 老代码在这里调 window.close()', FROM_OK_RE.test(from) === false);

    // 关掉它就没有标签页了,也就没有窗口了
    ok('⭐ 这是当前唯一的一个标签页', (await h.chrome.tabs.query({})).length === 1);

    // 修好之后:落地页改成问后台要出路,后台不许关掉最后一个标签页
    const resp = await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    ok('密码是对的', resp && resp.ok === true, resp);

    const before = h.log.length;
    const leave = await h.send({ type: 'PLK_LEAVE', from: from }, true, 1);
    await h.settle();
    const after = h.log.slice(before);

    ok('⭐ 后台没有关掉这个标签页',
      after.every(function (l) { return l.indexOf('tabs.remove') < 0; }), after);
    ok('⭐ 而是把它导航回原来那个新标签页',
      after.some(function (l) { return l === 'tabs.update:1:chrome://newtab/'; }), after);
    ok('后台告诉落地页「我处理好了」', leave && leave.ok === true, leave);
    ok('标签页还在', (await h.chrome.tabs.query({})).length === 1);
  }

  console.log('');
  console.log('还有标签页的时候,关掉落地页是没问题的:');
  {
    const h = createHarness({ tabs: [
      { id: 1, url: 'https://example.com/', audible: false },
      { id: 2, url: 'chrome://newtab/', audible: false }
    ] });
    await seedLocked(h);
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setRefuseChromeNav(true);          // 假装 Chrome 不让扩展导航到 chrome://
    const before = h.log.length;
    await h.send({ type: 'PLK_LEAVE', from: 'chrome://newtab/' }, true, 2);
    await h.settle();
    const after = h.log.slice(before);
    ok('导航被拒 + 还有别的标签页 → 关掉落地页',
      after.some(function (l) { return l === 'tabs.remove:2'; }), after);
  }

  console.log('');
  console.log('导航被拒 + 它是最后一个:先开一个新的,再关掉自己');
  {
    // Chrome 不一定让扩展把标签页导航到 chrome:// 页面(官方文档没写死),
    // 所以这条兜底必须真的能用:tabs.create 不带 url 是文档保证开新标签页的。
    const h = createHarness({ tabs: [{ id: 1, url: 'chrome://newtab/', audible: false }] });
    await seedLocked(h);
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setRefuseChromeNav(true);
    const before = h.log.length;
    const leave = await h.send({ type: 'PLK_LEAVE', from: 'chrome://newtab/' }, true, 1);
    await h.settle();
    const after = h.log.slice(before);

    const iCreate = after.findIndex(function (l) { return l.indexOf('tabs.create:') === 0; });
    const iRemove = after.findIndex(function (l) { return l === 'tabs.remove:1'; });
    ok('开了一个新标签页', iCreate >= 0, after);
    ok('⭐ 先开新的再关旧的,中间一刻都不能是零个标签页',
      iCreate >= 0 && iRemove >= 0 && iCreate < iRemove, after);
    ok('⭐ 收场时浏览器里还有标签页(所以 Chrome 不会退出)',
      (await h.chrome.tabs.query({})).length === 1);
    ok('落地页那个标签确实关掉了',
      (await h.chrome.tabs.query({})).every(function (t) { return t.id !== 1; }));
    ok('告诉落地页处理好了', leave && leave.ok === true, leave);
  }

  console.log('');
  console.log('PLK_LEAVE 本身的把关:');
  {
    const h = createHarness({ tabs: [{ id: 1, url: 'https://evil.example/', audible: false }] });
    await seedLocked(h);
    const denied = await h.send({ type: 'PLK_LEAVE', from: 'chrome://newtab/' }, false, 1);
    ok('网页脚本发的 PLK_LEAVE 一律拒绝', denied && denied.ok === false, denied);
  }
  {
    const h = createHarness({ tabs: [{ id: 1, url: 'chrome://newtab/', audible: false }] });
    await seedLocked(h);
    const stillLocked = await h.send({ type: 'PLK_LEAVE', from: 'chrome://newtab/' }, true, 1);
    ok('还锁着的时候不给放行', stillLocked && stillLocked.ok === false, stillLocked);
  }
  {
    const h = createHarness({ tabs: [{ id: 1, url: 'chrome://newtab/', audible: false }] });
    await seedLocked(h);
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    const before = h.log.length;
    await h.send({ type: 'PLK_LEAVE', from: 'javascript:alert(1)' }, true, 1);
    await h.settle();
    const after = h.log.slice(before);
    ok('⭐ from 是伪造的 javascript: → 绝不能照着导航',
      after.every(function (l) { return l.indexOf('javascript:') < 0; }), after);
    ok('退回到新标签页',
      after.some(function (l) { return /^tabs\.update:1:chrome:\/\/new/.test(l); }), after);
  }

  console.log('');
  console.log('同一个标签页问两次:');
  {
    // leave() 有三个调用点,陈旧标签页上前两个可能都会触发。
    // 第二次不能凭空多开一个标签页出来。
    const h = createHarness({ tabs: [{ id: 1, url: 'chrome://newtab/', audible: false }] });
    await seedLocked(h);
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setRefuseChromeNav(true);
    await h.send({ type: 'PLK_LEAVE', from: 'chrome://newtab/' }, true, 1);
    await h.settle();
    const mid = (await h.chrome.tabs.query({})).length;
    const before = h.log.length;
    const again = await h.send({ type: 'PLK_LEAVE', from: 'chrome://newtab/' }, true, 1);
    await h.settle();
    const after = h.log.slice(before);
    ok('第一次之后剩一个标签页', mid === 1, mid);
    ok('⭐ 再问一次不会多开标签页',
      after.every(function (l) { return l.indexOf('tabs.create') < 0; }), after);
    ok('标签页数量没变', (await h.chrome.tabs.query({})).length === 1);
    ok('如实回答已经处理完了', again && again.ok === true, again);
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
