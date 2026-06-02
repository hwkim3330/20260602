'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

// POST /api/fdb/read   body: { mac, vlanId? }
router.post('/fdb/read', async (req, res) => {
  try {
    const entry = await req.app.locals.switchProtocol.fdbRead(req.body || {});
    res.json({ ok: true, entry });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/write  body: { mac, port, vlanId?, static? }
router.post('/fdb/write', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbWrite(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/delete body: { mac, vlanId? }
router.post('/fdb/delete', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbDelete(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/flush
router.post('/fdb/flush', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbFlush(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/write-bucket body: { mac, port, bucket, slot, vlanId? }
router.post('/fdb/write-bucket', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbWriteBucket(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/read-bucket  body: { bucket, slot? }
router.post('/fdb/read-bucket', async (req, res) => {
  try {
    const entry = await req.app.locals.switchProtocol.fdbReadBucket(req.body || {});
    res.json({ ok: true, entry });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/flood-read   body: { vlanId }
router.post('/fdb/flood-read', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbFloodRead(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/flood-write  body: { vlanId, mask }
router.post('/fdb/flood-write', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbFloodWrite(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

// POST /api/fdb/flood-init
router.post('/fdb/flood-init', async (req, res) => {
  try {
    const r = await req.app.locals.switchProtocol.fdbFloodInit(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
