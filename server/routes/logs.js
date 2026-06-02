'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');

const router = Router();

// GET /api/logs  - return recent test + macro logs
router.get('/logs', (req, res) => {
  try {
    const testsDir  = req.app.locals.testsDir;
    const macrosDir = req.app.locals.macrosDir;
    const limit     = parseInt(req.query.limit ?? '50');

    const readDir = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort().reverse()
        .slice(0, limit)
        .map(f => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
          catch { return { file: f, error: 'parse error' }; }
        });
    };

    res.json({
      ok:     true,
      tests:  readDir(testsDir),
      macros: readDir(macrosDir)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
