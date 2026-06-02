'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const router = Router();

// In-memory running tests map
const runningTests = new Map();

// Generate unique test ID
function makeTestId() {
  const now = new Date();
  const ts  = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `packet-flow-${ts}-${rand}`;
}

// POST /api/packet-flow/start
router.post('/packet-flow/start', (req, res) => {
  try {
    const testId  = makeTestId();
    const payload = { testId, startedAt: new Date().toISOString(), status: 'running', ...req.body };
    runningTests.set(testId, payload);
    res.json({ ok: true, testId, status: 'running' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/packet-flow/result
router.post('/packet-flow/result', (req, res) => {
  try {
    const { testId } = req.body;
    const testsDir   = req.app.locals.testsDir;
    const record     = { savedAt: new Date().toISOString(), ...req.body };

    const filename = `${testId || makeTestId()}.json`;
    fs.writeFileSync(path.join(testsDir, filename), JSON.stringify(record, null, 2));

    if (testId) runningTests.delete(testId);

    req.app.locals.broadcast && req.app.locals.broadcast({ type: 'packet-flow-result', data: record });

    res.json({ ok: true, saved: true, filename });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/packet-flow/:testId
router.get('/packet-flow/:testId', (req, res) => {
  try {
    const testsDir = req.app.locals.testsDir;
    const filePath = path.join(testsDir, `${req.params.testId}.json`);
    if (!fs.existsSync(filePath)) {
      // Check running tests
      const running = runningTests.get(req.params.testId);
      if (running) return res.json({ ok: true, ...running });
      return res.status(404).json({ ok: false, error: 'Test not found' });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
