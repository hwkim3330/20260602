'use strict';
/**
 * setup-winfast.js — build the Npcap send-queue addon (server/native/sendqueue)
 * for high-rate TX on Windows (engine:"sendqueue"). Optional: a committed prebuilt
 * is used by default; this rebuilds for a different Node ABI / fresh checkout.
 *
 * Prereqs: Npcap runtime + VS Build Tools (Desktop C++) + Python (see
 * setup-cap-windows.js). Reuses the Npcap SDK already staged for cap when present.
 *
 * Usage:  npm run setup:winfast
 */
const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') { console.log('[winfast] not Windows — engine:"sendqueue" is Windows-only.'); process.exit(0); }

const SQ      = path.join(__dirname, '..', 'native', 'sendqueue');
const SQ_DEP  = path.join(SQ, 'deps', 'winpcap');
const CAP_DEP = path.join(__dirname, '..', 'node_modules', 'cap', 'deps', 'winpcap');

function die(m) { console.error('[winfast] ERROR:', m); process.exit(1); }
if (!fs.existsSync(SQ)) die('native/sendqueue not found');

// Stage the Npcap SDK: prefer the copy already used by cap; else have the user run setup:windows-cap first.
if (!fs.existsSync(path.join(SQ_DEP, 'Include', 'pcap.h'))) {
  if (fs.existsSync(path.join(CAP_DEP, 'Include', 'pcap.h'))) {
    fs.mkdirSync(path.join(SQ_DEP, 'Include'), { recursive: true });
    fs.mkdirSync(path.join(SQ_DEP, 'Lib', 'x64'), { recursive: true });
    const ps = (c) => spawnSync('powershell', ['-NoProfile', '-Command', c], { stdio: 'inherit' });
    ps(`Copy-Item '${path.join(CAP_DEP, 'Include', '*')}' '${path.join(SQ_DEP, 'Include')}' -Recurse -Force; ` +
       `Copy-Item '${path.join(CAP_DEP, 'Lib', 'x64', '*')}' '${path.join(SQ_DEP, 'Lib', 'x64')}' -Force`);
  } else {
    die('Npcap SDK not found. Run "npm run setup:windows-cap" first (it fetches the SDK).');
  }
}

// Find Python (node-gyp dependency) the same way setup-cap-windows does.
function findPython() {
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) return process.env.PYTHON;
  for (const base of [path.join(require('os').homedir(), 'AppData', 'Local', 'Programs', 'Python'), 'C:\\Program Files\\Python', 'C:\\Python']) {
    try { for (const d of fs.readdirSync(base).sort().reverse()) { const c = path.join(base, d, 'python.exe'); if (fs.existsSync(c)) return c; } } catch {}
  }
  return null;
}
const py = findPython();
if (py) process.env.PYTHON = py;

let gypJs = null;
try { gypJs = require.resolve('node-gyp/bin/node-gyp.js'); } catch {}
if (!gypJs) gypJs = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');

console.log('[winfast] building sendqueue addon...');
const r = spawnSync(process.execPath, [gypJs, 'rebuild', '--arch=' + process.arch, '--msvs_version=2022'],
  { cwd: SQ, stdio: 'inherit', env: process.env });
if (r.status !== 0) die('node-gyp build failed — ensure VS Build Tools (Desktop C++) + Python.');

try {
  require(path.join(SQ, 'build', 'Release', 'sendqueue.node'));
  console.log('[winfast] OK — engine:"sendqueue" available. Saving prebuilt...');
  require('./cap-prebuilt').saveCurrentBinary();
} catch (e) { die('built but failed to load: ' + e.message); }
