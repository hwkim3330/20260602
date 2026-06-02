'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(503).json({ ok: false, error: e.message }); }

router.get('/serial/status', async (req, res) => {
  try {
    const { serialBridge } = req.app.locals;
    const ttys = await serialBridge.list();
    const st   = serialBridge.getStatus();
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
