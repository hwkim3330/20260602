'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const router = Router();
const runningMacros = new Map();

function makeMacroId() {
  const now  = new Date();
  const ts   = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const rand = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
  return `packet-flow-macro-${ts}-${rand}`;
}

// POST /api/macro/packet-flow/start
router.post('/macro/packet-flow/start', (req, res) => {
  try {
    const macroId = makeMacroId();
    const { ports = [1, 2, 3], ...rest } = req.body;

    const steps = ports.map((port, i) => ({
      step:               i + 1,
      flowMode:           'FDB_STATIC_UNICAST',
      expectedOutputPort: port,
      status:             'pending'
    }));

    const macro = { macroId, startedAt: new Date().toISOString(), steps, ...rest };
    runningMacros.set(macroId, macro);

    res.json({ ok: true, macroId, steps });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/macro/:macroId/step-result
router.post('/macro/:macroId/step-result', (req, res) => {
  try {
    const { macroId } = req.params;
    const macrosDir   = req.app.locals.macrosDir;
    const macro       = runningMacros.get(macroId) ?? { macroId };

    // Update step status
    const step = macro.steps?.find(s => s.step === req.body.step);
    if (step) {
      step.status = req.body.result === 'PASS' ? 'pass' : 'fail';
      step.result = req.body;
    }

    // Save current macro state
    const filename = `${macroId}.json`;
    fs.writeFileSync(path.join(macrosDir, filename), JSON.stringify(macro, null, 2));

    req.app.locals.broadcast?.({ type: 'macro-step-result', macroId, data: req.body });

    res.json({ ok: true, saved: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
