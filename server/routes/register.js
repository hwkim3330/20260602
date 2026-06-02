'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(503).json({ ok: false, error: e.message }); }

// GET /api/register/status
router.get('/register/status', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.registerStatus();
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/register/read   body: { offset|address }
router.post('/register/read', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.registerRead(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/register/write  body: { offset|address, value }
router.post('/register/write', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.registerWrite(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/register/base-addr  body: { address }
router.post('/register/base-addr', async (req, res) => {
  try {
    const addr = String(req.body?.address || req.body?.addr || '').trim();
    if (!addr) return res.status(400).json({ ok: false, error: 'address required' });
    req.app.locals.switchProtocol.setBaseAddress(addr);
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
