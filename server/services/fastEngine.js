'use strict';
/**
 * fastEngine.js — OPTIONAL Linux high-speed TX/RX engine.
 *
 * Thin adapter over the external `traffic-generator` tools (txgen / rxcap):
 *   txgen → AF_PACKET + sendmmsg high-rate sender
 *   rxcap → AF_PACKET + recvmmsg measurement capture (latency/IAT/seq/loss)
 *
 * This is a REUSE CANDIDATE, not a replacement. PacketLabManager's default
 * cap(npm)/tcpdump path (Basic Packet Send / Basic Capture, Windows/Npcap) is
 * unchanged and remains the default. The fast engine is only used when:
 *   • the caller explicitly selects engine:"fast", AND
 *   • the platform is Linux AND the txgen/rxcap binaries are available.
 * Otherwise callers get a clear "fast engine unavailable" error and should fall
 * back to the cap path.
 *
 * Binaries are discovered on PATH (or via PLM_TXGEN / PLM_RXCAP overrides).
 * Build them from https://github.com/hwkim3330/traffic-generator (`make`).
 */
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ── discovery ────────────────────────────────────────────────────────────────
function _which(bin) {
  const override = process.env['PLM_' + bin.toUpperCase()]; // PLM_TXGEN / PLM_RXCAP
  if (override && fs.existsSync(override)) return override;
  if (process.platform !== 'linux') return null;
  try {
    const r = spawnSync('sh', ['-lc', `command -v ${bin} 2>/dev/null || true`], { encoding: 'utf8' });
    const p = (r.stdout || '').trim().split(/\r?\n/)[0];
    if (p && fs.existsSync(p)) return p;
  } catch { /* ignore */ }
  for (const c of [`/usr/local/bin/${bin}`, `/usr/bin/${bin}`]) if (fs.existsSync(c)) return c;
  return null;
}

let _cache = null;
function info(refresh = false) {
  if (_cache && !refresh) return _cache;
  const txgen = _which('txgen');
  const rxcap = _which('rxcap');
  _cache = {
    platform:  process.platform,
    available: process.platform === 'linux' && !!(txgen || rxcap),
    txgen:     txgen || null,
    rxcap:     rxcap || null,
    note: process.platform !== 'linux'
      ? 'fast engine (txgen/rxcap) is Linux-only — use cap/tcpdump on this OS'
      : (!txgen && !rxcap
          ? 'txgen/rxcap not found — build traffic-generator (make) and install to PATH, or set PLM_TXGEN/PLM_RXCAP'
          : ''),
  };
  return _cache;
}
function isAvailable() { return info().available; }
function canSend()     { return !!info().txgen; }
function canCapture()  { return !!info().rxcap; }

// ── argument mapping (pure — unit-testable without the binaries) ───────────────
function _macOk(m) { return !!m && !/^[0:\-\s]+$/.test(String(m)); }

/** Map a PacketLabManager packet profile to txgen CLI args (interface last). */
function buildTxArgs(profile) {
  const p = profile || {};
  const ethBlk = Array.isArray(p.blocks) ? p.blocks.find(b => b && b.type === 'Ethernet') : null;
  const vlanBlk = Array.isArray(p.blocks) ? p.blocks.find(b => b && b.type === 'VLAN') : null;
  const udpBlk = Array.isArray(p.blocks) ? p.blocks.find(b => b && b.type === 'UDP') : null;
  const ip = p.ipv4 || {};

  const iface  = p.interface;
  const dstMac = (p.dstMac || ethBlk?.dstMac || '').trim();
  const dstIp  = (ip.dst   || p.dstIp || '').trim();
  if (!iface)  throw new Error('fast send (txgen) requires an interface');
  if (!dstMac) throw new Error('fast send (txgen) requires a destination MAC (-b)');
  if (!dstIp)  throw new Error('fast send (txgen) requires a destination IP (-B)');

  const args = ['-B', dstIp, '-b', dstMac];
  const srcMac = (p.srcMac || ethBlk?.srcMac || '').trim();
  if (_macOk(srcMac)) args.push('-a', srcMac);            // else txgen uses the NIC MAC
  const srcIp = ip.src || p.srcIp;
  if (srcIp) args.push('-A', String(srcIp));
  if (ip.ttl != null) args.push('-T', String(ip.ttl));

  args.push('-t', 'udp');                                  // txgen is UDP-centric
  const udp = p.udp || {};
  const dstPort = udp.dstPort ?? udpBlk?.dstPort ?? p.dstPort;
  const srcPort = udp.srcPort ?? udpBlk?.srcPort ?? p.srcPort;
  if (dstPort != null) args.push('-p', String(dstPort));
  if (srcPort != null) args.push('-P', String(srcPort));

  const vlan = p.vlan || (vlanBlk ? { enabled: true, id: vlanBlk.vlanId, priority: vlanBlk.priority } : null);
  if (vlan && vlan.enabled && vlan.id != null) args.push('-Q', `${vlan.priority ?? 0}:${vlan.id}`);

  args.push('-c', String(p.count ?? 1));                   // 0 = infinite
  if (p.rateMbps)   args.push('-r', String(p.rateMbps));
  else if (p.pps)   args.push('--pps', String(p.pps));
  if (p.durationSec) args.push('--duration', String(p.durationSec));
  const len = p.length || p.targetFrameLength;
  if (len) args.push('-l', String(len));
  if (p.seq)       args.push('--seq');
  if (p.timestamp) args.push('--timestamp');

  args.push(iface);
  return args;
}

