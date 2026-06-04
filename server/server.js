'use strict';

// Mixed Korean locale (LC_NUMERIC=ko_KR etc.) causes free(): invalid pointer
// in cap/pcap C library locale-sensitive functions at startup.
process.env.LC_ALL     = 'C';
process.env.LC_NUMERIC = 'C';
process.env.LC_CTYPE   = 'C';

// Windows: Npcap DLL must be in PATH before cap.node loads
if (process.platform === 'win32') {
  const npcapDir = 'C:\\Windows\\System32\\Npcap';
  if (!process.env.PATH.includes(npcapDir)) process.env.PATH = npcapDir + ';' + process.env.PATH;
}

// Place the cap.node prebuilt matching this OS/arch/Node-ABI into cap's load
// path BEFORE anything requires `cap`. Lets the committed node_modules run on
// both Windows and Linux from a fresh clone. No-op if there's no prebuilt.
try { require('./tools/cap-prebuilt').ensureCapBinary(); } catch {}

// Prevent unhandled errors from killing the process
process.on('uncaughtException',   (err) => console.error('[FATAL uncaughtException]', err));
process.on('unhandledRejection',  (reason) => console.error('[FATAL unhandledRejection]', reason));

const express = require('express');
const cors    = require('cors');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const serialBridge   = require('./services/serialBridge');
const switchProtocol = require('./services/switchProtocol');
const packetBackend  = require('./services/packetBackend');
const fastEngine     = require('./services/fastEngine');
const nativeWorker   = require('./services/nativeWorker');
const autoEngine     = require('./services/autoEngine');
const { timeoutSignal, httpFetch } = require('./services/httpUtil');

const app  = express();
const PORT = Number(process.env.PORT || 8080);

