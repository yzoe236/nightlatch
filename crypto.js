/* ProfileLock crypto — PBKDF2 password hashing + brute-force backoff.
 * Classic script, no modules: importScripts() in the service worker,
 * <script src> in extension pages, require() under Node for unit tests.
 *
 * Design note: only the salted HASH is ever stored (storage.sync so one
 * password works on every machine). Lock STATE never touches this file —
 * it lives in chrome.storage.session, per device, by design. */
(function (root) {
  'use strict';

  const enc = new TextEncoder();
  const subtle = root.crypto && root.crypto.subtle;
  const ITERATIONS = 310000; // OWASP-recommended magnitude for PBKDF2-SHA256

  function b64(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }

  function unb64(s) {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  async function derive(password, saltBytes, iter) {
    const key = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter },
      key, 256
    );
    return b64(bits);
  }

  // → {hash, salt, iter} all storage-safe strings/numbers
  async function hashPassword(password) {
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    return {
      hash: await derive(password, salt, ITERATIONS),
      salt: b64(salt.buffer),
      iter: ITERATIONS
    };
  }

  async function verifyPassword(password, rec) {
    if (!rec || !rec.hash || !rec.salt) return false;
    const h = await derive(password, unb64(rec.salt), rec.iter || ITERATIONS);
    if (h.length !== rec.hash.length) return false;
    let diff = 0;
    for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ rec.hash.charCodeAt(i);
    return diff === 0;
  }

  // Wrong-password cooldown: 4 free tries, then 30s doubling, capped at 5 min.
  function backoffMs(fails) {
    if (fails < 5) return 0;
    return Math.min(300000, 30000 * Math.pow(2, fails - 5));
  }

  root.ProfileLockCrypto = { hashPassword: hashPassword, verifyPassword: verifyPassword, backoffMs: backoffMs, ITERATIONS: ITERATIONS };
})(typeof self !== 'undefined' ? self : globalThis);