/** Map capture-measure options to rxcap CLI args (interface last). */
function buildRxArgs(opts) {
  const o = opts || {};
  const iface = o.interface || (Array.isArray(o.interfaces) ? o.interfaces[0] : null);
  if (!iface) throw new Error('fast capture (rxcap) requires an interface');
  const args = [];
  args.push('--duration', String(o.durationSec ?? 10));
  if (o.dstMac)   args.push('--dst-mac', String(o.dstMac));
  if (o.vlan != null) args.push('--vlan', String(o.vlan));
  if (o.pcp != null)  args.push('--pcp', String(o.pcp));
  if (o.seq)      args.push('--seq');
  if (o.latency)  args.push('--latency');
  if (o.pcpStats) args.push('--pcp-stats');
  args.push(iface);
  return args;
}

// ── execution (Linux-only paths) ───────────────────────────────────────────────
function _readCsvTail(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    const last = lines[lines.length - 1];
    return last ? last.split(',') : null;
  } catch { return null; }
}

function sendFast(profile) {
  return new Promise((resolve, reject) => {
    const inf = info();
    if (!inf.txgen) return reject(new Error(inf.note || 'fast send unavailable (txgen not found)'));
    let args;
    try { args = buildTxArgs(profile); } catch (e) { return reject(e); }
    const statsFile = path.join(os.tmpdir(), `plm-txgen-${process.pid}-${Date.now()}.csv`);
    const full = [...args, '--stats-file', statsFile];
    const child = spawn(inf.txgen, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => reject(new Error(`txgen spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      const stats = _readCsvTail(statsFile);
      try { fs.unlinkSync(statsFile); } catch {}
      if (code !== 0) return reject(new Error(`txgen exited ${code}: ${(err || out).slice(0, 500)}`));
      resolve({ engine: 'txgen', framesSent: profile.count ?? 1, stats, command: `${path.basename(inf.txgen)} ${full.join(' ')}` });
    });
  });
}

function captureMeasure(opts) {
  return new Promise((resolve, reject) => {
    const inf = info();
    if (!inf.rxcap) return reject(new Error(inf.note || 'fast capture unavailable (rxcap not found)'));
    let args;
    try { args = buildRxArgs(opts); } catch (e) { return reject(e); }
    const csvFile = path.join(os.tmpdir(), `plm-rxcap-${process.pid}-${Date.now()}.csv`);
    const full = [...args.slice(0, -1), '--csv', csvFile, args[args.length - 1]];
    const child = spawn(inf.rxcap, full, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => reject(new Error(`rxcap spawn failed: ${e.message}`)));
    child.on('close', (code) => {
      let rows = [];
      try { rows = fs.readFileSync(csvFile, 'utf8').trim().split(/\r?\n/).map(l => l.split(',')); } catch {}
      try { fs.unlinkSync(csvFile); } catch {}
      if (code !== 0) return reject(new Error(`rxcap exited ${code}: ${(err || out).slice(0, 500)}`));
      resolve({ engine: 'rxcap', csvRows: rows, command: `${path.basename(inf.rxcap)} ${full.join(' ')}` });
    });
  });
}

module.exports = {
  info, isAvailable, canSend, canCapture,
  buildTxArgs, buildRxArgs,   // exported for unit tests
  sendFast, captureMeasure,
};
