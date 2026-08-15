/* Nightlatch crypto — PBKDF2 password hashing + brute-force backoff.
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

  // ------------------------------------------------------- recovery code
  // Crockford base32: no I, L, O or U, so the look-alikes of 1 and 0 are gone
  // and the code survives being written on paper and typed back a month later.
  const RC_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const RC_GROUPS = 4;
  const RC_GROUP_LEN = 5; // 20 chars x 5 bits = 100 bits of entropy

  // The plaintext code. Shown to the user exactly once; only its hash is
  // stored, the same way the password is handled.
  function makeRecoveryCode() {
    const n = RC_GROUPS * RC_GROUP_LEN;
    const bytes = root.crypto.getRandomValues(new Uint8Array(n));
    let out = '';
    for (let i = 0; i < n; i++) {
      // 256 % 32 === 0, so this modulo is unbiased.
      out += RC_ALPHABET[bytes[i] % RC_ALPHABET.length];
      if ((i + 1) % RC_GROUP_LEN === 0 && i + 1 < n) out += '-';
    }
    return out;
  }

  // Canonical form for hashing and comparison. Accepts whatever the user
  // actually types: lower case, missing or extra dashes, spaces, and the
  // Crockford substitutions (I and L read as 1, O reads as 0).
  function normalizeRecoveryCode(s) {
    const up = String(s || '').toUpperCase()
      .replace(/[IL]/g, '1')
      .replace(/O/g, '0');
    let out = '';
    for (let i = 0; i < up.length; i++) {
      if (RC_ALPHABET.indexOf(up[i]) >= 0) out += up[i];
    }
    return out;
  }

  function recoveryCodeLength() { return RC_GROUPS * RC_GROUP_LEN; }

  root.NightlatchCrypto = {
    hashPassword: hashPassword,
    verifyPassword: verifyPassword,
    backoffMs: backoffMs,
    makeRecoveryCode: makeRecoveryCode,
    normalizeRecoveryCode: normalizeRecoveryCode,
    recoveryCodeLength: recoveryCodeLength,
    ITERATIONS: ITERATIONS
  };
})(typeof self !== 'undefined' ? self : globalThis);
