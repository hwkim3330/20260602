'use strict';
const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const router = Router();

const PORTMAP_FILE = path.join(__dirname, '../logs/portmap.json');
const REMOTE_URL   = 'http://169.254.1.168:8080';
const DEFAULT_MAP  = [
  { port: 0, iface: 'enp12s0f0' },
  { port: 1, iface: 'enp12s0f1' },
  { port: 2, iface: 'enp12s0f2' },
  { port: 3, iface: 'enp12s0f3' },
  { port: 4, iface: 'enp3s0f1', nodeUrl: REMOTE_URL },   // 192.168.1.244
  { port: 5, iface: 'enp3s0f0', nodeUrl: REMOTE_URL },   // 192.168.1.254
];

router.get('/portmap', (_req, res) => {
  try {
    if (fs.existsSync(PORTMAP_FILE)) {
      return res.json({ ok: true, portmap: JSON.parse(fs.readFileSync(PORTMAP_FILE, 'utf8')) });
    }
    res.json({ ok: true, portmap: DEFAULT_MAP });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/portmap', (req, res) => {
  try {
    const { portmap } = req.body || {};
    if (!Array.isArray(portmap)) return res.status(400).json({ ok: false, error: 'portmap must be array' });
    const dir = path.dirname(PORTMAP_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PORTMAP_FILE, JSON.stringify(portmap, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
