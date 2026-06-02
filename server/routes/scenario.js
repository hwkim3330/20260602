'use strict';
const { Router } = require('express');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const router = Router();

let _iconv = null;
function getIconv() {
  if (!_iconv) { try { _iconv = require('iconv-lite'); } catch { _iconv = false; } }
  return _iconv || null;
}

/**
 * Read a CSV file and return its content as a UTF-8 string.
 * Handles UTF-8 (with/without BOM) and EUC-KR / CP949 automatically.
 */
function readCsvText(filePath) {
  const buf = fs.readFileSync(filePath);
  // UTF-8 BOM: EF BB BF
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  // Try UTF-8: U+FFFD replacement character indicates invalid bytes
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  // Fall back to EUC-KR (CP949) via iconv-lite if available
  const iconv = getIconv();
  if (iconv) return iconv.decode(buf, 'euc-kr');
  return utf8; // last resort: return broken string
}

function wErr(res, e) { res.status(503).json({ ok: false, error: e.message }); }

// ── Sequence file helpers ─────────────────────────────────────────────────────
function seqFile(req)  { return path.join(req.app.locals.testsDir, 'sequence.json'); }
function seqLoad(req)  {
  const f = seqFile(req);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function seqSave(req, items) { fs.writeFileSync(seqFile(req), JSON.stringify(items, null, 2)); }

// ── Legacy /api/scenarios/* aliases (auto routes are in auto.js) ─────────────
router.post('/scenarios/run', async (req, res) => {
  try {
    const test = req.body?.test;
    if (!test) return res.status(400).json({ ok: false, error: 'test required' });
    req.app.locals.autoEngine.runTest(test).catch(() => {});
    res.json({ ok: true, test, status: 'started' });
  } catch (e) { wErr(res, e); }
});
router.get('/scenarios/status', async (req, res) => {
  try {
    res.json({ ok: true, ...req.app.locals.autoEngine.getStatus() });
  } catch (e) { wErr(res, e); }
});
router.get('/scenarios/results', async (req, res) => {
  try {
    res.json({ ok: true, rows: req.app.locals.autoEngine.getResults() });
  } catch (e) { wErr(res, e); }
});

// ── Testcase management — file-based ─────────────────────────────────────────
function tcFile(req) { return path.join(req.app.locals.testsDir, 'test-cases.json'); }
function tcLoad(req) {
  const f = tcFile(req);
  if (!fs.existsSync(f)) return [{ id: 'default', name: 'Default Group', groups: [], cases: [] }];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function tcSave(req, data) { fs.writeFileSync(tcFile(req), JSON.stringify(data, null, 2)); }

// ── CSV helpers ───────────────────────────────────────────────────────────────
const scenariosDir = path.join(__dirname, '..', 'testScenarios');

function parseCsvRows(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const headers = lines[0].split(',').map(h => h.trim().replace(/�+$/, ''));
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
    return row;
  }).filter(r => Object.values(r).some(v => v));
}

function scanCsvFiles(dir, base) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel  = base ? `${base}/${entry}` : entry;
    if (fs.statSync(full).isDirectory()) {
      result.push(...scanCsvFiles(full, rel));
    } else if (entry.endsWith('.csv')) {
      result.push(rel);
    }
  }
  return result;
}

function buildCsvTree(dir, base) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const rel  = base ? `${base}/${entry}` : entry;
    if (fs.statSync(full).isDirectory()) {
      result.push({ type: 'dir', name: entry, path: rel, children: buildCsvTree(full, rel) });
    } else if (entry.endsWith('.csv')) {
      result.push({ type: 'file', name: entry, path: rel, isPacket: entry.toLowerCase().includes('packet') });
    }
  }
  return result;
}

