'use strict';
/**
 * sendworker.js — child process that transmits one interface's burst at a shared
 * wall-clock instant, so multiple interfaces fire (near-)simultaneously.
 * argv[2] = JSON { dev, frameHex, count, chunk, sync, startAt }  (startAt = epoch ms)
 * prints one JSON line: { ok, frames, bytes, fireMs, skewMs, durMs, [error] }
 */
const path = require('path');
if (process.platform === 'win32') {
  const npcap = 'C:\\Windows\\System32\\Npcap';
  if (process.env.PATH && !process.env.PATH.includes(npcap)) process.env.PATH = npcap + ';' + process.env.PATH;
}

function out(o) { try { process.stdout.write(JSON.stringify(o)); } catch {} }

let sq;
try { sq = require(path.join(__dirname, '..', 'native', 'sendqueue', 'build', 'Release', 'sendqueue.node')); }
catch (e) { out({ ok: false, error: 'sendqueue addon load failed: ' + e.message }); process.exit(0); }

let a;
try { a = JSON.parse(process.argv[2] || '{}'); } catch { out({ ok: false, error: 'bad args' }); process.exit(0); }
const frame = Buffer.from(a.frameHex || '', 'hex');
const startAt = a.startAt || Date.now();

function fire() {
  // spin the last moment for sub-ms precision
  while (Date.now() < startAt) { /* busy-wait */ }
  const fireMs = Date.now();
  const t0 = process.hrtime.bigint();
  let r;
  try { r = sq.transmit(a.dev, frame, a.count, a.chunk || 4000, a.sync ? 1 : 0); }
  catch (e) { return out({ ok: false, error: e.message, fireMs, skewMs: fireMs - startAt }); }
  const durMs = Number(process.hrtime.bigint() - t0) / 1e6;
  out({ ok: !!r.ok, frames: r.frames || 0, bytes: r.bytes || 0, error: r.error,
        fireMs, skewMs: fireMs - startAt, durMs });
}

const lead = startAt - Date.now();
if (lead > 3) setTimeout(fire, lead - 2); else fire();
