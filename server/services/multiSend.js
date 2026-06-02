'use strict';
/**
 * multiSend.js — fire a burst on several interfaces (near-)simultaneously.
 *
 * One child process per interface (tools/sendworker.js); all are given the SAME
 * target wall-clock instant (startAt) and busy-wait to fire together. Each child
 * uses the sendqueue addon, so the bursts run truly in parallel (separate
 * processes/cores) rather than the single-threaded sequential path.
 */
const path = require('path');
const { spawn } = require('child_process');
const pb = require('./packetBackend');
const { buildFrame } = require('./frameBuilder');

const WORKER = path.join(__dirname, '..', 'tools', 'sendworker.js');

function sendMulti(body = {}) {
  if (!pb.isFastSendAvailable())
    return Promise.reject(new Error('multi-interface send needs the sendqueue engine (Windows: npm run setup:winfast; Linux: build native/sendqueue)'));

  const interfaces = body.interfaces || [];
  if (!interfaces.length) return Promise.reject(new Error('interfaces[] required'));

  const count = body.count ?? 100000;
  const chunk = body.chunk ?? 4000;
  const sync  = body.sync ? 1 : 0;
  // Give every child time to spawn and reach its busy-wait before the shared fire time.
  const startAt = Date.now() + Math.max(150, Math.min(body.startDelayMs ?? 400, 5000));

  const jobs = interfaces.map((name) => {
    const dev = pb.resolveDevice(name);
    if (!dev) return Promise.resolve({ interface: name, ok: false, error: 'pcap device resolve failed' });

    // Build this interface's frame with its own NIC MAC auto-filled for src.
    let frame;
    try {
      const prof = pb.autofillSrcMac({ ...body, interface: name });
      frame = buildFrame(prof, 0);
    } catch (e) { return Promise.resolve({ interface: name, ok: false, error: 'frame build failed: ' + e.message }); }

    const args = JSON.stringify({ dev, frameHex: frame.toString('hex'), count, chunk, sync, startAt });
    return new Promise((resolve) => {
      const c = spawn(process.execPath, [WORKER, args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let outBuf = '', errBuf = '';
      c.stdout.on('data', d => (outBuf += d));
      c.stderr.on('data', d => (errBuf += d));
      c.on('error', e => resolve({ interface: name, ok: false, error: 'spawn failed: ' + e.message }));
      c.on('close', () => {
        let r = {};
        try { r = JSON.parse(outBuf); } catch {}
        const gbps = (r.ok && r.durMs) ? +((r.bytes * 8) / (r.durMs / 1000) / 1e9).toFixed(3) : 0;
        resolve({ interface: name, dev, frameLen: frame.length, gbps, ...r,
                  stderr: errBuf.trim() ? errBuf.trim().slice(0, 200) : undefined });
      });
    });
  });

  return Promise.all(jobs).then((results) => {
    const okRes = results.filter(r => r.ok);
    const skews = okRes.map(r => r.skewMs).filter(v => typeof v === 'number');
    const totalBytes = okRes.reduce((a, r) => a + (r.bytes || 0), 0);
    // Aggregate Gbps over the slowest child's send duration (they ran in parallel).
    const maxDur = Math.max(0.001, ...okRes.map(r => (r.durMs || 0) / 1000));
    return {
      startAt,
      interfaces: results.length,
      maxStartSkewMs: skews.length ? Math.max(...skews.map(Math.abs)) : null,
      aggregateGbps: +(totalBytes * 8 / maxDur / 1e9).toFixed(3),
      results,
    };
  });
}

module.exports = { sendMulti };
