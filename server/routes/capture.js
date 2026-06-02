'use strict';
const { Router } = require('express');
const router = Router();

function workerErr(res, err) {
  res.status(503).json({ ok: false, error: err.message });
}

function buildBpfFilter({ srcMac, dstMac, etherType, bpfFilter } = {}) {
  if (bpfFilter && bpfFilter.trim()) return bpfFilter.trim();
  const parts = [];
  if (srcMac  && srcMac.trim())  parts.push(`ether src ${srcMac.trim().toLowerCase()}`);
  if (dstMac  && dstMac.trim())  parts.push(`ether dst ${dstMac.trim().toLowerCase()}`);
  if (etherType && etherType.trim()) parts.push(`ether proto ${etherType.trim()}`);
  return parts.join(' and ');
}

// GET /api/capture/status
router.get('/capture/status', async (req, res) => {
  try {
    const pb  = req.app.locals.packetBackend;
    const st  = pb.getCaptureStatus();
    const ifaces = pb.listInterfaces().map(i => ({
      name: i.name, description: i.description, state: i.state, mac: i.mac,
      selected: st.captureInterfaces.includes(i.name)
    }));
    res.json({ ok: true, running: st.capturing, capturing: st.capturing,
               totalPackets: st.captureCount, captureCount: st.captureCount, interfaces: ifaces });
  } catch (err) { workerErr(res, err); }
});

// GET /api/capture/packets?limit=500&offset=0
router.get('/capture/packets', async (req, res) => {
  try {
    const limit  = Number(req.query.limit  ?? 1000);
    const offset = Number(req.query.offset ?? 0);
    const { rows, total } = req.app.locals.packetBackend.getCaptures(limit, offset);
    res.json({ ok: true, rows, total });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture/start
router.post('/capture/start', async (req, res) => {
  try {
    const body = req.body || {};
    const { srcMac = '', dstMac = '', etherType = '', bpfFilter: rawBpf = '', promisc = false } = body;
    let bpfFilter = buildBpfFilter({ srcMac, dstMac, etherType, bpfFilter: rawBpf });

    // When no explicit filter is provided and promisc mode is not requested,
    // auto-build a BPF filter from the interface MACs to suppress flooding noise.
    const pb     = req.app.locals.packetBackend;
    const ifaces = body.interfaces || [];
    if (!bpfFilter && !promisc && ifaces.length) {
      bpfFilter = pb.buildIfaceBpfFilter(ifaces);
    }

    pb.clearCapture();
    let captureErr = '';
    pb.startCapture(ifaces, bpfFilter, () => {}, (e) => { captureErr = e.message; });

    // Wait briefly so tcpdump can fail fast (permission denied, no device, etc.)
    await new Promise(r => setTimeout(r, 350));

    const stillRunning = pb.isCapturing();
    const lastErr      = pb.getLastCaptureError ? pb.getLastCaptureError() : captureErr;

    const realErr = lastErr && !/listening on /i.test(lastErr) ? lastErr : '';
    if (!stillRunning && realErr) {
      const hint = /permission/i.test(realErr)
        ? ' → fix: sudo setcap cap_net_raw,cap_net_admin+eip $(which tcpdump)  or run: sudo node server.js'
        : /no such device|siocgifhwaddr/i.test(realErr)
          ? ' → interface not found; check /api/interfaces for available names'
          : '';
      return res.status(500).json({ ok: false, error: realErr + hint });
    }
    res.json({ ok: true, bpfFilter, capturing: stillRunning, interfaces: pb.getCaptureDeviceNames().length,
               warning: !stillRunning ? 'No matching capture device found' : undefined });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture/stop
router.post('/capture/stop', async (req, res) => {
  try {
    req.app.locals.packetBackend.stopCapture();
    res.json({ ok: true, capturing: false });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture/clear
router.post('/capture/clear', async (req, res) => {
  try {
    req.app.locals.packetBackend.clearCapture();
    res.json({ ok: true });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture  (one-shot)
router.post('/capture', async (req, res) => {
  const { interfaces = [], timeoutMs = 5000, limit = 500 } = req.body || {};
  try {
    const pb = req.app.locals.packetBackend;
    pb.clearCapture();
    pb.startCapture(interfaces, '', () => {}, () => {});
    await new Promise(r => setTimeout(r, Math.min(timeoutMs, 30000)));
    pb.stopCapture();
    const { rows, total } = pb.getCaptures(limit, 0);
    res.json({ ok: true, rows, total });
  } catch (err) { workerErr(res, err); }
});

// POST /api/capture-stream — NDJSON streaming
router.post('/capture-stream', async (req, res) => {
  const { packetBackend } = req.app.locals;
  const {
    interfaces: ifaceArr, interface: ifaceSingle,
    timeoutMs, timeoutSec, srcMac = '', dstMac = '', etherType = ''
  } = req.body || {};

  const interfaces = ifaceArr?.length ? ifaceArr : ifaceSingle ? [ifaceSingle] : [];
  let effectiveTimeout;
  if (timeoutMs !== undefined)      effectiveTimeout = timeoutMs === 0 ? 3600000 : timeoutMs;
  else if (timeoutSec !== undefined) effectiveTimeout = timeoutSec === 0 ? 3600000 : timeoutSec * 1000;
  else effectiveTimeout = 3600000;
  effectiveTimeout = Math.min(effectiveTimeout, 3600000);

  const normMac  = (m) => (m || '').replace(/[:\-]/g, '').toLowerCase();
  const filterSrc   = srcMac   ? normMac(srcMac)   : '';
  const filterDst   = dstMac   ? normMac(dstMac)   : '';
  const filterEtype = etherType ? etherType.toLowerCase().replace('0x', '') : '';

  function passesFilter(rec) {
    if (!filterSrc && !filterDst && !filterEtype) return true;
    const eth = rec.decoded?.ethernet || rec.decoded?.eth || {};
    if (filterSrc   && normMac(eth.srcMac || '') !== filterSrc)   return false;
    if (filterDst   && normMac(eth.dstMac || '') !== filterDst)   return false;
    if (filterEtype && (eth.etherType || '').replace('0x', '').toLowerCase() !== filterEtype) return false;
    return true;
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };
  let stopped = false;

  // ── Native cap path ───────────────────────────────────────────────────────
  const bpfFilter = buildBpfFilter({ srcMac, dstMac, etherType });
  const onRecord = (rec) => {
    if (!stopped && passesFilter(rec)) write({ type: 'frame', ...rec });
  };
  packetBackend.addStreamCallback(onRecord);
  packetBackend.clearCapture();
  const ok = packetBackend.startCapture(interfaces, bpfFilter, () => {}, (e) => write({ error: e.message }));
  if (!ok) { write({ error: 'No capture device available (install libpcap)' }); res.end(); return; }

  const stop = () => {
    if (stopped) return; stopped = true;
    packetBackend.removeStreamCallback(onRecord);
    packetBackend.stopCapture();
    write({ done: true }); res.end();
  };
  const timer = setTimeout(stop, effectiveTimeout);
  req.on('close', () => { clearTimeout(timer); stop(); });
});

module.exports = router;
