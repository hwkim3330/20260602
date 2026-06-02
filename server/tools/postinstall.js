'use strict';
/**
 * postinstall.js — cross-platform `cap` self-heal after `npm install`.
 *
 * The committed node_modules may carry a cap.node built for a different OS/Node
 * ABI. If the module fails to load on the current machine, rebuild it for this
 * platform. This NEVER fails the install (always exits 0) — packet send/capture
 * is optional and the server still runs (tcpdump fallback / non-packet features).
 */
const path = require('path');
const { spawnSync } = require('child_process');

function capLoads() {
  try {
    if (process.platform === 'win32') {
      const npcap = 'C:\\Windows\\System32\\Npcap';
      if (process.env.PATH && !process.env.PATH.includes(npcap)) process.env.PATH = npcap + ';' + process.env.PATH;
    }
    require(path.join(__dirname, '..', 'node_modules', 'cap', 'lib', 'Cap.js'));
    return true;
  } catch { return false; }
}

if (capLoads()) {
  process.exit(0); // already works for this platform
}

if (process.platform === 'win32') {
  console.log('[postinstall] cap not loadable on Windows — running cap setup (Npcap SDK + rebuild)...');
  // Spawn as a child so its exit code never fails this install.
  spawnSync(process.execPath, [path.join(__dirname, 'setup-cap-windows.js')], { stdio: 'inherit' });
} else {
  // Linux/macOS: the committed cap.node is almost always built for another OS
  // (e.g. the Windows binary) or a different Node ABI, so a fresh clone needs a
  // local rebuild. Mirror the Windows self-heal and rebuild from source. Never
  // fail the install — fall back to the manual hint if the toolchain is missing.
  console.log(`[postinstall] cap not loadable on ${process.platform} — rebuilding from source...`);
  const r = spawnSync('npm', ['rebuild', 'cap'], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
  if (r.status === 0 && capLoads()) {
    console.log('[postinstall] cap rebuilt successfully (send + capture available).');
  } else {
    console.warn('[postinstall] cap rebuild failed — packet capture will use the tcpdump fallback (capture only).');
    console.warn('[postinstall] For native send+capture, install build deps then `npm rebuild cap`:');
    console.warn('[postinstall]   Debian/Ubuntu: sudo apt install -y libpcap-dev build-essential python3');
    console.warn('[postinstall]   macOS:         xcode-select --install   (libpcap ships with the OS)');
  }
}
process.exit(0);
