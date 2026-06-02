'use strict';
/**
 * setup-cap-windows.js — make the `cap` (libpcap/Npcap) native module work on Windows.
 *
 * The npm `cap` package ships no Windows prebuilt and its binding.gyp expects the
 * Npcap SDK under node_modules/cap/deps/winpcap. A cap.node built on another OS
 * (e.g. Linux) fails on Windows with "is not a valid Win32 application" or
 * ERR_DLOPEN_FAILED. This script fetches the Npcap SDK, drops it where binding.gyp
 * looks, and rebuilds cap.node for the current Node/arch.
 *
 * Prerequisites (one-time):
 *   • Npcap runtime installed   → https://npcap.com/#download  (WinPcap-compat mode ok)
 *   • Visual Studio Build Tools with the "Desktop development with C++" workload
 *   • Python 3 (node-gyp dependency)
 *
 * Usage:  npm run setup:windows-cap     (from the server/ directory)
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync, spawnSync } = require('child_process');

const SDK_VERSION = process.env.NPCAP_SDK_VERSION || '1.13';
const SDK_URL     = `https://npcap.com/dist/npcap-sdk-${SDK_VERSION}.zip`;

function log(...a) { console.log('[setup-cap-windows]', ...a); }
function die(msg)  { console.error('[setup-cap-windows] ERROR:', msg); process.exit(1); }

if (process.platform !== 'win32') {
  log('not Windows — nothing to do (Linux/macOS build cap via: npm install cap).');
  process.exit(0);
}

const capDir = path.join(__dirname, '..', 'node_modules', 'cap');
if (!fs.existsSync(capDir)) die('node_modules/cap not found — run "npm install" first.');

// Ensure Npcap runtime DLLs are reachable so the rebuilt module can be verified.
const npcapDir = 'C:\\Windows\\System32\\Npcap';
if (fs.existsSync(npcapDir) && !process.env.PATH.includes(npcapDir))
  process.env.PATH = npcapDir + ';' + process.env.PATH;

// Already working? then skip the rebuild.
try { require(path.join(capDir, 'lib', 'Cap.js')); log('cap already loads — nothing to rebuild.'); process.exit(0); }
catch { /* needs rebuild */ }

// 1) download + extract the Npcap SDK via PowerShell (Expand-Archive)
const tmp    = path.join(os.tmpdir(), 'npcap-sdk-' + SDK_VERSION);
const zip    = tmp + '.zip';
log('downloading Npcap SDK', SDK_VERSION, '→', SDK_URL);
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
  { stdio: 'inherit' });
let r = ps(`$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '${SDK_URL}' -OutFile '${zip}'`);
if (r.status !== 0) die('Npcap SDK download failed (check network / NPCAP_SDK_VERSION).');
ps(`if (Test-Path '${tmp}') { Remove-Item '${tmp}' -Recurse -Force }; Expand-Archive '${zip}' -DestinationPath '${tmp}' -Force`);

// 2) place headers + x64 libs where binding.gyp expects them
const dep = path.join(capDir, 'deps', 'winpcap');
fs.mkdirSync(path.join(dep, 'Include'), { recursive: true });
fs.mkdirSync(path.join(dep, 'Lib', 'x64'), { recursive: true });
ps(`Copy-Item '${path.join(tmp, 'Include', '*')}' '${path.join(dep, 'Include')}' -Recurse -Force; ` +
   `Copy-Item '${path.join(tmp, 'Lib', 'x64', '*')}' '${path.join(dep, 'Lib', 'x64')}' -Force; ` +
   `Copy-Item '${path.join(tmp, 'Lib', '*.lib')}' '${path.join(dep, 'Lib')}' -Force`);
if (!fs.existsSync(path.join(dep, 'Include', 'pcap.h')) || !fs.existsSync(path.join(dep, 'Lib', 'x64', 'wpcap.lib')))
  die('Npcap SDK files were not placed correctly.');
log('Npcap SDK staged at', dep);

// 3) rebuild cap.node for this Node/arch
// node-gyp needs Python; it is often installed but not on PATH. Discover it and
// export PYTHON so node-gyp's configure step does not fail.
function findPython() {
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) return process.env.PYTHON;
  const dirs = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python'),
    'C:\\Program Files\\Python', 'C:\\Python',
  ];
  for (const base of dirs) {
    try {
      for (const d of fs.readdirSync(base).sort().reverse()) {
        const c = path.join(base, d, 'python.exe');
        if (fs.existsSync(c)) return c;
      }
    } catch {}
  }
  for (const exe of ['python', 'python3', 'py']) {
    const w = spawnSync('where', [exe], { encoding: 'utf8' });
    if (w.status === 0) {
      const p = (w.stdout || '').split(/\r?\n/).map(s => s.trim())
        .find(s => s && fs.existsSync(s) && !/WindowsApps/i.test(s)); // skip Store stub
      if (p) return p;
    }
  }
  return null;
}
const py = findPython();
if (py) { process.env.PYTHON = py; log('using Python:', py); }
else log('WARNING: Python not auto-detected — set PYTHON env if rebuild fails.');

try { fs.rmSync(path.join(capDir, 'build', 'Release', 'cap.node'), { force: true }); } catch {}
log('rebuilding cap.node with node-gyp (needs VS Build Tools + Python)...');

// Run node-gyp's JS entry with the current Node binary. Spawning the `npx.cmd`
// shim via spawnSync (no shell) silently fails on Windows, so resolve the script
// and invoke it directly; fall back to a shell-resolved npx only if not found.
const gypArgs = ['rebuild', '--arch=' + process.arch, '--msvs_version=2022'];
let gypJs = null;
const gypCandidates = [];
try { gypCandidates.push(require.resolve('node-gyp/bin/node-gyp.js')); } catch {}
gypCandidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'));
for (const c of gypCandidates) { if (c && fs.existsSync(c)) { gypJs = c; break; } }

r = gypJs
  ? spawnSync(process.execPath, [gypJs, ...gypArgs], { cwd: capDir, stdio: 'inherit', env: process.env })
  : spawnSync('npx node-gyp ' + gypArgs.join(' '), { cwd: capDir, stdio: 'inherit', env: process.env, shell: true });
if (r.status !== 0) die('node-gyp rebuild failed — ensure VS Build Tools (Desktop C++) and Python are installed.');

// 4) verify
try { require(path.join(capDir, 'lib', 'Cap.js')); }
catch (e) { die('cap still fails to load after rebuild: ' + e.message); }
const list = require(path.join(capDir, 'lib', 'Cap.js')).deviceList?.() || [];
log('SUCCESS — cap loads;', list.length, 'capture devices visible. Run: node server.js');
