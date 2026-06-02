'use strict';
/**
 * packetBackend.js — Native packet send/capture.
 * Primary:  cap npm (libpcap) — full send + capture
 * Fallback: tcpdump subprocess — capture only, no compilation/Python needed
 *
 * Linux install:
 *   Full:    sudo apt install libpcap-dev build-essential && npm install cap
 *   Minimal: sudo apt install tcpdump  (capture only, no Python needed)
 */

const os             = require('os');
const fs             = require('fs');
const { spawn }      = require('child_process');
const { buildFrame } = require('./frameBuilder');

let Cap;
try { Cap = require('cap').Cap; } catch {}

// Optional Windows high-rate TX via the Npcap send-queue addon (built separately;
// see server/native/sendqueue). Sends many frames per driver call instead of one
// pcap_sendpacket per packet — ~4-5x faster on this stack. Absent → falls back to
// the normal per-packet cap.send path.
let _sq;
try { _sq = require('../native/sendqueue/build/Release/sendqueue.node'); } catch {}
function isFastSendAvailable() { return !!_sq; }

// ── Device resolution ──────────────────────────────────────────────────────────

function getDeviceList() {
  if (!Cap) return [];
  try { return Cap.deviceList() || []; } catch { return []; }
}

/** Resolve OS NIC name (e.g. "Wi-Fi", "eth0") to pcap device name. */
function resolveDevice(ifaceName) {
  if (!Cap) return null;
  if (!ifaceName) {
    const devs = getDeviceList();
    return devs.length ? devs[0].name : null;
  }

  const nics  = os.networkInterfaces();
  const devs  = getDeviceList();

  // Direct name match (Linux: eth0, wlan0)
  const direct = devs.find(d => d.name === ifaceName);
  if (direct) return direct.name;

  // Match by OS NIC IPv4 address
  const nicIps = new Set();
  for (const [name, entries] of Object.entries(nics || {})) {
    if (name.toLowerCase() === ifaceName.toLowerCase()) {
      for (const e of entries || []) if (e.family === 'IPv4') nicIps.add(e.address);
    }
  }
  for (const d of devs) {
    for (const a of d.addresses || []) {
      if (nicIps.has(a.addr)) return d.name;
    }
  }

  // Partial name / description match
  const lower = ifaceName.toLowerCase();
  const partial = devs.find(d =>
    d.name.toLowerCase().includes(lower) ||
    (d.description || '').toLowerCase().includes(lower));
  return partial?.name ?? null;
}

// ── Active captures ────────────────────────────────────────────────────────────

const activeCaptures = new Map(); // iface → { cap, buffer }

// ── Interface health monitor ───────────────────────────────────────────────────
// cap's libuv uv_poll_t asserts when a captured interface's fd becomes invalid
// (interface removed / goes down). Proactively close Cap handles the moment we
// detect the interface is gone so libuv can cleanly stop the poll handle first.
let _ifaceMonitorTimer = null;

function _liveIfaceNames() {
  try { return new Set(Object.keys(os.networkInterfaces() || {})); } catch { return new Set(); }
}

function _startIfaceMonitor() {
  if (_ifaceMonitorTimer) return;
  _ifaceMonitorTimer = setInterval(() => {
    if (activeCaptures.size === 0 && _sendHandles.size === 0) return;
    const live = _liveIfaceNames();
    // Liveness is checked against the OS interface name (os.networkInterfaces()
    // keys), NOT the pcap device name. On Windows/Npcap the pcap device name
    // (\Device\NPF_{GUID}) never appears in os.networkInterfaces(), so the old
    // `live.has(dev)` test wrongly closed every handle within 500ms. When the OS
    // name is unknown (auto-selected device) we skip the check rather than guess.
    for (const [dev, entry] of [...activeCaptures]) {
      if (entry.osName && !live.has(entry.osName)) {
        console.warn(`[packetBackend] interface ${entry.osName} removed — closing capture handle`);
        try { entry.cap.close(); } catch {}
        activeCaptures.delete(dev);
      }
    }
    for (const [dev, h] of [..._sendHandles]) {
      if (h.osName && !live.has(h.osName)) _dropSendHandle(dev);
    }
  }, 500);
}