// C# SyncCsvToGroups 로직과 동일:
// - 서브폴더 1개 = 그룹 1개, 폴더 내 CSV 파일 1개 = TestCase 1개 (TC_ID로 분리 안 함)
// - 루트 직속 TC CSV → "(root)" 그룹
// TC_Packets.csv(패킷 정의 파일)는 별도 처리, 여기서는 제외
function buildGroupsFromCsvs(all) {
  const tcCsvs = all.filter(f => !path.basename(f).toLowerCase().includes('packet'));

  // 루트 패킷 CSV 경로 (서브폴더 없는 것)
  const rootPacketCsv = all.find(f => !f.includes('/') && path.basename(f).toLowerCase().includes('packet'));

  // 폴더별로 묶기 (C# groupSpecs)
  const byFolder = new Map(); // folderLabel → [relPaths]
  for (const relPath of tcCsvs) {
    const parts  = relPath.split('/');
    const folder = parts.length > 1 ? parts[0] : '(root)';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(relPath);
  }

  const groups = [];
  for (const [folder, paths] of byFolder) {
    if (folder === '(root)') continue; // 루트 직속 TC CSV는 숨김 (서브폴더 그룹만 표시)
    // 각 CSV 파일을 TestCaseEntry로 변환 (C# ImportCsvAsEntry: 파일 1개 = 엔트리 1개)
    const cases = paths
      .sort()
      .map(relPath => {
        const full  = path.join(scenariosDir, relPath);
        const text  = readCsvText(full);
        const rows  = parseCsvRows(text);
        // C#과 동일하게 TestScenarioId, TcId 순으로 정렬
        rows.sort((a, b) => {
          const sidA = parseInt(a['Test_Scenario_ID'] || '0');
          const sidB = parseInt(b['Test_Scenario_ID'] || '0');
          const tidA = parseInt(a['TC_ID'] || a['TC_Id'] || '0');
          const tidB = parseInt(b['TC_ID'] || b['TC_Id'] || '0');
          const idxA = parseInt(a['Index'] || '0');
          const idxB = parseInt(b['Index'] || '0');
          return (tidA - tidB) || (sidA - sidB) || (idxA - idxB);
        });
        const firstRow    = rows[0] || {};
        const testScenId  = parseInt(firstRow['Test_Scenario_ID'] || '0');
        const tcId        = parseInt(firstRow['TC_ID'] || firstRow['TC_Id'] || '0');
        return {
          id: crypto.randomUUID(),
          name: path.basename(relPath, '.csv'),
          path: relPath,
          packetCsv: rootPacketCsv || null,
          testScenarioId: testScenId,
          tcId,
          steps: rows
        };
      })
      // C#과 동일: TestScenarioId → TcId → Name 순 정렬
      .sort((a, b) => (a.testScenarioId - b.testScenarioId) || (a.tcId - b.tcId) || a.name.localeCompare(b.name));

    if (cases.length)
      groups.push({ id: crypto.randomUUID(), name: folder, cases });
  }

  // C# Groups 정렬: 그룹 내 min(TestScenarioId) 순
  groups.sort((a, b) => {
    const minA = Math.min(...a.cases.map(c => c.testScenarioId));
    const minB = Math.min(...b.cases.map(c => c.testScenarioId));
    return (minA - minB) || a.name.localeCompare(b.name);
  });

  return groups;
}

router.get('/testcases/csv-tree', (req, res) => {
  try { res.json({ ok: true, tree: buildCsvTree(scenariosDir, '') }); }
  catch (e) { wErr(res, e); }
});

// CSV 파일에서 직접 읽어 Test_Scenario_ID → TC_ID 순 정렬된 그룹 반환
router.get('/testcases/sorted-groups', (req, res) => {
  try {
    const all    = scanCsvFiles(scenariosDir, '');
    const groups = buildGroupsFromCsvs(all);
    res.json({ ok: true, groups });
  } catch (e) { wErr(res, e); }
});

