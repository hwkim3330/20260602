'use strict';
/**
 * cap-prebuilt.js — make committed native addons work across OS/Node-ABI.
 *
 * Native addons (cap, and our Npcap send-queue addon) compile to a binary tied to
 * (platform, arch, Node ABI). We keep per-target copies under
 *   server/prebuilds/<platform>-<arch>/node-v<ABI>/<name>.node
 * and, at startup, drop the one matching THIS machine into each addon's load path
 * before anything requires it. Lets a committed node_modules + native/ run on both
 * Windows and Linux from a fresh clone (for the Node majors we ship binaries for).
 *
 * No matching prebuilt → leave whatever is there (a local build) untouched.
 * Failures are non-fatal.
 *
 * Add a platform: build the addon there, then `node tools/cap-prebuilt.js --save`
 * copies the freshly built binaries into prebuilds/ to commit.
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// name → built binary path that `require` will load
const TARGETS = [
  { name: 'cap',       dest: path.join(ROOT, 'node_modules', 'cap', 'build', 'Release', 'cap.node') },
  { name: 'sendqueue', dest: path.join(ROOT, 'native', 'sendqueue', 'build', 'Release', 'sendqueue.node') },
];

function targetDir() {
  const key = `${process.platform}-${process.arch}`;
  return path.join(ROOT, 'prebuilds', key, `node-v${process.versions.modules}`);
}
function prebuiltPath(name) { return path.join(targetDir(), `${name}.node`); }

function _sameBytes(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
  } catch { return false; }
}

/** Place every prebuilt matching this platform/ABI into its addon's load path. */
function ensureCapBinary() {
  for (const t of TARGETS) {
    try {
      const src = prebuiltPath(t.name);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(t.dest) && _sameBytes(src, t.dest)) continue;
      fs.mkdirSync(path.dirname(t.dest), { recursive: true });
      fs.copyFileSync(src, t.dest);
      console.log(`[cap-prebuilt] installed ${process.platform}-${process.arch}/node-v${process.versions.modules} ${t.name}.node`);
    } catch (e) {
      console.warn(`[cap-prebuilt] could not install ${t.name}:`, e.message);
    }
  }
  return true;
}

/** Copy each currently built addon binary into prebuilds/ for this platform/ABI. */
function saveCurrentBinary() {
  fs.mkdirSync(targetDir(), { recursive: true });
  let n = 0;
  for (const t of TARGETS) {
    if (!fs.existsSync(t.dest)) { console.warn('[cap-prebuilt] no built', t.name, 'at', t.dest); continue; }
    fs.copyFileSync(t.dest, prebuiltPath(t.name));
    console.log('[cap-prebuilt] saved', prebuiltPath(t.name));
    n++;
  }
  return n > 0;
}

module.exports = { ensureCapBinary, ensureNativePrebuilts: ensureCapBinary, saveCurrentBinary, prebuiltPath };

if (require.main === module) {
  if (process.argv.includes('--save')) saveCurrentBinary();
  else ensureCapBinary();
}
