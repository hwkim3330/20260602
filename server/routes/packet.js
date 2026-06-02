'use strict';
const { Router } = require('express');
const router = Router();

function workerErr(res, err) {
  res.status(503).json({ ok: false, error: err.message });
}

// GET /api/interfaces
router.get('/interfaces', async (req, res) => {
  try {
    const interfaces = req.app.locals.packetBackend.listInterfaces();
    res.json({ ok: true, interfaces, stdout: { interfaces } });
  } catch (err) { workerErr(res, err); }
});

// POST /api/build
router.post('/build', async (req, res) => {
  try {
    // Local frame builder handles all protocols including 'ipv4', 'raw', etc.
    // _preview: true suppresses the 60-byte Ethernet minimum padding (display only)
    const { buildFrame, normalizeProfile } = require('../services/frameBuilder');
    const frame = buildFrame(normalizeProfile({ ...(req.body || {}), _preview: true }), 0);
    const data  = { frameHex: frame.toString('hex'), frameLength: frame.length };
    res.json({ ok: true, ...data, stdout: data });
  } catch (err) { workerErr(res, err); }
});

// GET /api/packet/engines — report available send/capture engines so the UI can
// expose the optional Linux fast engine only when it is actually usable.
router.get('/packet/engines', (req, res) => {
  const pb = req.app.locals.packetBackend;
  const fe = req.app.locals.fastEngine;
  const fi = fe ? fe.info() : { available: false };
  res.json({
    ok: true,
    default: 'cap',
    engines: {
      cap:     { available: pb.isAvailable(),        label: 'cap (libpcap/Npcap)', send: pb.isAvailable(), capture: pb.isAvailable() },
      tcpdump: { available: pb.isTcpdumpAvailable(),  label: 'tcpdump fallback',    send: false,            capture: pb.isTcpdumpAvailable() },
      fast:    { available: !!fi.available,           label: 'fast (txgen/rxcap, Linux)', send: !!(fe && fe.canSend()), capture: !!(fe && fe.canCapture()), note: fi.note || undefined },
    },
  });
});

// Shared send handler — honors an optional `engine` field. Default ('cap'/'auto'
// /unset) preserves the existing Basic Packet Send behavior; only an explicit
// engine:"fast" routes to the optional Linux txgen engine.
async function doSend(req, res) {
  const body   = req.body || {};
  const engine = (body.engine || 'cap').toLowerCase();
  try {
    if (engine === 'fast') {
      const fe = req.app.locals.fastEngine;
      if (!fe || !fe.canSend())
        return res.status(503).json({ ok: false, error: (fe && fe.info().note) || 'fast engine (txgen) not available — falling back requires engine:"cap"' });
      const result = await fe.sendFast(body);
      return res.json({ ok: true, ...result, stdout: result });
    }
    const result = await req.app.locals.packetBackend.sendPackets(body);
    res.json({ ok: true, ...result, stdout: result });
  } catch (err) { workerErr(res, err); }
}

// POST /api/send
router.post('/send', doSend);
// POST /api/packet/send (alias)
router.post('/packet/send', doSend);

// POST /api/probe-node
router.post('/probe-node', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    const base = url.replace(/\/$/, '');
    const resp = await fetch(`${base}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    const ifaces = (data.interfaces ?? []).map(i => ({
      key:  i.key || i.name || '',
      name: i.name || i.key || '',
      mac:  i.mac  || '',
      state: i.state || 'unknown',
      ipv4:  i.ipv4 || [],
      description: i.description || ''
    }));
    res.json({ ok: true, url: base, interfaces: ifaces });
  } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

// GET /api/arp-lookup?ip=...
router.get('/arp-lookup', async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.json({ ok: false, error: 'ip required' });
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const exec = promisify(execFile);
    const { stdout } = await exec('arp', ['-a', ip]);
    const match = stdout.match(/([0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2}[:\-][0-9a-f]{2})/i);
    if (match) {
      const mac = match[1].replace(/-/g, ':').toLowerCase();
      return res.json({ ok: true, mac, ip });
    }
    res.json({ ok: false, error: 'not in ARP table', ip });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// GET /api/worker/status
router.get('/worker/status', async (req, res) => {
  try {
    const pb = req.app.locals.packetBackend;
    const st = pb.getCaptureStatus();
    res.json({ ok: true, workerId: 'local', capturing: st.capturing, captureCount: st.captureCount,
               captureInterfaces: st.captureInterfaces });
  } catch (err) { workerErr(res, err); }
});

module.exports = router;
