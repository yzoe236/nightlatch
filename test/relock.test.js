/* Re-lock tests: "I type the password, it unlocks, then it locks straight
 * back and asks again."  Run: node test/relock.test.js
 *
 * Every case drives the real background.js through test/sw-harness.js, so
 * these are behaviour tests of the shipped service worker, not of a copy.
 */
'use strict';
const { createHarness, tick } = require('./sw-harness.js');

const MIN = 60000;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
}

// A profile with a password already set, seeded straight into fake storage so
// the 600k-iteration hash is paid once per case instead of per assertion.
async function seed(h, opts) {
  opts = opts || {};
  const rec = await h.PLK.hashPassword('correct horse');
  h.sync.plk_cfg = { hash: rec.hash, salt: rec.salt, iter: rec.iter, autolockMin: 5, strict: true };
  if (opts.unlocked) h.session.plk_unlocked = true;
  if (opts.lastActiveAgoMs !== undefined) h.session.plk_lastActive = Date.now() - opts.lastActiveAgoMs;
}

async function locked(h) { return h.api.isLocked(); }

(async function () {

  // ---------------------------------------------------------------- baseline
  console.log('\n基线(这些本来就该过):');
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 2 * 60 * MIN });
    h.fireAlarm();
    await h.settle();
    ok('闲置两小时 → 闹钟锁定', await locked(h) === true);
  }
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1 * MIN });
    h.fireAlarm();
    await h.settle();
    ok('刚活动过 → 闹钟不锁', await locked(h) === false);
  }
  {
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN }); // locked, stale clock
    const resp = await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    ok('密码正确 → 解锁', resp.ok === true && await locked(h) === false, resp);
    h.fireAlarm();
    await h.settle();
    ok('解锁后下一次闹钟不会把人锁回去', await locked(h) === false);
  }
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 2 * 60 * MIN });
    h.setTabs([{ id: 1, url: 'https://meet.example.com/', audible: true }]);
    h.fireAlarm();
    await h.settle();
    ok('有标签在放声音 → 不锁', await locked(h) === false);
  }

  // ------------------------------------------------- 嫌疑一:idle 'locked'
  console.log("\nchrome.idle 的 'locked' 事件:");
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('locked');           // 屏幕真的锁着
    h.fireIdle('locked');
    await h.settle();
    ok('屏幕真锁了 → 必须锁(核心卖点,不能削弱)', await locked(h) === true);
  }
  {
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    // 用户刚刚输对密码
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    const wasUnlocked = await locked(h) === false;
    // 一个过期/虚假的 'locked' 事件在解锁之后才投递到:
    // 系统此刻其实是 active(用户就坐在电脑前)
    h.setIdleState('active');
    h.fireIdle('locked');
    await h.settle();
    ok('⭐ 解锁后收到一个陈旧的 locked 事件 → 不该锁回去',
      wasUnlocked && await locked(h) === false,
      { wasUnlocked: wasUnlocked, nowLocked: await locked(h) });
  }
  {
    // 没有人输过密码 → 连问都不该问，三个都得锁。
    // (这条以前写反了：它把「一次都不该锁」当成期望，而那正是走开锁屏被放过的口子。)
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('active');
    h.fireIdle('locked');
    h.fireIdle('locked');
    h.fireIdle('locked');
    await h.settle();
    ok('没人解过锁时,active 状态下的 locked 事件照样锁', await locked(h) === true);
  }
  {
    // 真解锁之后的抖动才该被挡住，这才是 Leo 报的那个循环。
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setIdleState('active');
    h.fireIdle('locked');
    h.fireIdle('locked');
    h.fireIdle('locked');
    await h.settle();
    ok('⭐ 刚解锁后连来三个 locked(唤醒抖动) → 一次都不该锁',
      await locked(h) === false);
  }

  // --------------------------------------- 嫌疑二:陈旧判断覆盖新鲜的解锁
  console.log('\n判断用的是旧数据,写入落在解锁之后:');
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 2 * 60 * MIN });
    // 闹钟已经读完 plk_lastActive(旧值)、正卡在 tabs.query 上时,
    // 用户回到电脑前动了一下鼠标 → 内容脚本发 PLK_ACTIVITY
    h.hooks.beforeTabsQuery = async function () {
      await h.send({ type: 'PLK_ACTIVITY' });
    };
    h.fireAlarm();
    await h.settle();
    ok('⭐ 决定锁之后、写入之前有人动了 → 不该锁',
      await locked(h) === false,
      { lastActiveAgeMs: Date.now() - (h.session.plk_lastActive || 0) });
  }
  {
    // 真的从「解锁 → 闹钟开始判断 → 用户在另一个标签输对密码」这条路走一遍，
    // 而不是从头到尾都解锁着。旧版本会把这次刚验过的密码静默抹掉。
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 2 * 60 * MIN });
    h.hooks.beforeTabsQuery = async function () {
      await h.api.lockNow('test-setup');                       // 先真的锁上
      const r = await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
      if (!r || !r.ok) throw new Error('测试前提没成立：解锁失败');
    };
    h.fireAlarm();
    await h.settle();
    ok('⭐ 闹钟判断途中插进一次成功解锁 → 解锁不该被抹掉',
      await locked(h) === false);
  }

  // ------------------------------------------------------- 解锁写入的原子性
  console.log('\n解锁写入:');
  {
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.api.unlockNow();
    const age = Date.now() - (h.session.plk_lastActive || 0);
    ok('unlockNow 同时刷新了闲置时钟', age < 1000, { ageMs: age });
  }

  // ---------------------------------------------------------------- 审计记录
  console.log('');
  console.log('锁定原因记录(排查这个 bug 的抓手):');
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('locked');
    h.fireIdle('locked');
    await h.settle();
    const log = h.local.plk_lockLog || [];
    ok('真的锁屏 → 记一条 screen-lock',
      log.length === 1 && log[0].why === 'screen-lock' && log[0].did === true, log);
  }
  {
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setIdleState('active');
    h.fireIdle('locked');
    await h.settle();
    const log = (h.local.plk_lockLog || []).filter(function (e) { return !e.did; });
    ok('⭐ 忽略掉的陈旧事件也要留痕(这条就是证据)',
      log.length === 1 && log[0].why === 'screen-lock-stale', h.local.plk_lockLog);
  }
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 2 * 60 * MIN });
    h.fireAlarm();
    await h.settle();
    const log = h.local.plk_lockLog || [];
    ok('闲置超时 → 记一条 idle-timeout',
      log.length === 1 && log[0].why === 'idle-timeout' && log[0].did === true, log);
  }
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.listeners.command.forEach(function (f) { f('lock-now'); });
    await h.settle();
    const log = h.local.plk_lockLog || [];
    ok('快捷键 → 记一条 shortcut', log.length === 1 && log[0].why === 'shortcut', log);
    ok('快捷键仍然立刻锁上(不受任何新增判断影响)', await locked(h) === true);
  }
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('active');
    for (let i = 0; i < 25; i++) { h.fireIdle('locked'); await h.settle(60); }
    ok('记录封顶 20 条', (h.local.plk_lockLog || []).length === 20, (h.local.plk_lockLog || []).length);
  }
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('locked');
    h.fireIdle('locked');
    await h.settle();
    const dump = JSON.stringify(h.local.plk_lockLog);
    ok('记录里没有任何凭据或网址',
      dump.indexOf('correct horse') < 0 && dump.indexOf('http') < 0 && dump.indexOf('hash') < 0, dump);
  }

  // ------------------------------------------------------ 查不到状态要往锁上错
  console.log('');
  console.log('idle.queryState 出岔子时必须 fail closed:');
  for (const mode of ['throw', 'silent', 'undefined', 'lastError']) {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('active');   // 就算系统说 active,查不到答案也不能放过
    h.setIdleMode(mode);
    h.fireIdle('locked');
    await h.settle(2600);       // 'silent' 要等满 2 秒兜底
    ok('queryState ' + mode + ' → 仍然锁上', await locked(h) === true);
  }

  // ------------------------------------- 复核本身引入的新失败方向(审查揪出来的)
  console.log('');
  console.log('复核不能反过来放过真实的锁屏:');
  {
    // 走开锁屏 → 机器睡了 → 恢复后用户先解开 Windows,事件才姗姗来迟。
    // 查「此刻」会得到 active,和虚假事件长得一模一样。
    // 区别在于这里没有人输过密码,所以必须照锁不误。
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 30 * MIN });
    h.setIdleState('active');
    h.fireIdle('locked');
    await h.settle();
    ok('⭐ 迟到的走开锁屏事件(期间没人输过密码) → 必须锁',
      await locked(h) === true);
  }
  {
    // 事件发出时屏幕真锁着,复核跑完之前用户已经用 Windows Hello 解开了。
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    h.setIdleState('locked');
    h.fireIdle('locked');
    h.setIdleState('active');   // 复核读到的会是这个
    await h.settle();
    ok('⭐ 复核期间屏幕从 locked 变 active(指纹/面容秒解) → 仍然锁',
      await locked(h) === true);
  }
  {
    // 唯一放行的窗口:刚输对过密码,而且屏幕此刻确实没锁。
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setIdleState('active');
    h.fireIdle('locked');
    await h.settle();
    ok('刚解锁 + 屏幕确实是 active → 放过(这是唯一的放行口)',
      await locked(h) === false);
  }
  {
    // 同一个窗口里,人是真的按了 Win+L 走人:屏幕确实锁着,必须锁。
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setIdleState('locked');
    h.fireIdle('locked');
    await h.settle();
    ok('⭐ 解锁之后马上 Win+L 走人 → 必须锁', await locked(h) === true);
  }
  {
    // 宽限期过了以后,连问都不问,直接锁。
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.session.plk_unlockedAt = Date.now() - 60000;   // 一分钟前解的
    h.setIdleState('active');
    h.fireIdle('locked');
    await h.settle();
    ok('宽限期外的 locked 事件 → 无条件锁', await locked(h) === true);
  }

  // ------------------------------------------------- 并发不能丢审计记录
  console.log('');
  console.log('并发:');
  {
    // 后到的触发器看到已经锁上会正确地提前返回,所以「三个触发器 = 三条记录」
    // 本来就不成立。真正要压的是 noteLockEvent 自己的读改写:
    // 八个被忽略的事件都不改状态,但每一个都要写一条记录。
    const h = createHarness();
    await seed(h, { lastActiveAgoMs: 2 * 60 * MIN });
    await h.send({ type: 'PLK_UNLOCK', password: 'correct horse' });
    h.setIdleState('active');
    for (let i = 0; i < 8; i++) h.fireIdle('locked');
    await h.settle(900);
    const log = (h.local.plk_lockLog || []).filter(function (e) { return e.why === 'screen-lock-stale'; });
    ok('⭐ 八条记录同时写,一条都不丢', log.length === 8, log.length);
    ok('压测期间状态没被带歪(仍然解锁)', await locked(h) === false);
  }

  // --------------------------------------- 改密码这条路不能绕过中途发生的锁定
  console.log('');
  console.log('改密码途中被锁:');
  {
    const h = createHarness();
    await seed(h, { unlocked: true, lastActiveAgoMs: 1000 });
    // 校验当前密码要排队 + 跑 PBKDF2,期间屏幕锁了
    setTimeout(function () { h.setIdleState('locked'); h.fireIdle('locked'); }, 5);
    const resp = await h.send({ type: 'PLK_SET_PASSWORD', current: 'correct horse', next: 'brand new pw' }, true);
    await h.settle();
    ok('⭐ 校验途中 profile 被锁 → 改密码这条路不能顺手解锁',
      resp && resp.ok === false && resp.msg === 'locked' && await locked(h) === true, resp);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
