'use strict';
/**
 * settings.js — small server-side settings store + network helpers.
 *
 *  GET  /api/settings                 → saved settings (logs/settings.json)
 *  POST /api/settings   {settings}     → persist settings
 *  GET  /api/net/probe?host=&ports=    → TCP-connect reachability check
 *  POST /api/switch-forward-test       → single-host, two-NIC L2 forwarding test
 *                                        through an external switch (no 2nd PC)
 */
const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const net  = require('net');
const router = Router();

const SETTINGS_FILE = path.join(__dirname, '../logs/settings.json');
const DEFAULTS = {
  switchIp:   '192.168.100.1',
  switchPorts: [22, 23, 80, 443, 161],
  nodeBUrl:   '',
  fwdIfaceA:  '',
  fwdIfaceB:  '',
};

function load() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {}
  return { ...DEFAULTS };
}

router.get('/settings', (_req, res) => res.json({ ok: true, settings: load() }));

router.post('/settings', (req, res) => {
  try {
    const incoming = (req.body && req.body.settings) || {};
    const merged = { ...load(), ...incoming };
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    res.json({ ok: true, settings: merged });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// TCP-connect probe: returns which of the requested ports accept a connection.
// Pure userspace (no root, no ICMP), so it works under the setcap/no-sudo setup.
function tcpProbe(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (open) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(open); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
    sock.connect(port, host);
  });
}

router.get('/net/probe', async (req, res) => {
  const host  = String(req.query.host || '').trim();
  if (!host) return res.status(400).json({ ok: false, error: 'host required' });
  const ports = String(req.query.ports || '22,23,80,443')
    .split(',').map(s => Number(s.trim())).filter(p => p > 0 && p < 65536);
  const results = {};
  await Promise.all(ports.map(async p => { results[p] = await tcpProbe(host, p); }));
  const reachable = Object.values(results).some(Boolean);
  res.json({ ok: true, host, reachable, ports: results });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Two-NIC forwarding test: send a uniquely-marked broadcast on ifaceA and check
// that an external switch forwards it to ifaceB (and optionally back). Validates
// send + capture + switch L2 forwarding from a single host, no second PC needed.
router.post('/switch-forward-test', async (req, res) => {
  const pb = req.app.locals.packetBackend;
  try {
    const { ifaceA, ifaceB, count = 5, intervalMs = 50, captureMs = 1500, bidirectional = true } =
      req.body || {};
    if (!ifaceA || !ifaceB) return res.status(400).json({ ok: false, error: 'ifaceA and ifaceB required' });
    if (!pb.isAvailable()) return res.status(503).json({ ok: false, error: 'native cap send not available' });

    const runOne = async (src, dst) => {
      pb.clearCapture();
      pb.startCapture([src, dst], '', () => {}, () => {});
      await sleep(400); // let capture settle
      const marker = `KETISWFWD_${src}_${Date.now()}`;
      await pb.sendPackets({
        interface: src, protocol: 'udp', dstMac: 'FF:FF:FF:FF:FF:FF',
        srcIp: '192.168.100.50', dstIp: '192.168.100.255', srcPort: 40000, dstPort: 50000,
        count, intervalMs, payload: { mode: 'text', data: marker },
      });
      await sleep(Math.min(captureMs, 8000));
      pb.stopCapture([src, dst]);
      const rows = pb.getCaptures(20000, 0).rows || [];
      const mh = Buffer.from(marker, 'utf8').toString('hex');
      const hit = (iface) => rows.filter(r => r.interface === iface &&
        ((r.frameHex || '').includes(mh) || (r.decoded && JSON.stringify(r.decoded).includes(marker)))).length;
      const onSrc = hit(src), onDst = hit(dst);
      const threshold = Math.max(1, Math.ceil(count * 0.5));
      return { from: src, to: dst, sent: count, matchedOnDst: onDst, matchedOnSrc: onSrc,
               result: onDst >= threshold ? 'PASS' : 'FAIL' };
    };

    const dirs = [await runOne(ifaceA, ifaceB)];
    if (bidirectional) dirs.push(await runOne(ifaceB, ifaceA));
    const overall = dirs.every(d => d.result === 'PASS') ? 'PASS' : 'FAIL';
    res.json({ ok: true, overall, directions: dirs, generatedAt: new Date().toISOString() });
  } catch (e) {
    try { pb.stopCapture(); } catch {}
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
