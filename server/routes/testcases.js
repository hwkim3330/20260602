'use strict';
const { Router } = require('express');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

const router = Router();

function getStore(req) {
  return path.join(req.app.locals.testsDir, 'test-cases.json');
}

function loadAll(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function saveAll(file, list) {
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}

// Transform stored flat object → list item shape app.js expects
function toListItem(tc) {
  return {
    id:        tc.id,
    name:      tc.name || 'Untitled',
    stepCount: Array.isArray(tc.steps) ? tc.steps.length : 0,
    testCase:  tc
  };
}

// GET /api/test-cases
router.get('/test-cases', (req, res) => {
  const list = loadAll(getStore(req));
  const items = list.map(toListItem);
  res.json({ ok: true, items, testCases: list });
});

// POST /api/test-cases
router.post('/test-cases', (req, res) => {
  const file = getStore(req);
  const list = loadAll(file);
  const tc   = { id: crypto.randomUUID(), savedAt: new Date().toISOString(), ...req.body };
  list.push(tc);
  saveAll(file, list);
  res.json({ ok: true, testCase: tc, ...tc });
});

// PUT /api/test-cases/:id
router.put('/test-cases/:id', (req, res) => {
  const file   = getStore(req);
  const list   = loadAll(file);
  const idx    = list.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'Not found' });
  list[idx]    = { ...list[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  saveAll(file, list);
  res.json({ ok: true, testCase: list[idx], ...list[idx] });
});

// DELETE /api/test-cases/:id
router.delete('/test-cases/:id', (req, res) => {
  const file   = getStore(req);
  const list   = loadAll(file);
  const before = list.length;
  const next   = list.filter(t => t.id !== req.params.id);
  saveAll(file, next);
  res.json({ ok: true, deleted: before - next.length });
});

// GET /api/test-profiles
router.get('/test-profiles', (req, res) => {
  const dir = path.join(__dirname, '..', 'testprofiles');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const items = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        // Ensure list-item shape: { id, name, profileGroup, stepCount, testCase }
        if (raw.testCase) return raw;
        return { id: raw.id || f.replace('.json', ''), name: raw.name || f, profileGroup: raw.profileGroup || 'General', stepCount: Array.isArray(raw.steps) ? raw.steps.length : 0, testCase: raw };
      } catch { return null; }
    })
    .filter(Boolean);
  res.json({ ok: true, items, profiles: items });
});

module.exports = router;
