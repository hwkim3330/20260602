'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(503).json({ ok: false, error: e.message }); }

// ── GET /api/tty/list ─────────────────────────────────────────────────────────
router.get('/tty/list', async (req, res) => {
  try {
    const { serialBridge } = req.app.locals;
    const ttys = await serialBridge.list();
    res.json({ ok: true, ttys, ports: ttys });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/tty/open ────────────────────────────────────────────────────────
router.post('/tty/open', async (req, res) => {
  try {
    const { path, port, baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none' } = req.body || {};
    const portName = path || port || '';
    const { serialBridge } = req.app.locals;
    const result = await serialBridge.open(portName, { baudRate, dataBits, stopBits, parity });
    res.json({ ok: true, ...result });
  } catch (e) { wErr(res, e); }
});

// ── GET /api/tty/stream ───────────────────────────────────────────────────────
router.get('/tty/stream', (req, res) => {
  const { serialBridge } = req.app.locals;
  const session = req.query.session || '';

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  const onEvent = (payload) => {
    if (payload?.kind !== 'serial') return;
    if (session && payload.session && payload.session !== session) return;
    if (payload.rxType === 'rx' && payload.hex) {
      write({ type: 'rx', hex: payload.hex, session: payload.session });
    } else if (payload.type === 'error') {
      write({ type: 'error', message: payload.message });
    } else if (payload.type === 'closed') {
      write({ type: 'closed' });
    }
  };

  serialBridge.events.on('serial', onEvent);
  write({ connected: true, session });

  const keepalive = setInterval(() => { try { res.write('\n'); } catch {} }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    serialBridge.events.off('serial', onEvent);
  });
});

// ── POST /api/tty/write ───────────────────────────────────────────────────────
router.post('/tty/write', async (req, res) => {
  try {
    const { sessionId, session, hex, data: hexData, text } = req.body || {};
    const s = sessionId || session;
    await req.app.locals.serialBridge.write(s, { hex: hex ?? hexData, text });
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/tty/control ─────────────────────────────────────────────────────
router.post('/tty/control', async (req, res) => {
  try {
    const { sessionId, session, ...rest } = req.body || {};
    const s = sessionId || session;
    await req.app.locals.serialBridge.setSignals(s, rest);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/tty/close ───────────────────────────────────────────────────────
router.post('/tty/close', async (req, res) => {
  try {
    const { sessionId, session } = req.body || {};
    const sid = sessionId || session || req.app.locals.serialBridge.getSession();
    if (sid) await req.app.locals.serialBridge.close(sid);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

// ── Legacy /api/serial/* aliases ──────────────────────────────────────────────
router.get('/serial/status', async (req, res) => {
  try {
    const ttys = await req.app.locals.serialBridge.list();
    const st   = req.app.locals.serialBridge.getStatus();
    res.json({ ok: true, ttys, ports: ttys, ...st });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/connect', async (req, res) => {
  try {
    const { path, port, baudRate = 115200, dataBits = 8, stopBits = 1, parity = 'none' } = req.body || {};
    const portName = path || port || '';
    const r = await req.app.locals.serialBridge.open(portName, { baudRate, dataBits, stopBits, parity });
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/disconnect', async (req, res) => {
  try {
    const { sessionId, session } = req.body || {};
    const sid = sessionId || session || req.app.locals.serialBridge.getSession();
    if (sid) await req.app.locals.serialBridge.close(sid);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/send', async (req, res) => {
  try {
    const { sessionId, session, hex, text } = req.body || {};
    await req.app.locals.serialBridge.write(sessionId || session, { hex, text });
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/clear', async (req, res) => {
  try {
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/break', async (req, res) => {
  try {
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/serial/control', async (req, res) => {
  try {
    const { sessionId, session, ...rest } = req.body || {};
    await req.app.locals.serialBridge.setSignals(sessionId || session, rest);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
