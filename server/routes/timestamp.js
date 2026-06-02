'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(e.workerError ? 502 : 503).json({ ok: false, error: e.message }); }

// Timestamp register offsets (from TimestampViewModel.cs)
const OFF_NS       = 0x020;
const OFF_SEC_LO   = 0x024;
const OFF_SEC_HI   = 0x028;
const OFF_CTRL_0   = 0x02C;
const OFF_CTRL_1   = 0x030;

function toHexOffset(num) {
  return '0x' + num.toString(16).toUpperCase().padStart(8, '0');
}

function parseHexVal(str) {
  return parseInt(String(str || '0').replace(/^0x/i, ''), 16);
}

async function regRead(req, offset) {
  const d = await req.app.locals.localCmd('registerread', { offset: toHexOffset(offset) }, 5000);
  return parseHexVal(d.value);
}

async function regWrite(req, offset, value) {
  await req.app.locals.localCmd('registerwrite', {
    offset: toHexOffset(offset),
    value:  '0x' + ((value >>> 0) >>> 0).toString(16).toUpperCase().padStart(8, '0')
  }, 5000);
}

// ── GET /api/timestamp/read ───────────────────────────────────────────────────
// Reads NS → SEC_LO → SEC_HI (reading NS triggers snapshot in hardware)
router.get('/timestamp/read', async (req, res) => {
  try {
    const ns    = await regRead(req, OFF_NS);
    const secLo = await regRead(req, OFF_SEC_LO);
    const secHi = await regRead(req, OFF_SEC_HI);

    // Reconstruct 48-bit seconds (secHi[15:0] | secLo[31:0])
    const sec = ((secHi & 0xFFFF) * 0x100000000) + (secLo >>> 0);
    let isoString = null;
    try {
      const dt = new Date(sec * 1000);
      isoString = dt.toISOString();
    } catch {}

    res.json({ ok: true, ns: ns >>> 0, secLo: secLo >>> 0, secHi: secHi & 0xFFFF, sec, isoString });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/timestamp/set ───────────────────────────────────────────────────
// body: { year, month, day, hour, min, sec, ns? }
// Writes NS → SEC_LO → SEC_HI (SEC_HI write triggers latch)
router.post('/timestamp/set', async (req, res) => {
  try {
    const { year, month, day, hour, min, sec: second, ns = 0 } = req.body || {};

    const dt = new Date(
      Number(year  || 2025),
      Number(month || 1) - 1, // JS months are 0-indexed
      Number(day   || 1),
      Number(hour  || 0),
      Number(min   || 0),
      Number(second || 0)
    );

    const unixSec = Math.floor(dt.getTime() / 1000);
    const secLo   = (unixSec & 0xFFFFFFFF) >>> 0;
    const secHi   = Math.floor(unixSec / 0x100000000) & 0xFFFF;
    const nsVal   = (Number(ns) & 0x3FFFFFFF) >>> 0;

    await regWrite(req, OFF_NS,     nsVal);
    await regWrite(req, OFF_SEC_LO, secLo);
    await regWrite(req, OFF_SEC_HI, secHi); // triggers latch

    res.json({ ok: true, unixSec, isoString: dt.toISOString() });
  } catch (e) { wErr(res, e); }
});

// ── GET /api/timestamp/status ─────────────────────────────────────────────────
// Reads CTRL_0 (ADDEND) and CTRL_1 (INCREMENT + PPS)
router.get('/timestamp/status', async (req, res) => {
  try {
    const ctrl0 = await regRead(req, OFF_CTRL_0);
    const ctrl1 = await regRead(req, OFF_CTRL_1);

    const increment = ctrl1 & 0xFFFF;
    const ppsSrc    = (ctrl1 >>> 16) & 0x3;
    const ppsWidth  = ((ctrl1 >>> 24) & 0xFF) * 2; // ms

    res.json({
      ok:     true,
      ctrl0:  '0x' + (ctrl0 >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      ctrl1:  '0x' + (ctrl1 >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      addend:    ctrl0 >>> 0,
      increment: increment,
      ppsSrc:    ppsSrc,
      ppsWidthMs: ppsWidth
    });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
