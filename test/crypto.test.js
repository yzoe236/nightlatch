/* Node unit tests for Nightlatch crypto + backoff.
 * Run: node test/crypto.test.js */
'use strict';
require('../crypto.js');
const P = globalThis.NightlatchCrypto;

(async function () {
  let pass = 0, fail = 0;
  function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  PASS ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' — got: ' + JSON.stringify(extra) : '')); }
  }

  console.log('hash/verify:');
  const rec = await P.hashPassword('leo-secret-42');
  ok('记录结构完整(hash/salt/iter)', !!(rec.hash && rec.salt) && rec.iter === P.ITERATIONS, rec);
  ok('正确密码通过', (await P.verifyPassword('leo-secret-42', rec)) === true);
  ok('错误密码拒绝', (await P.verifyPassword('leo-secret-43', rec)) === false);
  ok('空密码拒绝', (await P.verifyPassword('', rec)) === false);
  ok('空记录拒绝', (await P.verifyPassword('leo-secret-42', null)) === false);

  const rec2 = await P.hashPassword('leo-secret-42');
  ok('同密码两次设置盐值不同', rec2.salt !== rec.salt && rec2.hash !== rec.hash);
  ok('篡改哈希被拒', (await P.verifyPassword('leo-secret-42', { hash: rec.hash.slice(0, -2) + 'AA', salt: rec.salt, iter: rec.iter })) === false);
  ok('中文密码可用', (await P.verifyPassword('实验室锁🔒', await P.hashPassword('实验室锁🔒'))) === true);

  console.log('backoff:');
  ok('前 4 次不罚', P.backoffMs(1) === 0 && P.backoffMs(4) === 0);
  ok('第 5 次 30 秒', P.backoffMs(5) === 30000);
  ok('之后翻倍', P.backoffMs(6) === 60000 && P.backoffMs(7) === 120000);
  ok('封顶 5 分钟', P.backoffMs(20) === 300000);

  console.log('迭代次数与向后兼容:');
  ok('新哈希用 600000 次（OWASP 2026-08-15 建议值）', P.ITERATIONS === 600000, P.ITERATIONS);
  // 0.4.0 / 0.5.0 装机的用户哈希是 310000 次写的，升级后必须照样能解锁
  const legacy = { hash: null, salt: null, iter: 310000 };
  {
    const enc = new TextEncoder();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', enc.encode('old-user-password'), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 310000 }, key, 256);
    const b = new Uint8Array(bits); let s2 = '';
    for (let i = 0; i < b.length; i++) s2 += String.fromCharCode(b[i]);
    legacy.hash = btoa(s2);
    let s3 = ''; for (let i = 0; i < saltBytes.length; i++) s3 += String.fromCharCode(saltBytes[i]);
    legacy.salt = btoa(s3);
  }
  ok('⭐ 老用户 310000 次的哈希仍然能验通过', (await P.verifyPassword('old-user-password', legacy)) === true);
  ok('老哈希也不会放错密码进来', (await P.verifyPassword('wrong', legacy)) === false);

  console.log('恢复码 格式:');
  const rc = P.makeRecoveryCode();
  ok('形如 XXXXX-XXXXX-XXXXX-XXXXX', /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(rc), rc);
  ok('不含易混字母 I L O U', !/[ILOU]/.test(rc), rc);
  ok('去掉连字符后 20 位', P.normalizeRecoveryCode(rc).length === P.recoveryCodeLength());

  const many = new Set();
  for (let i = 0; i < 300; i++) many.add(P.makeRecoveryCode());
  ok('生成 300 个无重复', many.size === 300, many.size);

  console.log('恢复码 归一化（用户手抄回来打成什么样都得认）:');
  ok('小写', P.normalizeRecoveryCode(rc.toLowerCase()) === P.normalizeRecoveryCode(rc));
  ok('漏掉连字符', P.normalizeRecoveryCode(rc.replace(/-/g, '')) === P.normalizeRecoveryCode(rc));
  ok('打成空格', P.normalizeRecoveryCode(' ' + rc.replace(/-/g, ' ') + ' ') === P.normalizeRecoveryCode(rc));
  ok('I 认成 1', P.normalizeRecoveryCode('I2345') === '12345');
  ok('L 认成 1', P.normalizeRecoveryCode('L2345') === '12345');
  ok('O 认成 0', P.normalizeRecoveryCode('O2345') === '02345');
  ok('空输入不炸', P.normalizeRecoveryCode(null) === '' && P.normalizeRecoveryCode(undefined) === '');

  console.log('恢复码 校验:');
  const rcRec = await P.hashPassword(P.normalizeRecoveryCode(rc));
  ok('正确的码通过', (await P.verifyPassword(P.normalizeRecoveryCode(rc), rcRec)) === true);
  ok('抄成小写没连字符也通过',
    (await P.verifyPassword(P.normalizeRecoveryCode(rc.toLowerCase().replace(/-/g, '')), rcRec)) === true);
  ok('另一个码被拒',
    (await P.verifyPassword(P.normalizeRecoveryCode(P.makeRecoveryCode()), rcRec)) === false);
  ok('空码被拒', (await P.verifyPassword('', rcRec)) === false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
