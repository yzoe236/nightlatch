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
  ok('记录结构完整(hash/salt/iter)', !!(rec.hash && rec.salt) && rec.iter === 310000, rec);
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