app.use(cors());
app.use(express.json({ limit: '32mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── storage dirs ─────────────────────────────────────────────────────────────
const logsDir    = path.join(__dirname, 'logs');
const testsDir   = path.join(logsDir, 'tests');
const macrosDir  = path.join(logsDir, 'macros');
const reportsDir = path.join(__dirname, 'reports');
[logsDir, testsDir, macrosDir, reportsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.locals.logsDir        = logsDir;
app.locals.testsDir       = testsDir;
app.locals.macrosDir      = macrosDir;
app.locals.reportsDir     = reportsDir;
app.locals.serialBridge   = serialBridge;
app.locals.switchProtocol = switchProtocol;
app.locals.packetBackend  = packetBackend;
app.locals.fastEngine     = fastEngine;
app.locals.autoEngine     = autoEngine;

// Initialize autoEngine with services and storage dir
autoEngine.init({ packetBackend, serialBridge, switchProtocol }, testsDir);

// Dispatch command to native worker
async function localCmd(command, payload = {}) {
  return nativeWorker.dispatch(command, payload, { packetBackend, serialBridge, switchProtocol });
}
app.locals.localCmd = localCmd;

// Broadcast to all browser WebSocket clients
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.locals.broadcast = (msg) => {
  const raw = JSON.stringify(msg);
  wss.clients.forEach(ws => { try { ws.send(raw); } catch {} });
};

// Relay native serial events to browser WebSocket clients
serialBridge.events.on('serial', (payload) => {
  app.locals.broadcast({ type: 'workerEvent', payload });
});

// ── built-in simple routes ────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => res.json({ ok: true, commit: '1.0.0', version: '1.0.0' }));

app.get('/api/local-addresses', (_req, res) => {
  const nics = os.networkInterfaces();
  const addrs = [];
  for (const [name, entries] of Object.entries(nics || {})) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal) addrs.push({ name, address: e.address, netmask: e.netmask });
    }
  }
  const primary = addrs.find(a => /^172\./.test(a.address))
                 || addrs.find(a => /^10\./.test(a.address))
                 || addrs.find(a => /^192\.168\./.test(a.address) && !a.name.toLowerCase().includes('virtualbox') && !a.name.toLowerCase().includes('vmware') && !a.name.toLowerCase().includes('hyper'))
                 || addrs.find(a => !/^169\.254\./.test(a.address))
                 || addrs[0];
  res.json({ ok: true, addresses: addrs, primary: primary?.address || 'localhost' });
});

app.get('/api/examples', (_req, res) => {
  res.json({
    ok: true,
    profiles: {
      udp:  { protocol: 'udp',  dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', srcPort: 12345, dstPort: 50000, count: 1, intervalMs: 0, payload: { mode: 'text', data: 'KETI' } },
      icmp: { protocol: 'icmp', dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', count: 1, intervalMs: 0, payload: { mode: 'text', data: 'KETI ping' } },
      arp:  { protocol: 'arp',  dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '192.168.1.1', dstIp: '192.168.1.2', count: 1, intervalMs: 0 }
    },
    items: []
  });
});

app.post('/api/simple-bidir-forward-test', async (req, res) => {
  const { nodeAUrl, nodeBUrl, nodeAPrimaryInterface, nodeBPrimaryInterface,
    nodeAMonitorInterfaces = [], nodeBMonitorInterfaces = [],
    count = 10, intervalMs = 100, udpSrcPort = 40000, udpDstPort = 50000,
    payloadMarkerPrefix = 'KETI_SIMPLE_FORWARD', captureTimeoutMs = 3000,
    direction = 'A_TO_B' } = req.body || {};

  const directions = direction === 'BOTH' ? ['A_TO_B', 'B_TO_A'] : [direction];
  const results = [];

  for (const dir of directions) {
    const senderUrl   = dir === 'A_TO_B' ? nodeAUrl   : nodeBUrl;
    const receiverUrl = dir === 'A_TO_B' ? nodeBUrl   : nodeAUrl;
    const senderIface = dir === 'A_TO_B' ? nodeAPrimaryInterface : nodeBPrimaryInterface;
    const recvIface   = dir === 'A_TO_B' ? nodeBPrimaryInterface : nodeAPrimaryInterface;
    const monitorUrls = dir === 'A_TO_B'
      ? nodeAMonitorInterfaces.map(i => ({ url: nodeAUrl, iface: i })).concat(nodeBMonitorInterfaces.map(i => ({ url: nodeBUrl, iface: i })))
      : nodeBMonitorInterfaces.map(i => ({ url: nodeBUrl, iface: i })).concat(nodeAMonitorInterfaces.map(i => ({ url: nodeAUrl, iface: i })));

    let captureStartErr = '', sendErr = '';
    try {
      const hdr = { 'Content-Type': 'application/json' };
      const to  = (ms) => ({ signal: timeoutSignal(ms) });

      // Start capture on receiver (promisc=true so all frames are captured)
      await httpFetch(`${receiverUrl}/api/capture/clear`, { method: 'POST', headers: hdr, body: '{}', ...to(8000) })
        .catch(e => { captureStartErr = e.message; });
      const capStartResp = await httpFetch(`${receiverUrl}/api/capture/start`, {
        method: 'POST', headers: hdr,
        body: JSON.stringify({ interfaces: [recvIface], promisc: true }),
        ...to(15000)
      }).catch(e => { captureStartErr = e.message; return null; });
      if (capStartResp && !capStartResp.ok) {
        const cd = await capStartResp.json().catch(() => ({}));
        captureStartErr = cd.error || `HTTP ${capStartResp.status}`;
      }

      // Brief pause so tcpdump/capture is fully running before we send
      await new Promise(r => setTimeout(r, 600));

      // Send packets from sender
      const marker = `${payloadMarkerPrefix}_${dir}_${Date.now()}`;
      const sendBody = { interface: senderIface, protocol: 'udp', dstMac: 'FF:FF:FF:FF:FF:FF', srcIp: '169.254.1.1', dstIp: '169.254.1.2', srcPort: udpSrcPort, dstPort: udpDstPort, count, intervalMs, payload: { mode: 'text', data: marker } };
      const sendResp = await httpFetch(`${senderUrl}/api/send`, { method: 'POST', headers: hdr, body: JSON.stringify(sendBody), ...to(30000) })
        .catch(e => { sendErr = e.message; return null; });
      if (sendResp && !sendResp.ok) {
        const sd = await sendResp.json().catch(() => ({}));
        sendErr = sd.error || `HTTP ${sendResp.status}`;
      }

      // Wait for capture
      await new Promise(r => setTimeout(r, Math.min(captureTimeoutMs, 10000)));

      // Stop and collect capture
      await httpFetch(`${receiverUrl}/api/capture/stop`, { method: 'POST', headers: hdr, body: '{}', ...to(8000) }).catch(() => {});
      const capResp = await httpFetch(`${receiverUrl}/api/capture/packets?limit=1000`, { ...to(10000) }).catch(() => null);
      const capData = capResp ? await capResp.json().catch(() => ({})) : {};
      const rows = capData.rows ?? [];
      const markerHex = Buffer.from(marker, 'utf8').toString('hex');
      const matched = rows.filter(r =>
        (r.decoded && JSON.stringify(r.decoded).includes(marker)) ||
        (r.frameHex && r.frameHex.includes(markerHex))
      );

      const passThreshold = Math.max(1, Math.ceil(count * 0.5));
      const result = matched.length >= passThreshold ? 'PASS' : 'FAIL';
      results.push({
        direction: dir, result, senderUrl, receiverUrl,
        sent: count, matched: matched.length, totalCaptured: rows.length,
        captureStartErr: captureStartErr || undefined,
        sendErr: sendErr || undefined,
      });
    } catch (e) {
      results.push({ direction: dir, result: 'FAIL', error: e.message, senderUrl, receiverUrl });
    }
  }

  const overall = results.every(r => r.result === 'PASS') ? 'PASS' : 'FAIL';
  res.json({
    ok: true,
    directions: results,
    report: {
      overall, generatedAt: new Date().toISOString(),
      directions: results.map(r => ({
        direction: r.direction, result: r.result,
        senderUrl: r.senderUrl, receiverUrl: r.receiverUrl,
        sent: r.sent, matched: r.matched, error: r.error
      }))
    }
  });
});

// ── routes ───────────────────────────────────────────────────────────────────
app.use('/api/remote-capture', require('./routes/remoteCapture'));
app.use('/api', require('./routes/health'));
app.use('/api', require('./routes/packet'));
app.use('/api', require('./routes/capture'));
app.use('/api', require('./routes/tty'));
app.use('/api', require('./routes/testcases'));
app.use('/api', require('./routes/packetFlow'));
app.use('/api', require('./routes/macro'));
app.use('/api', require('./routes/logs'));
app.use('/api', require('./routes/tests'));
app.use('/api', require('./routes/scenario'));
app.use('/api', require('./routes/register'));
app.use('/api', require('./routes/fdb'));
app.use('/api', require('./routes/serial'));
app.use('/api', require('./routes/mdio'));
app.use('/api', require('./routes/counter'));
app.use('/api', require('./routes/timestamp'));
app.use('/api', require('./routes/auto'));
app.use('/api', require('./routes/portmap'));
app.use('/api', require('./routes/table'));
app.use('/api', require('./routes/settings'));

// ── reports static ───────────────────────────────────────────────────────────
app.use('/reports', express.static(reportsDir));

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

server.listen(PORT, '0.0.0.0', () => {
  const nics = os.networkInterfaces();
  const allIpv4 = Object.entries(nics || {}).flatMap(([name, entries]) =>
    (entries || []).filter(e => e.family === 'IPv4' && !e.internal).map(e => ({ name, address: e.address }))
  );
  // Group: regular first, then link-local
  const regular   = allIpv4.filter(e => !/^169\.254\./.test(e.address));
  const linkLocal = allIpv4.filter(e =>  /^169\.254\./.test(e.address));

  console.log(`[PacketLabManager] Local   : http://localhost:${PORT}`);
  for (const { name, address } of regular)   console.log(`[PacketLabManager] Network : http://${address}:${PORT}  (${name})`);
  for (const { name, address } of linkLocal) console.log(`[PacketLabManager] Link-Local: http://${address}:${PORT}  (${name})`);
  console.log(`[PacketLabManager] Reports : ${reportsDir}`);
  console.log(`[PacketLabManager] Serial  : ${serialBridge.isAvailable()
    ? (process.platform === 'linux' ? 'Linux TTY ready (stty fallback + serialport if installed)' : 'serialport npm ready')
    : 'no serial support (install: npm install serialport)'}`);
  const capStatus = packetBackend.isAvailable()
    ? 'cap npm ready (send+capture)'
    : packetBackend.isTcpdumpAvailable()
      ? 'no cap npm — tcpdump fallback active (capture only)'
      : 'no cap npm, no tcpdump — packet features unavailable';
  console.log(`[PacketLabManager] Packets : ${capStatus}`);
  const fe = fastEngine.info();
  if (fe.available)
    console.log(`[PacketLabManager] Fast    : optional Linux engine ready (txgen:${!!fe.txgen} rxcap:${!!fe.rxcap})`);
});
