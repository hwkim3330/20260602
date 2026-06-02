'use strict';
/**
 * autoEngine.js — Node.js automation test runner.
 * Used as fallback when C# worker is not connected (Linux / headless).
 * Test cases are loaded from logs/tests/test-cases.json (same file as testcases.js).
 */
const path = require('path');
const fs   = require('fs');

let _state = {
  running:    false,
  test:       null,
  startedAt:  null,
  statusText: 'Idle',
  result:     null,
  rows:       [],
};

let _services  = null;
let _testsDir  = null;
let _stopFlag  = false;

const PORTMAP_FILE = path.join(__dirname, '../logs/portmap.json');
const DEFAULT_PORTMAP = [
  { port: 0, iface: 'enp12s0f0' }, { port: 1, iface: 'enp12s0f1' },
  { port: 2, iface: 'enp12s0f2' }, { port: 3, iface: 'enp12s0f3' },
];

function _loadPortmap() {
  try {
    if (fs.existsSync(PORTMAP_FILE)) return JSON.parse(fs.readFileSync(PORTMAP_FILE, 'utf8'));
  } catch {}
  return DEFAULT_PORTMAP;
}

function _parseBin(s) {
  const t = String(s || '0').trim();
  if (t.startsWith('0b') || t.startsWith('0B')) return parseInt(t.slice(2), 2) || 0;
  return parseInt(t) || 0;
}

function init(services, testsDir) {
  _services = services;
  _testsDir = testsDir;
}

function _getStepType(step) {
  const raw = step.EventType || step.eventType || step.type || '';
  return (raw || inferStepType(step)).toLowerCase().replace(/\s+/g, '');
}

async function runTest(testName) {
  if (_state.running) throw new Error('Already running');
  if (!_services)     throw new Error('autoEngine not initialized');
  _stopFlag = false;
  _state = { running: true, test: testName, startedAt: Date.now(), statusText: 'Starting…', result: null, rows: [] };

  try {
    const file = path.join(_testsDir, 'test-cases.json');
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const tc   = list.find(t => t.name === testName || t.id === testName);
    if (!tc) throw new Error(`Test not found: ${testName}`);

    const steps = Array.isArray(tc.steps) ? tc.steps : [];
    let passed = 0;
    let failed = 0;
    let nextCapturePrestarted = false;

    for (let i = 0; i < steps.length; i++) {
      if (_stopFlag) { _state.statusText = 'Stopped'; break; }
      const step = steps[i];
      const capturePrestarted = nextCapturePrestarted;
      nextCapturePrestarted = false;

      _state.statusText = `[${i + 1}/${steps.length}] ${step.name || step.eventType || step.type || 'step'}`;

      // Look-ahead: if this packet step is followed by rxverify, pre-start capture NOW
      // so the sent frame is already in the buffer when rxverify polls.
      const type = _getStepType(step);
      if (['packet', 'sendpacket', 'send'].includes(type) && i + 1 < steps.length) {
        const nextType = _getStepType(steps[i + 1]);
        if (nextType === 'rxverify') {
          const ns = steps[i + 1];
          const portmap = _loadPortmap();
          const bitmap  = _parseBin(ns.Expected || ns.expected || '0');
          const nsIfaces = [];
          for (let k = 0; k < 8; k++) {
            if (bitmap & (1 << k)) {
              const e = portmap.find(p => Number(p.port) === k);
              if (e?.iface) nsIfaces.push(e.iface);
            }
          }
          if (nsIfaces.length) {
            _services.packetBackend.clearCapture();
            _services.packetBackend.startCapture(nsIfaces, '', () => {}, () => {});
            nextCapturePrestarted = true;
            console.log(`[autoEngine] step ${i+1}: pre-started capture on [${nsIfaces.join(', ')}] for rxverify`);
          }
        }
      }

      let row;
      try {
        const raw  = step.EventType || step.eventType || step.type || '';
        const stype = (raw || inferStepType(step)).toLowerCase().replace(/\s+/g, '');
        console.log(`[autoEngine] step ${i+1}: name="${step.Name||step.name}" EventType="${step.EventType||step.eventType||''}" → type="${stype}" addr="${step.Address||step.address||''}" value="${step.Value||step.value||''}"`);
        const r = await runStep(step, { capturePrestarted });
        console.log(`[autoEngine] step ${i+1} result: ${r.pass?'PASS':'FAIL'} — ${r.detail||''}`);
        row = { step: i + 1, name: step.Name || step.name || step.eventType || step.type, result: r.pass ? 'PASS' : 'FAIL', detail: r.detail };
        if (r.pass) passed++; else failed++;
      } catch (e) {
        console.error(`[autoEngine] step ${i+1} exception:`, e.message);
        row = { step: i + 1, name: step.Name || step.name || step.type, result: 'FAIL', detail: e.message };
        failed++;
      }
      _state.rows.push(row);
    }

    _state.result     = failed === 0 ? 'PASS' : 'FAIL';
    _state.statusText = `Done — ${passed} passed, ${failed} failed`;
  } catch (e) {
    _state.result     = 'FAIL';
    _state.statusText = `Error: ${e.message}`;
    _state.rows.push({ step: -1, name: 'error', result: 'FAIL', detail: e.message });
  } finally {
    // Ensure no capture handle is left running — a look-ahead pre-start followed
    // by a stop (or an exception) before the rxverify step would otherwise leak it.
    try { _services?.packetBackend?.stopCapture(); } catch {}
    _state.running = false;
  }
}

