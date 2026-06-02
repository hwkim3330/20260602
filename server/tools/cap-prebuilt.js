'use strict';
/**
 * cap-prebuilt.js — make the committed `cap` native module work on multiple OSes.
 *
 * `cap` is an old nan-based addon with no npm prebuilds, so its compiled
 * cap.node is specific to (platform, arch, Node ABI). We keep per-target copies
 * under server/prebuilds/<platform>-<arch>/node-v<ABI>/cap.node and, at startup,
 * drop the one matching THIS machine into node_modules/cap/build/Release/cap.node
 * before anything requires `cap`. This lets a committed node_modules run on both
 * Windows and Linux from a fresh clone (for the Node majors we ship binaries for).
 *
 * If no matching prebuilt exists, we leave whatever is already there (a local
 * npm build / postinstall result) untouched. Failures are non-fatal.
 *
 * To ADD a platform: build cap there once (npm run setup:windows-cap on Windows,
 * or npm rebuild cap on Linux) then run `node tools/cap-prebuilt.js --save` to
 * copy the freshly built binary into prebuilds/, and commit it.
 */
const fs   = require('fs');
const path = require('path');

const CAP_BIN = path.join(__dirname, '..', 'node_modules', 'cap', 'build', 'Release', 'cap.node');

function targetDir() {
  const key = `${process.platform}-${process.arch}`;
  return path.join(__dirname, '..', 'prebuilds', key, `node-v${process.versions.modules}`);
}
function prebuiltPath() { return path.join(targetDir(), 'cap.node'); }

function _sameBytes(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0;
  } catch { return false; }
}

/** Place the prebuilt matching this platform/ABI into cap's load path. */
function ensureCapBinary() {
  try {
    const src = prebuiltPath();
    if (!fs.existsSync(src)) return false;           // no prebuilt for this target
    if (fs.existsSync(CAP_BIN) && _sameBytes(src, CAP_BIN)) return true; // already in place
    fs.mkdirSync(path.dirname(CAP_BIN), { recursive: true });
    fs.copyFileSync(src, CAP_BIN);
    console.log(`[cap-prebuilt] installed ${process.platform}-${process.arch}/node-v${process.versions.modules} cap.node`);
    return true;
  } catch (e) {
    console.warn('[cap-prebuilt] could not install prebuilt:', e.message);
    return false;
  }
}

/** Copy the currently built cap.node into prebuilds/ for this platform/ABI. */
function saveCurrentBinary() {
  if (!fs.existsSync(CAP_BIN)) { console.error('[cap-prebuilt] no built cap.node to save at', CAP_BIN); return false; }
  fs.mkdirSync(targetDir(), { recursive: true });
  fs.copyFileSync(CAP_BIN, prebuiltPath());
  console.log('[cap-prebuilt] saved', prebuiltPath());
  return true;
}

module.exports = { ensureCapBinary, saveCurrentBinary, prebuiltPath };

// CLI: `node tools/cap-prebuilt.js --save`
if (require.main === module) {
  if (process.argv.includes('--save')) saveCurrentBinary();
  else ensureCapBinary();
}
