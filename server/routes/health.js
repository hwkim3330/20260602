'use strict';
const { Router } = require('express');
const os = require('os');
const router = Router();

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    server: { name: 'packet-lab-manager', port: Number(process.env.PORT || 8080) },
    time: new Date().toISOString()
  });
});

router.get('/backend/status', async (req, res) => {
  const { packetBackend, serialBridge } = req.app.locals;

  let serialPorts = [];
  if (serialBridge?.isAvailable?.()) {
    try { serialPorts = await serialBridge.list(); } catch {}
  }

  const interfaces = packetBackend.listInterfaces();
  const nodeNative = {
    packetSend: Boolean(packetBackend.isAvailable?.()),
    packetCapture: Boolean(packetBackend.isAvailable?.() || packetBackend.isTcpdumpAvailable?.()),
    cap: Boolean(packetBackend.isAvailable?.()),
    tcpdump: Boolean(packetBackend.isTcpdumpAvailable?.()),
    serial: Boolean(serialBridge?.isAvailable?.()),
    serialOpen: Boolean(serialBridge?.getStatus?.().open),
    serialPorts: serialPorts.map((p) => p.path || p.name).filter(Boolean),
    interfaces: interfaces.map((i) => ({
      name: i.name,
      state: i.state,
      mac: i.mac,
      ipv4: i.ipv4 || []
    }))
  };

  const features = {
    send: nodeNative.packetSend,
    capture: nodeNative.packetCapture,
    serial: nodeNative.serial,
    register: nodeNative.serialOpen,
    fdb: nodeNative.serialOpen,
    mdio: nodeNative.serialOpen,
    reports: true
  };

  res.json({
    ok: true,
    mode: 'node-native',
    platform: { type: os.type(), platform: os.platform(), arch: os.arch(), node: process.version },
    nodeNative,
    features,
    notes: {
      packetSend: nodeNative.packetSend ? 'Node cap is available for raw Ethernet send.' : 'Raw Ethernet send needs cap optional dependency.',
      packetCapture: nodeNative.packetCapture ? 'Capture backend is available.' : 'Capture needs cap or tcpdump.',
      register: features.register ? 'Register/MDIO/FDB can run through open serial bridge.' : 'Open serial bridge for switch registers.'
    },
    time: new Date().toISOString()
  });
});

module.exports = router;