// Gracefully close all Cap handles on process exit so libuv poll stops cleanly
function _closeAllCapHandles() {
  for (const [, entry] of activeCaptures) { try { entry.cap.close(); } catch {} }
  activeCaptures.clear();
  for (const [dev] of [..._sendHandles]) { try { _dropSendHandle(dev); } catch {} }
}

// ── tcpdump fallback capture (no cap, no Python needed) ───────────────────────

const activeTcpdump = new Map(); // iface → child_process
let lastCaptureError = '';        // last stderr from tcpdump

function startCaptureTcpdump(ifaceNames, filter, onPacket, onError) {
  const ifaces = ifaceNames.length ? ifaceNames : ['any'];
  let started  = 0;
  lastCaptureError = '';

  for (const iface of ifaces) {
    if (activeTcpdump.has(iface)) continue;

    const args = ['-i', iface, '-w', '-', '-U', '--immediate-mode'];
    if (filter) args.push(filter);

    let proc;
    try { proc = spawn('tcpdump', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { continue; }

    let pcapBuf    = Buffer.alloc(0);
    let hdrDone    = false;
    let littleEnd  = true;

    proc.stdout.on('data', (chunk) => {
      pcapBuf = Buffer.concat([pcapBuf, chunk]);

      // Parse global pcap header (24 bytes)
      if (!hdrDone) {
        if (pcapBuf.length < 24) return;
        const magic = pcapBuf.readUInt32LE(0);
        if (magic === 0xa1b2c3d4)      { littleEnd = true;  }
        else if (magic === 0xd4c3b2a1) { littleEnd = false; }
        else { proc.kill(); return; }
        pcapBuf = pcapBuf.slice(24);
        hdrDone = true;
      }

      // Parse packet records
      const r32 = (o) => littleEnd ? pcapBuf.readUInt32LE(o) : pcapBuf.readUInt32BE(o);
      while (pcapBuf.length >= 16) {
        const tsSec  = r32(0);
        const tsUsec = r32(4);
        const incl   = r32(8);
        const origLen = r32(12); // read before slicing
        if (pcapBuf.length < 16 + incl) break;
        const frame  = Buffer.from(pcapBuf.slice(16, 16 + incl));
        pcapBuf      = pcapBuf.slice(16 + incl);
        const hexStr = frame.toString('hex');

        // Suppress tcpdump echo of our own injected TX frames
        const txKey = iface + hexStr;
        if (_recentTxHexes.has(txKey)) {
          if (_recentTxHexes.get(txKey) > Date.now()) { _recentTxHexes.delete(txKey); continue; }
          _recentTxHexes.delete(txKey);
        }

        const no      = ++captureSeq;
        const ts      = tsSec + tsUsec / 1e6;
        const decoded = decodeFrame(frame);
        const record  = { no, timestamp: ts, interface: iface, length: origLen, frameHex: hexStr, decoded };
        insertCaptureSorted(record);
        try { onPacket(iface, frame, record); } catch {}
        for (const cb of captureStreamCbs) { try { cb(record); } catch {} }
      }
    });

    // Capture stderr: normal startup line ("listening on …") is not an error
    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (!msg) return;
      lastCaptureError = msg;
      if (!/listening on /i.test(msg)) {
        try { onError && onError(new Error(msg)); } catch {}
      }
    });

    proc.on('error', (err) => {
      lastCaptureError = err.message;
      try { onError && onError(err); } catch {};
    });
    proc.on('close', () => { activeTcpdump.delete(iface); });

    activeTcpdump.set(iface, proc);
    started++;
  }
  return started > 0;
}

function getLastCaptureError() { return lastCaptureError; }

