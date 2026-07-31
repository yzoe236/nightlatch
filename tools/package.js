/* Package Nightlatch for distribution.
 *   node tools/package.js            → dist/nightlatch-transfer.zip
 *       Runnable copy for your own machines. KEEPS manifest "key" so the
 *       extension ID (and therefore synced password/license) stays identical
 *       everywhere. Excludes dev-key.pem, tests and tooling.
 *   node tools/package.js --store    → dist/nightlatch-store.zip
 *       Chrome Web Store upload. STRIPS manifest "key" (the store assigns the
 *       real ID) and everything a reviewer shouldn't see.
 * Zipping uses PowerShell's Compress-Archive — no npm dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STORE = process.argv.includes('--store');
const SHIP = ['manifest.json', 'background.js', 'content.js', 'crypto.js',
  'themes.js', 'locked.html', 'locked.js', 'popup.html', 'popup.js', 'options.html', 'options.js',
  'LICENSE'];

const stage = path.join(ROOT, 'dist', STORE ? '_stage_store' : '_stage_transfer');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of SHIP) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) throw new Error('missing file: ' + f);
  fs.copyFileSync(src, path.join(stage, f));
}

// icons/ is optional until they exist
const icons = path.join(ROOT, 'icons');
if (fs.existsSync(icons)) fs.cpSync(icons, path.join(stage, 'icons'), { recursive: true });

const mfPath = path.join(stage, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
if (STORE) {
  delete mf.key; // the store issues the canonical ID
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
}

const out = path.join(ROOT, 'dist', STORE ? 'nightlatch-store.zip' : 'nightlatch-transfer.zip');
fs.rmSync(out, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  'Compress-Archive -Path "' + stage + '\\*" -DestinationPath "' + out + '" -Force']);
fs.rmSync(stage, { recursive: true, force: true });

console.log((STORE ? 'STORE' : 'TRANSFER') + ' build: ' + out);
console.log('version ' + mf.version + (STORE ? ' (manifest key stripped)' : ' (manifest key kept → stable ID)'));
console.log(Math.round(fs.statSync(out).size / 1024) + ' KB');