function inferStepType(step) {
  const addr     = (step.Address  || step.address  || step.offset  || '').toString().trim();
  const value    = (step.Value    || step.value    || '').toString().trim();
  const mask     = (step.Mask     || step.mask     || '').toString().trim();
  const expected = (step.Expected || step.expected || '').toString().trim();
  const mac      = (step.MAC      || step.mac      || '').toString().trim();
  const frameRef = (step.FrameRef || step.frameRef || step.frameref || '').toString().trim();
  const name     = (step.Name     || step.name     || '').toString().toLowerCase();
  const timeout  = (step.Timeout  || step.timeout  || '').toString().trim();
  const delayMs  = (step.delayMs  || '').toString().trim();

  if (frameRef && frameRef !== '-') return 'sendpacket';
  if (name.includes('flush')) return 'fdbflush';
  if (mac && mac !== '-') return 'fdbread';
  if (addr && addr !== '-') {
    if (expected && expected !== '-') return 'registerexpect';
    if (value && value !== '-') return 'registerwrite';
    return 'registerread';
  }
  if (delayMs && delayMs !== '-') return 'delay';
  if (timeout && timeout !== '-') return 'delay';
  return 'delay';
}

async function runStep(step, ctx = {}) {
  const raw  = step.EventType || step.eventType || step.type || '';
  const type = (raw || inferStepType(step)).toLowerCase().replace(/\s+/g, '');
  const { packetBackend, switchProtocol } = _services;

  switch (type) {

    case 'delay': {
      // CSV 'Timeout' 컬럼(예: "100ms") 또는 delayMs 필드 사용
      const rawMs = step.delayMs ?? step.DelayMs ?? step.Timeout ?? step.timeout ?? 100;
      const ms = typeof rawMs === 'string' ? (parseInt(rawMs) || 100) : (rawMs || 100);
      await delay(ms);
      return { pass: true, detail: `${ms}ms` };
    }

    case 'registerwrite': {
      const addr = step.Address ?? step.address ?? step.offset ?? '0';
      const val  = step.Value   ?? step.value   ?? '0';
      await switchProtocol.registerWrite({ offset: addr, value: val });
      return { pass: true, detail: `write ${val} → ${addr}` };
    }

    case 'registerread': {
      const addr = step.Address ?? step.address ?? step.offset ?? '0';
      const r = await switchProtocol.registerRead({ offset: addr });
      return { pass: true, detail: `read → ${r.value}` };
    }

    case 'registerwait':
    case 'registerexpect': {
      const addr     = step.Address  ?? step.address  ?? step.offset  ?? '0';
      const maskStr  = step.Mask     ?? step.mask     ?? '0xFFFFFFFF';
      const expStr   = step.Expected ?? step.expected ?? '0x00000000';
      const rawTo    = step.Timeout  ?? step.timeout  ?? step.timeoutMs ?? 1000;
      const timeout  = typeof rawTo === 'string' ? (parseInt(rawTo) || 1000) : (rawTo || 1000);
      const mask     = parseHex(maskStr);
      const expected = parseHex(expStr);
      const deadline = Date.now() + timeout;
      let last = 0;
      while (true) {
        const r = await switchProtocol.registerRead({ offset: addr });
        last = r.raw ?? parseHex(r.value);
        if ((last & mask) === (expected & mask))
          return { pass: true, detail: `got 0x${last.toString(16)}` };
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await delay(Math.min(50, remaining));
      }
      return { pass: false, detail: `timeout: last=0x${last.toString(16)}, expected=0x${expected.toString(16)}&mask` };
    }

    // ── FdbInitialize / FdbFlush ────────────────────────────────────────────────
    case 'fdbinitialize':
    case 'fdbflush': {
      await switchProtocol.fdbFlush({});
      return { pass: true, detail: 'FDB flushed' };
    }

    // ── FdbWrite (Port='0b000001' 이진수 파싱) ──────────────────────────────────
    case 'fdbwrite': {
      const mac    = step.MAC || step.mac || '';
      const vlanId = parseInt(step.VlanID || step.VlanId || step.vlanid || '0') || 0;
      const vlanValidRaw = String(step.VlanValid || step.vlanValid || step.vlanvalid || '').toLowerCase().trim();
      const vlanValid = vlanValidRaw === '1' || vlanValidRaw === 'y' || vlanValidRaw === 'yes' || vlanValidRaw === 'true';
      const portRaw = String(step.Port || step.port || '0').trim();
      const port   = (portRaw.startsWith('0b') || portRaw.startsWith('0B'))
        ? parseInt(portRaw.slice(2), 2) || 0
        : parseInt(portRaw) || 0;
      if (!mac || mac === '-') return { pass: false, detail: 'No MAC' };
      await switchProtocol.fdbWrite({ mac, vlanId, vlanValid, port });
      const waitMs = parseInt(step.Waiting || step.waiting || '0') || 0;
      if (waitMs > 0) await delay(waitMs);
      return { pass: true, detail: `FdbWrite mac=${mac} port=${port}` };
    }

    // ── FdbRead ─────────────────────────────────────────────────────────────────
    case 'fdbread': {
      const mac    = step.MAC || step.mac || '';
      const vlanId = parseInt(step.VlanID || step.VlanId || step.vlanid || '0') || 0;
      const vlanValidRaw = String(step.VlanValid || step.vlanValid || step.vlanvalid || '').toLowerCase().trim();
      const vlanValid = vlanValidRaw === '1' || vlanValidRaw === 'y' || vlanValidRaw === 'yes' || vlanValidRaw === 'true';
      if (!mac || mac === '-') return { pass: false, detail: 'No MAC' };
      const entry = await switchProtocol.fdbRead({ mac, vlanId, vlanValid });
      const detail = entry.found
        ? `found mac=${entry.mac} port=${entry.port} bucket=${entry.bucket}`
        : `not found: ${mac}`;
      return { pass: true, detail };
    }

    // ── FdbVerify ──────────────────────────────────────────────────────────────────
    case 'fdbverify': {
      const mac    = step.MAC || step.mac || '';
      const vlanId = parseInt(step.VlanID || step.VlanId || step.vlanid || '0') || 0;
      const vlanValidRaw = String(step.VlanValid || step.vlanValid || step.vlanvalid || '').toLowerCase().trim();
      const vlanValid = ['1','y','yes','true'].includes(vlanValidRaw);
      const portRaw        = String(step.ExpectedPort || step.expectedPort || '0').trim();
      const expectedPort   = (portRaw.startsWith('0b') || portRaw.startsWith('0B'))
        ? parseInt(portRaw.slice(2), 2) || 0
        : parseInt(portRaw) || 0;
      const rawAbsent      = String(step.ExpectedAbsent || step.expectedAbsent || '').toLowerCase().trim();
      const expectedAbsent = ['1','y','yes','true'].includes(rawAbsent);
      if (!mac || mac === '-') return { pass: false, detail: 'No MAC' };
      const entry = await switchProtocol.fdbRead({ mac, vlanId, vlanValid });
      if (expectedAbsent) {
        return entry.found
          ? { pass: false, detail: `Expected absent but MAC found (port=${entry.port})` }
          : { pass: true,  detail: `absent confirmed` };
      }
      if (!entry.found) return { pass: false, detail: `MAC not found: ${mac}` };
      const portMatch = (entry.port & 0x1FF) === (expectedPort & 0x1FF);
      return portMatch
        ? { pass: true,  detail: `port=${entry.port} (expected ${expectedPort})` }
        : { pass: false, detail: `Port mismatch: got ${entry.port}, expected ${expectedPort}` };
    }

    // ── FdbReadBucket (Bucket, Slot, Expected=MAC) ──────────────────────────────
    case 'fdbreadbucket': {
      const bucket   = parseInt(step.Bucket || step.bucket || '0') || 0;
      const slotMask = parseHex(step.Slot || step.slot || '0x1') || 1;
      const expected = (step.Expected || step.expected || '').trim();
      try {
        const entry = await switchProtocol.fdbReadBucket({ bucket, slot: slotMask });
        if (expected && expected !== '-') {
          const match = (entry.mac || '').toUpperCase() === expected.toUpperCase();
          return match
            ? { pass: true,  detail: `bucket=${bucket} slot=0x${slotMask.toString(16)} mac=${entry.mac}` }
            : { pass: false, detail: `MAC mismatch: got ${entry.mac}, expected ${expected}` };
        }
        return { pass: true, detail: `bucket=${bucket} mac=${entry.mac}` };
      } catch (e) {
        return { pass: false, detail: `FdbReadBucket error: ${e.message}` };
      }
    }

    // ── Packet send ─────────────────────────────────────────────────────────────
    case 'send':
    case 'sendpacket':
    case 'packet': {
      const profile = step.profile || step;
      try {
        const result = await packetBackend.sendPackets(require('./frameBuilder').normalizeProfile(profile));
        return { pass: true, detail: `${result.framesSent ?? 1} frames sent` };
      } catch (e) {
        return { pass: false, detail: `Send failed: ${e.message}` };
      }
    }

    // ── RxVerify — 포트 비트맵 기반 수신 검증 ─────────────────────────────────
    case 'rxverify': {
      const expectedBitmap = _parseBin(step.Expected || step.expected || '0');
      const rawTo     = step.Timeout ?? step.timeout ?? step.timeoutMs ?? '1000ms';
      const timeoutMs = (typeof rawTo === 'string' ? parseInt(rawTo) : rawTo) || 1000;

      const portmap = _loadPortmap();
      const expectedPorts = [];
      for (let i = 0; i < 8; i++) { if (expectedBitmap & (1 << i)) expectedPorts.push(i); }

      // expected=0b000000이면 모든 로컬 포트 캡처 후 "수신 없음" 검증
      const ifaces = expectedPorts.length
        ? expectedPorts.map(p => portmap.find(e => Number(e.port) === p)?.iface).filter(Boolean)
        : portmap.filter(e => !e.nodeUrl).map(e => e.iface).filter(Boolean);
      if (!ifaces.length) {
        return { pass: false, detail: `RxVerify: portmap에 0b${expectedBitmap.toString(2)} 해당 포트 없음` };
      }

      if (!ctx.capturePrestarted) {
        packetBackend.clearCapture();
        packetBackend.startCapture(ifaces, '', () => {}, () => {});
      }

      const deadline = Date.now() + timeoutMs;
      const receivedPorts = new Set();
      while (Date.now() < deadline) {
        await delay(200);
        const { rows } = packetBackend.getCaptures(10000, 0);
        for (const pkt of rows) {
          if (pkt.direction === 'TX') continue;
          const entry = portmap.find(e => e.iface === pkt.interface);
          if (entry !== undefined) receivedPorts.add(Number(entry.port));
        }
        // Early-exit only when ports are actually expected; for the "expect no
        // reception" case (expectedPorts empty) `[].every` is vacuously true and
        // would break after the first 200ms poll — keep watching the full window.
        if (expectedPorts.length && expectedPorts.every(p => receivedPorts.has(p))) break;
      }
      packetBackend.stopCapture();

      const gotBitmap   = [...receivedPorts].reduce((acc, p) => acc | (1 << p), 0);
      const rawStr  = String(step.Expected || step.expected || '0');
      const origLen = rawStr.startsWith('0b') || rawStr.startsWith('0B')
        ? rawStr.length - 2 : Math.max(expectedBitmap.toString(2).length, gotBitmap.toString(2).length);
      const padLen  = Math.max(origLen, gotBitmap.toString(2).length);
      const allReceived = gotBitmap === expectedBitmap;
      return allReceived
        ? { pass: true,  detail: `received 0b${gotBitmap.toString(2).padStart(padLen, '0')}` }
        : { pass: false, detail: `expected 0b${expectedBitmap.toString(2).padStart(padLen,'0')}, got 0b${gotBitmap.toString(2).padStart(padLen,'0')} in ${timeoutMs}ms` };
    }

    case 'capture':
    case 'startcapture':
      packetBackend.clearCapture();
      packetBackend.startCapture(
        step.interfaces ?? (step.captureInterface ? [step.captureInterface] : []),
        step.captureFilter ?? '',
        () => {}, () => {}
      );
      return { pass: true, detail: 'capture started' };

    case 'stopcapture':
      packetBackend.stopCapture();
      return { pass: true, detail: 'capture stopped' };

    case 'checkcapture': {
      const { rows } = packetBackend.getCaptures(10000, 0);
      const filter  = step.captureFilter ?? '';
      const matched = filter
        ? rows.filter(r => r.frameHex.includes(filter) || JSON.stringify(r.decoded).includes(filter))
        : rows;
      const expected = step.captureExpected ?? 1;
      const pass = matched.length >= expected;
      return { pass, detail: `${matched.length}/${expected} frames matched` };
    }

    default:
      return { pass: true, detail: `${type} skipped (native mode)` };
  }
}

function stopTest() {
  _stopFlag = true;
  _state.running    = false;
  _state.statusText = 'Stopped';
  _state.result     = _state.result ?? 'STOPPED';
}

function getStatus()  {
  return { running: _state.running, result: _state.result ?? null, statusText: _state.statusText };
}

function getResults() { return _state.rows.slice(); }

function parseHex(s) { return parseInt(String(s ?? '0').replace(/^0x/i, ''), 16) || 0; }
function delay(ms)   { return new Promise(r => setTimeout(r, ms)); }

module.exports = { init, runTest, stopTest, getStatus, getResults };