function stopCaptureTcpdump() {
  for (const [, proc] of activeTcpdump) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  activeTcpdump.clear();
}

function hasTcpdump() {
  try { const { spawnSync } = require('child_process'); return spawnSync('tcpdump', ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

// ── Unified startCapture ───────────────────────────────────────────────────────

function startCapture(ifaceNames, filter, onPacket, onError) {
  // filter=''(promisc)이면 BPF 필터 미적용, null/undefined일 때만 MAC 기반 필터 자동 생성
  const effectiveFilter = filter ?? (ifaceNames.length ? buildIfaceBpfFilter(ifaceNames) : '');
  lastCaptureError = ''; // clear stale errors from a previous attempt

  if (Cap) {
    // Primary: cap npm
    const ifaces = ifaceNames.length ? ifaceNames : [null];
    let started  = 0;

    for (const name of ifaces) {
      const dev = resolveDevice(name);
      if (!dev) { lastCaptureError = lastCaptureError || `pcap device resolve failed for "${name}"`; continue; }
      if (activeCaptures.has(dev)) continue;

      // UI-facing label = requested OS interface name; falls back to pcap device
      // name when no name was supplied. The pcap device name (e.g. \Device\NPF_…
      // on Windows) is kept internally as the map key but never shown directly.
      const label = name || dev;

      try {
        const c      = new Cap();
        const buf    = Buffer.alloc(65535);
        c.open(dev, effectiveFilter, 10 * 1024 * 1024, buf);
        c.setMinBytes && c.setMinBytes(0);

        c.on('packet', (nbytes) => {
          try {
            const frame  = Buffer.from(buf.slice(0, nbytes));
            const hexStr = frame.toString('hex');
            // Suppress libpcap echo of our own injected TX frames
            const txKey = dev + hexStr;
            if (_recentTxHexes.has(txKey)) {
              if (_recentTxHexes.get(txKey) > Date.now()) {
                _recentTxHexes.delete(txKey);
                return; // already recorded as TX
              }
              _recentTxHexes.delete(txKey);
            }
            const no      = ++captureSeq;
            const ts      = Date.now() / 1000;
            const decoded = decodeFrame(frame);
            const record  = { no, timestamp: ts, interface: label, length: nbytes, frameHex: hexStr, decoded };
            insertCaptureSorted(record);
            onPacket(label, frame, record);
            for (const cb of captureStreamCbs) { try { cb(record); } catch {} }
          } catch {}
        });
        c.on('error', (err) => { lastCaptureError = err.message; try { onError && onError(err); } catch {} });

        activeCaptures.set(dev, { cap: c, buffer: buf, label, osName: name || null });
        started++;
      } catch (e) {
        // Surface why the device could not be opened (bad BPF filter, permission, etc.)
        lastCaptureError = e.message || String(e);
      }
    }
    if (started > 0) _startIfaceMonitor();
    return started > 0;
  }

  // Fallback: tcpdump subprocess (no Python, no native compilation)
  return startCaptureTcpdump(ifaceNames, effectiveFilter, onPacket, onError);
}

function stopCapture() {
  for (const [, { cap }] of activeCaptures) {
    try { cap.close(); } catch {}
  }
  activeCaptures.clear();
  stopCaptureTcpdump();
}

function isCapturing() { return activeCaptures.size > 0 || activeTcpdump.size > 0; }

function getCaptureDeviceNames() {
  return [...Array.from(activeCaptures.keys()), ...Array.from(activeTcpdump.keys())];
}

// UI-facing interface names of all active captures (OS interface names, not the
// internal pcap device names). cap captures expose their stored label; tcpdump
// captures are already keyed by the OS interface name.
function getActiveCaptureLabels() {
  const labels = [];
  for (const [, entry] of activeCaptures) if (entry.label) labels.push(entry.label);
  for (const [iface] of activeTcpdump)    labels.push(iface);
  return labels;
}

// ── Persistent send handles ────────────────────────────────────────────────────
// Reuse one Cap handle per device across send calls.
// Rapid new Cap() → open() → close() cycles cause use-after-free in libuv's
// uv_poll_stop() path inside cap.node, leading to SIGSEGV.

const _sendHandles  = new Map(); // dev → { cap, buf, osName }
const _sendInFlight = new Set(); // devs currently transmitting

function _getSendHandle(dev, osName) {
  if (_sendHandles.has(dev)) return _sendHandles.get(dev);
  const c   = new Cap();
  const buf = Buffer.alloc(65535);
  c.open(dev, '', 0, buf);
  const h = { cap: c, buf, osName: osName || null };
  _sendHandles.set(dev, h);
  _startIfaceMonitor(); // ensure monitor is running whenever we hold a live handle
  return h;
}

function _dropSendHandle(dev) {
  const h = _sendHandles.get(dev);
  if (!h) return;
  try { h.cap.close(); } catch {}
  _sendHandles.delete(dev);
}

// ── Send ───────────────────────────────────────────────────────────────────────

// True when the built frame differs per packet (only a 'random' payload does now
// that the "_<seq>" suffix is gone). When false, a burst can reuse one frame.
function _payloadVaries(profile) {
  const pl = profile.payload;
  if (pl && String(pl.mode || '').toLowerCase() === 'random') return true;
  if (Array.isArray(profile.blocks))
    return profile.blocks.some(b => b && b.type === 'Payload' && String(b.mode || '').toLowerCase() === 'random');
  return false;
}

async function sendPackets(profile) {
  if (!Cap) throw new Error('cap npm not installed (run: npm install cap)');

  const dev = resolveDevice(profile.interface);
  if (!dev) throw new Error(`Interface not found: ${profile.interface}`);

  if (_sendInFlight.has(dev))
    throw new Error(`Send already in progress on interface ${dev}`);

  const count      = profile.count      ?? 1;
  const intervalMs = profile.intervalMs ?? 0;

  // Auto-fill srcMac with the real NIC MAC when left empty or all-zero.
  // Covers both the flat profile and the visual block builder (blocks[].srcMac),
  // and finds the MAC even on IP-less L2-only NICs (Linux sysfs fallback).
  profile = _autofillSrcMac(profile);

  // UI-facing interface label (OS name) — may differ from the pcap device name.
  const label = profile.interface || dev;

  // Optional Windows high-rate burst via the Npcap send-queue addon
  // (engine:"sendqueue"): build the frame once and blast `count` copies with one
  // driver call per chunk. ~4-5x faster than per-packet cap.send. Only for a fixed
  // frame (no 'random' payload). NOTE: synchronous — blocks until the burst ends.
  if (_sq && profile.engine === 'sendqueue' && !_payloadVaries(profile)) {
    const frame = buildFrame(profile, 0);
    if (frame.length > 65535) throw new Error(`Frame too large: ${frame.length} bytes`);
    _sendInFlight.add(dev);
    try {
      _registerTxEcho(dev, frame);
      const chunk = Math.max(1, Math.min(profile.chunk || 4000, 60000));
      const r = _sq.transmit(dev, frame, count, chunk, profile.sync ? 1 : 0);
      if (!r || !r.ok) throw new Error('send-queue transmit failed: ' + ((r && r.error) || 'unknown'));
      _recordTxFrame(dev, label, frame); // single representative TX row
      return { framesSent: r.frames, bytesSent: r.bytes, engine: 'sendqueue' };
    } catch (err) {
      throw err;
    } finally {
      _sendInFlight.delete(dev);
    }
  }

  // High-throughput path: for large bursts, build the frame ONCE and reuse it,
  // and skip per-packet capture bookkeeping (decode + sorted insert) which
  // otherwise dominates CPU and grows the capture buffer to millions of rows.
  // Small/functional sends keep the per-packet path so IP id / seq still vary.
  const BULK    = count > 1000;
  const varies  = _payloadVaries(profile);           // only 'random' payload varies
  const fixedFrame = (BULK && !varies) ? buildFrame(profile, 0) : null;
  if (fixedFrame && fixedFrame.length > 65535) throw new Error(`Frame too large: ${fixedFrame.length} bytes`);

  _sendInFlight.add(dev);
  try {
    const handle = _getSendHandle(dev, profile.interface);
    let sent = 0, bytes = 0;
    if (BULK && fixedFrame) _registerTxEcho(dev, fixedFrame); // suppress at least one echo
    for (let i = 0; i < count; i++) {
      const frame = fixedFrame || buildFrame(profile, i);
      if (!fixedFrame && frame.length > 65535) throw new Error(`Frame too large: ${frame.length} bytes`);
      // Register the TX-echo dedup key BEFORE injecting (per-packet for small sends).
      if (!BULK) _registerTxEcho(dev, frame);
      handle.cap.send(frame, frame.length);
      sent++;
      bytes += frame.length;
      // Record each TX frame for small sends; bulk sends get one summary row below.
      if (!BULK) _recordTxFrame(dev, label, frame);
      if (intervalMs > 0 && i < count - 1)
        await new Promise(r => setTimeout(r, intervalMs));
    }
    if (BULK && fixedFrame) _recordTxFrame(dev, label, fixedFrame); // single representative TX row
    return { framesSent: sent, bytesSent: bytes };
  } catch (err) {
    _dropSendHandle(dev); // discard broken handle; next call will recreate
    throw err;
  } finally {
    _sendInFlight.delete(dev);
  }
}

function isAvailable()        { return !!Cap; }
function isTcpdumpAvailable() { return hasTcpdump(); }

// Send a raw hex frame (used by nativeWorker sendhex command)
async function sendRaw(ifaceName, hex, count = 1) {
  if (!Cap) throw new Error('cap npm not installed — packet send requires: sudo apt install libpcap-dev build-essential && npm install cap');
  const dev = resolveDevice(ifaceName);
  if (!dev) throw new Error(`Interface not found: ${ifaceName}`);

  if (_sendInFlight.has(dev))
    throw new Error(`Send already in progress on interface ${dev}`);

  const frame = Buffer.from((hex || '').replace(/[\s:]/g, ''), 'hex');
  if (frame.length === 0) throw new Error('Empty frame');
  if (frame.length > 65535) throw new Error(`Frame too large: ${frame.length} bytes`);

  const label = ifaceName || dev;

  _sendInFlight.add(dev);
  try {
    const handle = _getSendHandle(dev, ifaceName);
    let sent = 0;
    for (let i = 0; i < count; i++) {
      _registerTxEcho(dev, frame);   // register dedup key before send (race-free)
      handle.cap.send(frame, frame.length);
      _recordTxFrame(dev, label, frame);
      sent++;
    }
    return { framesSent: sent, bytesSent: sent * frame.length };
  } catch (err) {
    _dropSendHandle(dev);
    throw err;
  } finally {
    _sendInFlight.delete(dev);
  }
}

// ── Frame decoder ──────────────────────────────────────────────────────────────

function macStr(buf, off) {
  return Array.from(buf.slice(off, off + 6)).map(b => b.toString(16).padStart(2, '0')).join(':');
}

function decodeFrame(buf) {
  const result = { length: buf.length };
  if (buf.length < 14) return result;

  const dstMac    = macStr(buf, 0);
  const srcMac    = macStr(buf, 6);
  let   etherType = buf.readUInt16BE(12);
  let   offset    = 14;

  result.ethernet = { dstMac, srcMac, etherType: '0x' + etherType.toString(16).padStart(4, '0') };

  if (etherType === 0x8100 && buf.length >= 18) {
    const tci = buf.readUInt16BE(14);
    result.ethernet.vlan = { priority: (tci >> 13) & 7, dei: !!(tci & 0x1000), id: tci & 0xFFF };
    etherType = buf.readUInt16BE(16);
    result.ethernet.etherType = '0x' + etherType.toString(16).padStart(4, '0');
    offset = 18;
  }

  if (etherType === 0x0800 && buf.length >= offset + 20) {
    const ihl   = (buf[offset] & 0x0F) * 4;
    const proto = buf[offset + 9];
    const src   = Array.from(buf.slice(offset + 12, offset + 16)).join('.');
    const dst   = Array.from(buf.slice(offset + 16, offset + 20)).join('.');
    result.ipv4 = { src, dst, ttl: buf[offset + 8], protocol: proto, totalLength: buf.readUInt16BE(offset + 2) };

    const l4 = offset + ihl;
    if (proto === 17 && buf.length >= l4 + 8) {
      result.udp = { srcPort: buf.readUInt16BE(l4), dstPort: buf.readUInt16BE(l4 + 2), length: buf.readUInt16BE(l4 + 4) };
      if (buf.length > l4 + 8) {
        const p = buf.slice(l4 + 8);
        result.payload = { hex: p.toString('hex'), text: p.toString('utf8').replace(/[^\x20-\x7E]/g, '.') };
      }
    } else if (proto === 6 && buf.length >= l4 + 20) {
      result.tcp = { srcPort: buf.readUInt16BE(l4), dstPort: buf.readUInt16BE(l4 + 2), flags: buf[l4 + 13] };
    } else if (proto === 1 && buf.length >= l4 + 4) {
      result.icmp = { type: buf[l4], code: buf[l4 + 1] };
    }
  } else if (etherType === 0x0806 && buf.length >= offset + 28) {
    result.arp = {
      op:        buf.readUInt16BE(offset + 6) === 1 ? 'request' : 'reply',
      senderMac: macStr(buf, offset + 8),
      senderIp:  Array.from(buf.slice(offset + 14, offset + 18)).join('.'),
      targetMac: macStr(buf, offset + 18),
      targetIp:  Array.from(buf.slice(offset + 24, offset + 28)).join('.'),
    };
  }
  return result;
}

// ── Capture buffer ─────────────────────────────────────────────────────────────

let captureSeq  = 0;
let captureRows = [];
let captureStreamCbs = [];

// ── BPF filter helpers ─────────────────────────────────────────────────────────

function getIfaceMac(ifaceName) {
  if (!ifaceName) return null;
  const want = ifaceName.toLowerCase();
  for (const [name, entries] of Object.entries(os.networkInterfaces() || {})) {
    if (name.toLowerCase() === want) {
      const e = (entries || []).find(e => e.mac && !_isZeroMac(e.mac));
      return e?.mac?.toLowerCase() || null;
    }
  }
  return null;
}

/** True when a MAC is missing or all-zero (00:00:00:00:00:00). */
function _isZeroMac(mac) {
  if (!mac) return true;
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 0 || /^0+$/.test(hex);
}

/**
 * Resolve the real hardware MAC of an OS interface.
 *  1) os.networkInterfaces() (works when the NIC has any IPv4/IPv6 address)
 *  2) Linux sysfs /sys/class/net/<iface>/address — covers IP-less L2-only NICs
 *     that Node.js omits from os.networkInterfaces().
 * Returns lowercase "aa:bb:cc:dd:ee:ff" or null.
 */
function _resolveNicMac(ifaceName) {
  const fromNode = getIfaceMac(ifaceName);
  if (fromNode) return fromNode;
  if (!ifaceName || process.platform !== 'linux') return null;
  // sysfs fallback (basename only — never traverse paths)
  const safe = String(ifaceName).replace(/[^A-Za-z0-9._:@-]/g, '');
  if (!safe) return null;
  try {
    const mac = fs.readFileSync(`/sys/class/net/${safe}/address`, 'utf8').trim().toLowerCase();
    return (mac && !_isZeroMac(mac)) ? mac : null;
  } catch { return null; }
}

/**
 * Fill the source MAC with the real NIC MAC wherever the caller left it empty
 * or all-zero. Handles both the flat profile (profile.srcMac / profile.arp)
 * and the ordered visual-builder representation (profile.blocks[]). Returns a
 * shallow clone so the caller's request object is not mutated.
 */
function _autofillSrcMac(profile) {
  const nicMac = _resolveNicMac(profile.interface);
  if (!nicMac) return profile;

  const p = { ...profile };
  if (_isZeroMac(p.srcMac)) p.srcMac = nicMac;
  if (p.arp && _isZeroMac(p.arp.senderMac)) p.arp = { ...p.arp, senderMac: nicMac };

  if (Array.isArray(p.blocks) && p.blocks.length) {
    p.blocks = p.blocks.map(b => {
      if (b && b.type === 'Ethernet' && _isZeroMac(b.srcMac)) return { ...b, srcMac: nicMac };
      if (b && b.type === 'ARP'      && _isZeroMac(b.senderMac)) return { ...b, senderMac: nicMac };
      return b;
    });
  }
  return p;
}

/**
 * Build a BPF filter that accepts only frames addressed to the given interfaces
 * (or broadcast/multicast). Prevents promiscuous-mode noise from appearing.
 *   e.g. "(ether dst a0:36:9f:a8:da:61 or broadcast or multicast)"
 */
function buildIfaceBpfFilter(ifaceNames) {
  if (!ifaceNames || !ifaceNames.length) return '';
  // Use _resolveNicMac (not getIfaceMac) so IP-less L2-only NICs — resolved via
  // Linux sysfs — still get a dst-MAC filter instead of silently capturing all.
  const macs = ifaceNames.map(_resolveNicMac).filter(Boolean);
  if (!macs.length) return '';
  const dstClauses = macs.map(m => `ether dst ${m}`);
  return `(${[...dstClauses, 'broadcast', 'multicast'].join(' or ')})`;
}

function clearCapture() { captureSeq = 0; captureRows = []; _recentTxHexes.clear(); }

// Dedup set: TX frames registered here are suppressed once if libpcap also captures them
const _recentTxHexes = new Map(); // key: dev+hex → expiry timestamp

// Register a TX frame for echo-dedup (keyed by capture device + frame bytes).
// Suppresses one libpcap/tcpdump echo of our own injected frame within 300ms.
function _registerTxEcho(dev, frame) {
  _recentTxHexes.set(dev + frame.toString('hex'), Date.now() + 300);
}

// Add a TX frame to the capture buffer. `dev` is the internal pcap device used
// for the dedup key; `label` is the UI-facing interface name shown in the row.
function _recordTxFrame(dev, label, frame) {
  const hexStr  = frame.toString('hex');
  _registerTxEcho(dev, frame); // keep dedup window fresh (idempotent)
  const no      = ++captureSeq;
  const ts      = Date.now() / 1000;
  const decoded = decodeFrame(frame);
  const record  = { no, timestamp: ts, interface: label || dev, length: frame.length, frameHex: hexStr, decoded, direction: 'TX' };
  insertCaptureSorted(record);
  for (const cb of captureStreamCbs) { try { cb(record); } catch {} }
}

// Insert record in timestamp order (handles out-of-order delivery from concurrent tcpdump processes)
function insertCaptureSorted(record) {
  const ts = record.timestamp;
  // Fast path: most packets arrive in order
  if (!captureRows.length || ts >= captureRows[captureRows.length - 1].timestamp) {
    captureRows.push(record);
    return;
  }
  // Binary search for insertion point
  let lo = 0, hi = captureRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (captureRows[mid].timestamp <= ts) lo = mid + 1;
    else hi = mid;
  }
  captureRows.splice(lo, 0, record);
}

function getCaptures(limit = 1000, offset = 0) {
  const slice = captureRows.slice(offset, offset + limit);
  return { rows: slice, total: captureRows.length };
}

function getCaptureStatus(ifaceNames) {
  return {
    // Reflect BOTH backends — tcpdump-fallback captures must report "capturing"
    // too, otherwise the UI shows "idle" while packets are streaming in.
    capturing:          activeCaptures.size > 0 || activeTcpdump.size > 0,
    captureCount:       captureRows.length,
    captureInterfaces:  ifaceNames ?? getActiveCaptureLabels(),
  };
}

// ── Interface list ─────────────────────────────────────────────────────────────

// Determine link/admin state. On Linux an L2-only NIC (no IP) is commonly UP, so
// prefer sysfs operstate/flags over "has an IPv4 address"; fall back to IP heuristic.
function _ifaceState(name, hasIpv4) {
  if (process.platform === 'linux') {
    const safe = String(name).replace(/[^A-Za-z0-9._:@-]/g, '');
    try {
      const op = fs.readFileSync(`/sys/class/net/${safe}/operstate`, 'utf8').trim();
      if (op === 'up')   return 'up';
      if (op === 'down') return 'down';
      // 'unknown' (typical for many L2 setups) → consult IFF_UP in flags
      const flags = parseInt(fs.readFileSync(`/sys/class/net/${safe}/flags`, 'utf8').trim(), 16);
      if (!Number.isNaN(flags)) return (flags & 0x1) ? 'up' : 'down'; // IFF_UP
    } catch { /* not on linux or sysfs unavailable */ }
  }
  return hasIpv4 ? 'up' : 'down';
}

function listInterfaces() {
  const nics   = os.networkInterfaces();
  const result = [];
  const seen   = new Set();

  for (const [name, entries] of Object.entries(nics || {})) {
    const ipv4 = (entries || [])
      .filter(e => e.family === 'IPv4')
      .map(e => ({ local: e.address, prefixlen: prefixFromMask(e.netmask) }));

    // Use the real hardware MAC even when there's no IPv4 (L2-only NIC).
    const mac = (entries || []).find(e => e.mac && !_isZeroMac(e.mac))?.mac
                ?? _resolveNicMac(name) ?? '';
    result.push({ name, key: name, mac, state: _ifaceState(name, ipv4.length > 0), mtu: 1500, ipv4, description: name });
    seen.add(name);
  }

  // Linux: include L2-only NICs that exist in sysfs but have no address, so
  // os.networkInterfaces() omits them (common for switch-test NICs used IP-less).
  if (process.platform === 'linux') {
    try {
      for (const name of fs.readdirSync('/sys/class/net')) {
        if (seen.has(name) || name === 'lo') continue;
        result.push({ name, key: name, mac: _resolveNicMac(name) ?? '', state: _ifaceState(name, false), mtu: 1500, ipv4: [], description: name });
        seen.add(name);
      }
    } catch { /* sysfs unavailable */ }
  }
  return result;
}

function prefixFromMask(mask) {
  if (!mask) return 0;
  return mask.split('.').reduce((a, b) => a + (parseInt(b, 10) >>> 0).toString(2).split('1').length - 1, 0);
}

function addStreamCallback(cb)    { captureStreamCbs.push(cb); }
function removeStreamCallback(cb) { captureStreamCbs = captureStreamCbs.filter(x => x !== cb); }

// Close all Cap handles before the process exits so libuv can cleanly unregister
// poll handles — prevents the 'status == 0' assertion in cap's cb_packets.
['exit', 'SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    try { _closeAllCapHandles(); } catch {}
    if (sig !== 'exit') process.exit(0);
  });
});

module.exports = {
  sendPackets, sendRaw, startCapture, stopCapture, isCapturing,
  getCaptureDeviceNames, clearCapture, getCaptures, getCaptureStatus,
  addStreamCallback, removeStreamCallback,
  listInterfaces, resolveDevice, isAvailable, isTcpdumpAvailable, decodeFrame,
  getLastCaptureError, buildIfaceBpfFilter, isFastSendAvailable,
};