router.get('/testcases/scan-scenarios', (req, res) => {
  try {
    const all   = scanCsvFiles(scenariosDir, '');
    const files = all.filter(f => !path.basename(f).toLowerCase().includes('packet'));
    res.json({ ok: true, files });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/import-all-csv', (req, res) => {
  try {
    const all    = scanCsvFiles(scenariosDir, '');
    const groups = buildGroupsFromCsvs(all);
    tcSave(req, groups);
    const tcCount = groups.reduce((s, g) => s + g.cases.length, 0);
    res.json({ ok: true, imported: tcCount });
  } catch (e) { wErr(res, e); }
});

router.get('/testcases/csv-content', (req, res) => {
  try {
    const relPath = req.query.path || '';
    const full    = path.resolve(scenariosDir, relPath);
    if (!full.startsWith(scenariosDir)) return res.status(400).json({ ok: false, error: 'Invalid path' });
    const text    = readCsvText(full);
    const rows    = parseCsvRows(text);
    res.json({ ok: true, rows, headers: rows.length ? Object.keys(rows[0]) : [] });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/upload', (req, res) => {
  try {
    const { name, content } = req.body || {};
    if (!name || !content) return res.status(400).json({ ok: false, error: 'name and content required' });
    const dest = path.join(scenariosDir, path.basename(name));
    fs.writeFileSync(dest, content);
    res.json({ ok: true, path: path.basename(name) });
  } catch (e) { wErr(res, e); }
});

router.get('/testcases/status', async (req, res) => {
  try {
    res.json({ ok: true, snapshot: tcLoad(req) });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/add-group', async (req, res) => {
  try {
    const data = tcLoad(req);
    const grp  = { id: crypto.randomUUID(), name: req.body?.name || 'Group', cases: [] };
    data.push(grp);
    tcSave(req, data);
    res.json({ ok: true, group: grp, status: 'group-added' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/add', async (req, res) => {
  try {
    const data  = tcLoad(req);
    const grpIdx = req.body?.groupIndex ?? 0;
    const tc    = { id: crypto.randomUUID(), name: req.body?.name || 'Test', steps: [] };
    if (data[grpIdx]) {
      if (!data[grpIdx].cases) data[grpIdx].cases = [];
      data[grpIdx].cases.push(tc);
    }
    tcSave(req, data);
    res.json({ ok: true, testCase: tc, status: 'testcase-added' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/select', async (req, res) => {
  try {
    res.json({ ok: true, status: 'testcase-selected' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/save-current', async (req, res) => {
  try {
    res.json({ ok: true, status: 'current-saved' });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/save-csv', (req, res) => {
  try {
    const { path: relPath, csvText } = req.body || {};
    if (!relPath || typeof csvText !== 'string') return res.status(400).json({ ok: false, error: 'path and csvText required' });
    const full = path.resolve(scenariosDir, relPath);
    if (!full.startsWith(scenariosDir)) return res.status(400).json({ ok: false, error: 'Invalid path' });
    // Write UTF-8 with BOM so Excel and Korean tools read it correctly
    fs.writeFileSync(full, '﻿' + csvText, 'utf8');
    res.json({ ok: true });
  } catch (e) { wErr(res, e); }
});

router.post('/testcases/delete', async (req, res) => {
  try {
    const data  = tcLoad(req);
    const { groupIndex, testCaseIndex } = req.body || {};
    if (testCaseIndex !== undefined && data[groupIndex]?.cases) {
      data[groupIndex].cases.splice(testCaseIndex, 1);
    } else if (groupIndex !== undefined) {
      data.splice(groupIndex, 1);
    }
    tcSave(req, data);
    res.json({ ok: true, status: 'deleted' });
  } catch (e) { wErr(res, e); }
});

// ── App / Sequence status ─────────────────────────────────────────────────────
router.get('/app/status', async (req, res) => {
  try {
    res.json({ ok: true, selectedTabIndex: 0, sequenceCount: seqLoad(req).length });
  } catch (e) { wErr(res, e); }
});

router.get('/sequence/status', async (req, res) => {
  try {
    const items = seqLoad(req).map((ev, i) => ({
      index:       i,
      kind:        'Event',
      name:        ev.name || ev.eventType || 'event',
      protocol:    ev.protocol || '',
      description: ev.label || ev.description || '',
      isChecked:   true,
    }));
    res.json({ ok: true, items });
  } catch (e) { wErr(res, e); }
});

router.get('/sequence/full', async (req, res) => {
  try {
    const items = seqLoad(req).map((ev, i) => ({ index: i, ...ev }));
    res.json({ ok: true, items });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/run', async (req, res) => {
  try {
    const items = seqLoad(req);
    if (!items.length) return res.json({ ok: false, error: 'Sequence is empty' });
    // Run sequence as an autoEngine test
    const syntheticTc = [{ id: '__sequence__', name: '__sequence__', steps: items }];
    const file = path.join(req.app.locals.testsDir, 'test-cases.json');
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const existing = saved.findIndex(t => t.id === '__sequence__');
    if (existing >= 0) saved[existing] = syntheticTc[0]; else saved.push(syntheticTc[0]);
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    req.app.locals.autoEngine.runTest('__sequence__').catch(() => {});
    res.json({ ok: true, status: 'started' });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/event/add', async (req, res) => {
  try {
    const items = seqLoad(req);
    items.push(req.body || {});
    seqSave(req, items);
    res.json({ ok: true, status: 'event-added', index: items.length - 1 });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/event/remove', async (req, res) => {
  try {
    const items = seqLoad(req);
    const idx   = req.body?.index ?? -1;
    if (idx >= 0 && idx < items.length) items.splice(idx, 1);
    seqSave(req, items);
    res.json({ ok: true, status: 'event-removed' });
  } catch (e) { wErr(res, e); }
});

router.post('/sequence/events/clear', async (req, res) => {
  try {
    seqSave(req, []);
    res.json({ ok: true, status: 'events-cleared' });
  } catch (e) { wErr(res, e); }
});

// ── Ports link status — uses MDIO via register ────────────────────────────────
router.get('/ports/link-status', async (req, res) => {
  try {
    return res.redirect(307, '/api/mdio/link-status');
  } catch (e) { wErr(res, e); }
});

// ── POST /api/testcases/branch-rows ──────────────────────────────────────────
// body: { file, scenarioId, tcId, value }
// Loads a branch CSV and returns rows matching scenarioId + tcId + value
router.post('/testcases/branch-rows', (req, res) => {
  try {
    const { file, scenarioId, tcId, value } = req.body || {};
    if (!file) return res.status(400).json({ ok: false, error: 'file required' });

    const full = path.resolve(scenariosDir, file);
    if (!full.startsWith(scenariosDir)) return res.status(400).json({ ok: false, error: 'Invalid path' });
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: `Branch file not found: ${file}` });

    const rows = parseCsvRows(readCsvText(full));
    const filtered = rows.filter(r => {
      const sid = String(r['Test_Scenario_ID'] || r['Scenario_ID'] || '').trim();
      const tid = String(r['TC_ID'] || '').trim();
      const val = String(r['Value'] || r['value'] || '').trim().toLowerCase();
      const matchSid = !scenarioId || sid === String(scenarioId);
      const matchTid = !tcId      || tid === String(tcId);
      const matchVal = !value     || val === String(value).toLowerCase();
      return matchSid && matchTid && matchVal;
    });

    // Index 컬럼 기준 정렬
    filtered.sort((a, b) => {
      const ia = parseInt(a['Index'] || a['index'] || '0') || 0;
      const ib = parseInt(b['Index'] || b['index'] || '0') || 0;
      return ia - ib;
    });

    res.json({ ok: true, rows: filtered, count: filtered.length });
  } catch (e) { wErr(res, e); }
});

module.exports = router;
