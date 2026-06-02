'use strict';
const { Router } = require('express');
const router = Router();

function wErr(res, e) { res.status(503).json({ ok: false, error: e.message }); }

// TGSW_TB_REGION offsets (relative to BASE_ADDRESS)
const TB = {
  COMMAND:  0x280,
  INDEX:    0x284,
  WR_DATA:  0x288,
  RD_DATA:  0x28C,
};

const CMD_PCPM_WR = 0x001;
const CMD_PCPM_RD = 0x100;

function hex8(n) { return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

async function tbWrite(sp, session, offset, value) {
  await sp.writeRegister(session, offset, value);
}
async function tbRead(sp, session, offset) {
  return sp.readRegister(session, offset);
}

// PCP Mapping index: bit[0]=pcp_sel(0=PCP0~7,1=Untag), bit[1]=dir(0=ingress,1=egress), bit[5:2]=port
function pcpIndex(port, dir, pcpSel) {
  return ((port & 0xF) << 2) | ((dir & 0x1) << 1) | (pcpSel & 0x1);
}

// Pack 8 PCP values (each 4-bit) into one 32-bit word
// map[0]=PCP#0 at bits[3:0], map[7]=PCP#7 at bits[31:28]
function packPcp8(map) {
  let v = 0;
  for (let i = 0; i < 8; i++) v |= ((map[i] & 0xF) << (i * 4));
  return v >>> 0;
}

function unpackPcp8(v) {
  const map = [];
  for (let i = 0; i < 8; i++) map.push((v >>> (i * 4)) & 0xF);
  return map;
}

// ── POST /api/table/pcp/write ─────────────────────────────────────────────────
// body: { port, dir(0=ingress,1=egress), map: [v0,v1,...,v7,vUntag] }
router.post('/table/pcp/write', async (req, res) => {
  try {
    const sp   = req.app.locals.switchProtocol;
    const sid  = req.app.locals.serialBridge.getSession(req.body.session);
    const port = Number(req.body.port ?? 0);
    const dir  = Number(req.body.dir  ?? 0);
    const map  = req.body.map;  // array of 9 values: [PCP0..PCP7, Untagged]

    if (!Array.isArray(map) || map.length !== 9)
      return res.status(400).json({ ok: false, error: 'map must be array of 9 values' });
    if (port < 0 || port > 8)
      return res.status(400).json({ ok: false, error: 'port must be 0-8' });

    // Write PCP#0~7
    const idx0 = pcpIndex(port, dir, 0);
    await tbWrite(sp, sid, TB.INDEX,   idx0);
    await tbWrite(sp, sid, TB.WR_DATA, packPcp8(map.slice(0, 8)));
    await tbWrite(sp, sid, TB.COMMAND, CMD_PCPM_WR);

    // Write Untagged
    const idx1 = pcpIndex(port, dir, 1);
    await tbWrite(sp, sid, TB.INDEX,   idx1);
    await tbWrite(sp, sid, TB.WR_DATA, map[8] & 0xF);
    await tbWrite(sp, sid, TB.COMMAND, CMD_PCPM_WR);

    res.json({ ok: true, port, dir, map });
  } catch (e) { wErr(res, e); }
});

// ── POST /api/table/pcp/read ──────────────────────────────────────────────────
// body: { port, dir(0=ingress,1=egress) }
router.post('/table/pcp/read', async (req, res) => {
  try {
    const sp   = req.app.locals.switchProtocol;
    const sid  = req.app.locals.serialBridge.getSession(req.body.session);
    const port = Number(req.body.port ?? 0);
    const dir  = Number(req.body.dir  ?? 0);

    // Read PCP#0~7
    const idx0 = pcpIndex(port, dir, 0);
    await tbWrite(sp, sid, TB.INDEX,   idx0);
    await tbWrite(sp, sid, TB.COMMAND, CMD_PCPM_RD);
    const raw0 = await tbRead(sp, sid, TB.RD_DATA);

    // Read Untagged
    const idx1 = pcpIndex(port, dir, 1);
    await tbWrite(sp, sid, TB.INDEX,   idx1);
    await tbWrite(sp, sid, TB.COMMAND, CMD_PCPM_RD);
    const raw1 = await tbRead(sp, sid, TB.RD_DATA);

    const map = [...unpackPcp8(raw0), raw1 & 0xF];
    res.json({ ok: true, port, dir, map });
  } catch (e) { wErr(res, e); }
});

// ── Traffic Policer ───────────────────────────────────────────────────────────
const CMD_TP_WR = 0x002;   // bit 1
const CMD_TP_RD = 0x200;   // bit 9

// INDEX: [2:0]=param, [8:3]=vlanIdx, [12:9]=port
function tpIndex(port, vlanIdx, param) {
  return ((port & 0xF) << 9) | ((vlanIdx & 0x3F) << 3) | (param & 0x7);
}

async function tpWriteParam(sp, sid, port, vlanIdx, param, value) {
  await tbWrite(sp, sid, TB.INDEX,   tpIndex(port, vlanIdx, param));
  await tbWrite(sp, sid, TB.WR_DATA, value >>> 0);
  await tbWrite(sp, sid, TB.COMMAND, CMD_TP_WR);
}

async function tpReadParam(sp, sid, port, vlanIdx, param) {
  await tbWrite(sp, sid, TB.INDEX,   tpIndex(port, vlanIdx, param));
  await tbWrite(sp, sid, TB.COMMAND, CMD_TP_RD);
  return tbRead(sp, sid, TB.RD_DATA);
}

// POST /api/table/tp/read-port  — read all 64 slots for a port
router.post('/table/tp/read-port', async (req, res) => {
  try {
    const sp   = req.app.locals.switchProtocol;
    const sid  = req.app.locals.serialBridge.getSession(req.body.session);
    const port = Number(req.body.port ?? 0);
    const slots = [];

    for (let idx = 0; idx < 64; idx++) {
      const raw0 = await tpReadParam(sp, sid, port, idx, 0);
      const valid  = (raw0 >> 12) & 0x1;
      const vlanId = raw0 & 0xFFF;
      if (!valid) { slots.push({ idx, valid: false }); continue; }

      const cir = await tpReadParam(sp, sid, port, idx, 1);
      const pir = await tpReadParam(sp, sid, port, idx, 2);
      const cbs = await tpReadParam(sp, sid, port, idx, 3);
      const pbs = await tpReadParam(sp, sid, port, idx, 4);
      slots.push({ idx, valid: true, vlanId, cir, pir, cbs, pbs });
    }
    res.json({ ok: true, port, slots });
  } catch (e) { wErr(res, e); }
});

// POST /api/table/tp/write  — write one slot
// body: { port, idx, vlanId, cir, pir, cbs, pbs }
router.post('/table/tp/write', async (req, res) => {
  try {
    const sp     = req.app.locals.switchProtocol;
    const sid    = req.app.locals.serialBridge.getSession(req.body.session);
    const port   = Number(req.body.port   ?? 0);
    const idx    = Number(req.body.idx    ?? 0);
    const vlanId = Number(req.body.vlanId ?? 0);
    const cir    = Number(req.body.cir    ?? 0);
    const pir    = Number(req.body.pir    ?? 0);
    const cbs    = Number(req.body.cbs    ?? 0);
    const pbs    = Number(req.body.pbs    ?? 0);

    const raw0 = (1 << 12) | (vlanId & 0xFFF);  // Valid=1
    await tpWriteParam(sp, sid, port, idx, 0, raw0);
    await tpWriteParam(sp, sid, port, idx, 1, cir);
    await tpWriteParam(sp, sid, port, idx, 2, pir);
    await tpWriteParam(sp, sid, port, idx, 3, cbs);
    await tpWriteParam(sp, sid, port, idx, 4, pbs);

    res.json({ ok: true, port, idx });
  } catch (e) { wErr(res, e); }
});

// POST /api/table/tp/delete  — clear one slot (Valid=0)
router.post('/table/tp/delete', async (req, res) => {
  try {
    const sp   = req.app.locals.switchProtocol;
    const sid  = req.app.locals.serialBridge.getSession(req.body.session);
    const port = Number(req.body.port ?? 0);
    const idx  = Number(req.body.idx  ?? 0);
    await tpWriteParam(sp, sid, port, idx, 0, 0);  // Valid=0
    res.json({ ok: true, port, idx });
  } catch (e) { wErr(res, e); }
});

// POST /api/table/tp/read-status  — read CBK/PBK for one slot
router.post('/table/tp/read-status', async (req, res) => {
  try {
    const sp   = req.app.locals.switchProtocol;
    const sid  = req.app.locals.serialBridge.getSession(req.body.session);
    const port = Number(req.body.port ?? 0);
    const idx  = Number(req.body.idx  ?? 0);
    const cbk  = await tpReadParam(sp, sid, port, idx, 5);
    const pbk  = await tpReadParam(sp, sid, port, idx, 6);
    res.json({ ok: true, port, idx, cbk, pbk });
  } catch (e) { wErr(res, e); }
});

// ── Credit Based Shaper ───────────────────────────────────────────────────────
const CMD_CBS_WR = 0x004;   // bit 2
const CMD_CBS_RD = 0x400;   // bit 10

// INDEX: [1:0]=param, [4:2]=pcp, [8:5]=port
function cbsIndex(port, pcp, param) {
  return ((port & 0xF) << 5) | ((pcp & 0x7) << 2) | (param & 0x3);
}

async function cbsWriteParam(sp, sid, port, pcp, param, value) {
  await tbWrite(sp, sid, TB.INDEX,   cbsIndex(port, pcp, param));
  await tbWrite(sp, sid, TB.WR_DATA, value >>> 0);
  await tbWrite(sp, sid, TB.COMMAND, CMD_CBS_WR);
}

async function cbsReadParam(sp, sid, port, pcp, param) {
  await tbWrite(sp, sid, TB.INDEX,   cbsIndex(port, pcp, param));
  await tbWrite(sp, sid, TB.COMMAND, CMD_CBS_RD);
  return tbRead(sp, sid, TB.RD_DATA);
}

// POST /api/table/cbs/write — write one (port, pcp)
// body: { port, pcp, idleSlopeTick, sendSlopeTick, loCredit, hiCredit }
router.post('/table/cbs/write', async (req, res) => {
  try {
    const sp           = req.app.locals.switchProtocol;
    const sid          = req.app.locals.serialBridge.getSession(req.body.session);
    const port         = Number(req.body.port         ?? 0);
    const pcp          = Number(req.body.pcp          ?? 0);
    const idleSlopeTick = Number(req.body.idleSlopeTick ?? 0);
    const sendSlopeTick = Number(req.body.sendSlopeTick ?? 0);
    const loCredit     = Number(req.body.loCredit     ?? 0);
    const hiCredit     = Number(req.body.hiCredit     ?? 0);

    await cbsWriteParam(sp, sid, port, pcp, 0, idleSlopeTick);
    await cbsWriteParam(sp, sid, port, pcp, 1, sendSlopeTick);
    await cbsWriteParam(sp, sid, port, pcp, 2, loCredit);
    await cbsWriteParam(sp, sid, port, pcp, 3, hiCredit);

    res.json({ ok: true, port, pcp, idleSlopeTick, sendSlopeTick, loCredit, hiCredit });
  } catch (e) { wErr(res, e); }
});

// POST /api/table/cbs/read-port — read all 8 PCPs for a port
router.post('/table/cbs/read-port', async (req, res) => {
  try {
    const sp   = req.app.locals.switchProtocol;
    const sid  = req.app.locals.serialBridge.getSession(req.body.session);
    const port = Number(req.body.port ?? 0);
    const pcps = [];

    for (let pcp = 0; pcp < 8; pcp++) {
      const idleSlopeTick = await cbsReadParam(sp, sid, port, pcp, 0);
      const sendSlopeTick = await cbsReadParam(sp, sid, port, pcp, 1);
      const loCredit      = await cbsReadParam(sp, sid, port, pcp, 2);
      const hiCredit      = await cbsReadParam(sp, sid, port, pcp, 3);
      pcps.push({ pcp, idleSlopeTick, sendSlopeTick, loCredit, hiCredit });
    }
    res.json({ ok: true, port, pcps });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
