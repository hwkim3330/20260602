const $ = (id) => document.getElementById(id);

const state = {
  interfaces: [],
  captureInterfaces: new Set(),
  captureInterfacesB: new Set(),
  captureRows: [],
  captureIfaceFilter: new Set(), // empty = show all
  captureTimer: null,
  serialTimer: null,
  serialConnected: false,
  // packet generator
  packets: [],
  selectedPacketIdx: -1,
  selectedBlockType: null,
  selectedBlockIdx: -1,
  lastFrameHex: '',
  layerRanges: new Map(),
  // TC mode
  tcPackets: [],
  tcActivePath: '',
  tcOriginalRefs: new Set(),
  activeList: 'pg',  // 'pg' | 'tc'
  // scenario
  tcGroups: [],
  tcSeqList: [],
  selectedTcSeqIdx: -1,
  selectedSeqTcIdx: -1,
  tcNextPacketIdx: 0,
  tcNextFrameRef: 0,
  seqItems: [],
  seqOriginalItems: [],
  seqItemHeaders: [],
  selectedSeqRowIdx: -1,
  editingSeqRowIdx: -1,
  seqRenderMode: 'csv',
  seqRunning: false,
  sendRunning: false,
  _runAbort: false,
  portmapRemoteIfaces: [],
  portmap: [],       // loaded portmap entries (all 6 ports)
  allIfaces: [],     // merged local + remote ifaces for scenario selects
};

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'info') {
  const tray = $('toastTray');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  tray.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function setStatus(text, ok = true) {
  const s = $('status'); if (s) s.textContent = text;
  const dot = $('serverState'); if (dot) dot.classList.toggle('bad', !ok);
}

// "Port 0", "Port 1" 등의 포트 이름을 portmap에서 실제 NIC 이름으로 변환
function _resolveIfaceValue(val) {
  if (!val || val === '-') return '';
  const m = String(val).match(/^port\s*(\d+)$/i);
  if (!m) return val; // 직접 NIC 이름인 경우 그대로 반환
  const portIdx = parseInt(m[1]);
  const entry = state.portmap.find(e => Number(e.port) === portIdx);
  return entry?.iface || '';
}

// Build merged local+remote interface list used by scenario lab selects
function buildAllIfaces() {
  const local  = state.interfaces.map(i => ({ name: i.name, state: i.state, nodeUrl: null, label: 'Local' }));
  const remote = state.portmap
    .filter(e => e.nodeUrl && e.iface)
    .map(e => {
      const ri = state.portmapRemoteIfaces.find(r => r.name === e.iface);
      return { name: e.iface, state: ri?.state || 'up', nodeUrl: e.nodeUrl, label: 'Node B' };
    })
    .filter((e, i, a) => a.findIndex(x => x.name === e.name && x.nodeUrl === e.nodeUrl) === i); // dedupe
  state.allIfaces = [...local, ...remote];
  populateInterfaceSelects();
}

// Returns <optgroup>-grouped HTML for scenario iface selects
function _ifaceSelectOpts(cur) {
  const locals  = state.allIfaces.filter(i => !i.nodeUrl);
  const remotes = state.allIfaces.filter(i =>  i.nodeUrl);
  let html = '<option value="">-- iface --</option>';
  if (locals.length) {
    html += `<optgroup label="Local">` +
      locals.map(i => `<option value="${esc(i.name)}"${i.name===cur?' selected':''}>${esc(i.name)}${i.state==='up'?' ●':''}</option>`).join('') +
      `</optgroup>`;
  }
  if (remotes.length) {
    html += `<optgroup label="Node B">` +
      remotes.map(i => `<option value="${esc(i.name)}"${i.name===cur?' selected':''}>${esc(i.name)} ●</option>`).join('') +
      `</optgroup>`;
  }
  return html;
}

function populateInterfaceSelects() {
  // scInterface global selector — all ifaces (local + remote)
  const scSel = $('scInterface');
  if (scSel) scSel.innerHTML = _ifaceSelectOpts(scSel.value);

  // per-packet interface selects (PG tab) — local + Node B
  document.querySelectorAll('.pkt-iface-sel').forEach(sel => {
    const idx = Number(sel.dataset.idx);
    const cur = getActivePackets()[idx]?.interface || '';
    sel.innerHTML = _ifaceSelectOpts(cur);
    sel.value = cur;
  });
  // per-row interface selects (scenario sequence table) — all ifaces
  const seqRows = _getSeqRows();
  document.querySelectorAll('.sc-row-iface-sel').forEach(sel => {
    const rowIdx = Number(sel.dataset.rowIdx);
    const seqRow = seqRows[rowIdx];
    if (!seqRow) return;
    // Interface 컬럼에서 _iface 미설정 시 portmap 로드 후 늦은 해석
    if (!seqRow._iface) {
      const ifaceVal = seqRow['Interface'] || '';
      if (ifaceVal && ifaceVal !== '-') seqRow._iface = _resolveIfaceValue(ifaceVal);
    }
    const cur = seqRow._iface || '';
    sel.innerHTML = _ifaceSelectOpts(cur);
    sel.value = cur;
  });
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function tsNow() {
  const d = new Date();
  return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}]`;
}

function pad2(n) { return String(n).padStart(2,'0'); }

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      $(tab.dataset.view)?.classList.add('active');
      if (tab.dataset.view === 'hyperTermView') refreshSerialStatus();
      if (tab.dataset.view === 'packetGenView') {
        if (!state.portmap.length) _loadPortmapSilent();
        renderPacketList();
        updateTcUI();
      }
      if (tab.dataset.view === 'scenarioView') {
        const seqListActive = state.selectedSeqTcIdx >= 0 && state.selectedSeqTcIdx < state.tcSeqList.length;
        if (!seqListActive && !state.selectedCsvPath) {
          // Nothing selected in TEST CASES list — clear sequence panel
          state.selectedSeqTcIdx = -1;
          state.seqItems = [];
          const tbody = $('sequenceRows');
          if (tbody) tbody.innerHTML = '';
          const titleEl = $('scDetailTitle');
          if (titleEl) titleEl.textContent = 'TEST SEQUENCE — (select a TC)';
          $('csvTree')?.querySelectorAll('.csv-leaf, .csv-root-item')?.forEach(e => e.classList.remove('selected'));
        } else if (seqListActive) {
          // tcSeqList TC is selected — re-render its rows in case they changed
          const tc = state.tcSeqList[state.selectedSeqTcIdx];
          if (tc) renderCsvSequence(tc.rows || []);
        } else {
          // selectedCsvPath is set (TC selected in csv tree or loaded via PG dropdown)
          renderCsvSequence(state.seqItems);
        }
        loadCsvTree();
        // Ensure remote ifaces are available for interface selects
        if (!state.portmap.length) _loadPortmapSilent();
      }
      if (tab.dataset.view !== 'hyperTermView') {
        if (_intrPollTimer) { clearInterval(_intrPollTimer); _intrPollTimer = null; const b = $('rv-intr-raw-poll'); if (b) { b.textContent = '▶ Poll'; b.className = 'small'; } }
      }
      if (tab.dataset.view === 'settingsView') loadPortMap();
    });
  });
}

// ── Interfaces ────────────────────────────────────────────────────────────────
async function refreshInterfaces() {
  try {
    const data = await api('/api/interfaces');
    state.interfaces = data.interfaces || [];
    buildAllIfaces();
    await refreshCaptureStatus();
    setStatus(`Connected — ${state.interfaces.length} interfaces`);
  } catch (err) { setStatus(`Interfaces error: ${err.message}`, false); }
}

async function _silentRefreshInterfaces() {
  try {
    const data = await api('/api/interfaces');
    const newIfaces = data.interfaces || [];
    const cur = state.interfaces.map(i => i.name + i.state).join(',');
    const nxt = newIfaces.map(i => i.name + i.state).join(',');
    if (cur !== nxt) {
      state.interfaces = newIfaces;
      buildAllIfaces();
      await refreshCaptureStatus();
    }
  } catch { /* silent */ }
}

async function _loadPortmapSilent() {
  try {
    const data = await api('/api/portmap');
    state.portmap = data.portmap || [];
    const remoteUrl = state.portmap.find(e => e.nodeUrl)?.nodeUrl;
    if (remoteUrl && !state.portmapRemoteIfaces.length) {
      // also fetch remote ifaces if not yet loaded
      const resp = await fetch(`${remoteUrl}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const rd = await resp.json();
        state.portmapRemoteIfaces = rd.interfaces || [];
      }
    }
    buildAllIfaces();
  } catch { /* silent */ }
}

// ── Packet Generator — block model ───────────────────────────────────────────
let _dragBlockIdx = -1;  // index of block being dragged within blockList

const BLOCK_ABBR = { Ethernet:'ETH', VLAN:'VLN', IPv4:'IP4', IPv6:'IP6', TCP:'TCP', UDP:'UDP', ICMP:'ICM', ARP:'ARP', Payload:'PLD' };

const BLOCK_FIELDS = {
  Ethernet: [
    { id:'dstMac',    label:'Dst MAC',    type:'text',   def:'FF:FF:FF:FF:FF:FF' },
    { id:'srcMac',    label:'Src MAC',    type:'text',   def:'00:00:00:00:00:00' },
    { id:'etherType', label:'EtherType',  type:'text',   def:'0x0800' },
  ],
  ARP: [
    { id:'operation', label:'Operation (1=req)', type:'number', def:'1' },
    { id:'senderMac', label:'Sender MAC',         type:'text',   def:'00:00:00:00:00:00' },
    { id:'senderIp',  label:'Sender IP',          type:'text',   def:'0.0.0.0' },
    { id:'targetMac', label:'Target MAC',         type:'text',   def:'00:00:00:00:00:00' },
    { id:'targetIp',  label:'Target IP',          type:'text',   def:'0.0.0.0' },
  ],
  IPv4: [
    { id:'srcIp',    label:'Src IP',    type:'text',   def:'192.168.1.1' },
    { id:'dstIp',    label:'Dst IP',    type:'text',   def:'192.168.1.2' },
    { id:'protocol', label:'Protocol',  type:'text',   def:'udp' },
    { id:'ttl',      label:'TTL',       type:'number', def:'64' },
    { id:'tos',      label:'TOS',       type:'number', def:'0' },
  ],
  ICMP: [
    { id:'icmpType', label:'Type', type:'number', def:'8' },
    { id:'icmpCode', label:'Code', type:'number', def:'0' },
  ],
  TCP: [
    { id:'srcPort', label:'Src Port', type:'number', def:'1234' },
    { id:'dstPort', label:'Dst Port', type:'number', def:'80' },
    { id:'flags',   label:'Flags',    type:'number', def:'2' },
    { id:'seqNum',  label:'Seq #',    type:'number', def:'0' },
    { id:'ackNum',  label:'Ack #',    type:'number', def:'0' },
  ],
  UDP: [
    { id:'srcPort', label:'Src Port', type:'number', def:'12345' },
    { id:'dstPort', label:'Dst Port', type:'number', def:'50000' },
  ],
  VLAN: [
    { id:'vlanId',   label:'VLAN ID',  type:'number', def:'100' },
    { id:'priority', label:'Priority', type:'number', def:'0' },
  ],
  Payload: [
    { id:'mode', label:'Mode (text/hex)', type:'text', def:'text' },
    { id:'data', label:'Data',            type:'text', def:'' },
  ],
};

function makePacket() {
  return {
    id: Date.now() + Math.random(),
    name: `Packet-${state.packets.length}`,
    blocks: [{ type:'Ethernet', dstMac:'FF:FF:FF:FF:FF:FF', srcMac:'00:00:00:00:00:00', etherType:'0x0800' }],
    status: '',
    checked: false,
    interface: '',
  };
}

function renderBlockList(pkt) {
  const list = $('blockList');
  if (!list) return;
  list.innerHTML = '';
  if (!pkt) return;
  pkt.blocks.forEach((block, bi) => {
    const div = document.createElement('div');
    div.className = `proto-block${state.selectedBlockIdx === bi ? ' selected' : ''}`;
    div.dataset.proto = block.type;
    div.draggable = true;
    div.innerHTML = `
      <span class="block-abbr">${BLOCK_ABBR[block.type] || block.type.slice(0,3).toUpperCase()}</span>
      <span class="block-name">${block.type}</span>
      <span class="block-del" title="Remove">✕</span>
      <span class="block-nav">
        <span class="block-nav-l" title="Move left">←</span>
        <span class="block-nav-r" title="Move right">→</span>
      </span>`;
    div.addEventListener('click', e => {
      const cl = e.target.classList;
      if (cl.contains('block-del') || cl.contains('block-nav-l') || cl.contains('block-nav-r') || cl.contains('block-nav')) return;
      selectBlock(bi);
    });
    div.querySelector('.block-del').addEventListener('click', e => { e.stopPropagation(); removeBlockAt(bi); });
    div.querySelector('.block-nav-l').addEventListener('click', e => { e.stopPropagation(); moveBlockLeft(bi); });
    div.querySelector('.block-nav-r').addEventListener('click', e => { e.stopPropagation(); moveBlockRight(bi); });
    // Drag-and-drop reordering within blockList
    div.addEventListener('dragstart', e => {
      _dragBlockIdx = bi; div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(bi));
    });
    div.addEventListener('dragend', () => { div.classList.remove('dragging'); _dragBlockIdx = -1; });
    div.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation(); div.classList.remove('drag-over');
      if (_dragBlockIdx >= 0 && _dragBlockIdx !== bi) {
        const p2 = getActivePackets()[state.selectedPacketIdx]; if (!p2) return;
        const [moved] = p2.blocks.splice(_dragBlockIdx, 1);
        const insertAt = _dragBlockIdx < bi ? bi - 1 : bi;
        p2.blocks.splice(insertAt, 0, moved);
        state.selectedBlockIdx = insertAt;
        state.lastFrameHex = '';
        state.layerRanges = new Map();
        _dragBlockIdx = -1;
        renderBlockList(p2); selectBlock(insertAt);
      } else if (_dragBlockIdx < 0) {
        const proto = e.dataTransfer.getData('proto');
        if (proto) addProtoBlockToPacket(proto);
      }
      _dragBlockIdx = -1;
    });
    list.appendChild(div);
  });
}

function selectBlock(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) return;
  const block = pkt.blocks[bi];
  if (!block) return;
  state.selectedBlockType = block.type;
  state.selectedBlockIdx = bi;
  renderBlockList(pkt);
  renderProtoFields(block);
  const t = $('fieldsTitle'); if (t) t.textContent = `Protocol Fields — ${block.type}`;
  refreshDecodeTree(pkt);
  if (state.lastFrameHex) {
    // Re-highlight cached hex — no need to rebuild the frame
    state.layerRanges = calcLayerRanges(pkt.blocks);
    const range = state.layerRanges.get(block.type);
    const hexEl = $('hexdump');
    if (hexEl) hexEl.innerHTML = renderHexHTML(state.lastFrameHex, range ? range.start : -1, range ? range.end : -1);
  } else {
    previewFrame().catch(() => {});
  }
}

let _previewDebounceTimer = null;
function schedulePreview() {
  clearTimeout(_previewDebounceTimer);
  _previewDebounceTimer = setTimeout(() => previewFrame().catch(() => {}), 150);
}

function renderProtoFields(block) {
  const body = $('protoFieldsBody');
  if (!body) return;
  const fields = BLOCK_FIELDS[block.type] || [];
  if (!fields.length) { body.innerHTML = '<p style="color:var(--muted);font-size:11px;padding:8px;">No configurable fields.</p>'; return; }
  body.innerHTML = fields.map(f => {
    const val = block[f.id] ?? f.def;
    const hFn = FIELD_HINT_FN[f.id];
    const hint = hFn ? hFn(val) : '';
    const hintHtml = hFn
      ? `<span class="field-hint"${hint ? '' : ' style="display:none;"'}>${esc(hint)}</span>`
      : '';
    return `
    <div class="field">
      <label>${esc(f.label)}${hintHtml}</label>
      <input id="pf-${f.id}" type="${f.type}" value="${esc(val)}" placeholder="${esc(f.def)}">
    </div>`;
  }).join('');
  fields.forEach(f => {
    const inp = $(`pf-${f.id}`);
    if (!inp) return;
    inp.addEventListener('input', () => {
      const pkt = getActivePackets()[state.selectedPacketIdx];
      const blk = pkt?.blocks[state.selectedBlockIdx];
      if (blk) {
        blk[f.id] = f.type === 'number' ? (inp.value === '' ? 0 : Number(inp.value)) : inp.value;
        state.lastFrameHex = '';
        state.layerRanges = new Map();
        if (FIELD_HINT_FN[f.id]) {
          const hintSpan = inp.closest('.field')?.querySelector('.field-hint');
          if (hintSpan) {
            const h = FIELD_HINT_FN[f.id](inp.value);
            hintSpan.textContent = h;
            hintSpan.style.display = h ? '' : 'none';
          }
        }
        refreshDecodeTree(pkt);  // instant — no API call needed
        schedulePreview();       // debounced hex dump via API
      }
    });
  });
}

function addProtoBlockToPacket(proto) {
  if (state.selectedPacketIdx < 0) { toast('Add a packet first', 'warn'); return; }
  const pkt = getActivePackets()[state.selectedPacketIdx];
  const defaults = {};
  (BLOCK_FIELDS[proto] || []).forEach(f => { defaults[f.id] = f.type === 'number' ? Number(f.def) : f.def; });
  pkt.blocks.push({ type: proto, ...defaults });
  state.lastFrameHex = '';
  state.layerRanges = new Map();
  renderBlockList(pkt);
  selectBlock(pkt.blocks.length - 1);
  renderPacketList();
}

function removeBlockAt(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) return;
  pkt.blocks.splice(bi, 1);
  state.selectedBlockIdx = Math.min(bi, pkt.blocks.length - 1);
  state.lastFrameHex = '';
  state.layerRanges = new Map();
  if (pkt.blocks.length === 0) { state.selectedBlockIdx = -1; state.selectedBlockType = null; const b = $('protoFieldsBody'); if (b) b.innerHTML = ''; }
  renderBlockList(pkt);
  if (state.selectedBlockIdx >= 0) selectBlock(state.selectedBlockIdx);
  renderPacketList();
}

function moveBlockLeft(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt || bi <= 0) return;
  [pkt.blocks[bi-1], pkt.blocks[bi]] = [pkt.blocks[bi], pkt.blocks[bi-1]];
  if (state.selectedBlockIdx === bi) state.selectedBlockIdx = bi - 1;
  else if (state.selectedBlockIdx === bi - 1) state.selectedBlockIdx = bi;
  renderBlockList(pkt);
  state.lastFrameHex = '';
  previewFrame().catch(() => {});
}

function moveBlockRight(bi) {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt || bi >= pkt.blocks.length - 1) return;
  const tmp = pkt.blocks[bi];
  pkt.blocks[bi] = pkt.blocks[bi + 1];
  pkt.blocks[bi + 1] = tmp;
  if (state.selectedBlockIdx === bi) state.selectedBlockIdx = bi + 1;
  else if (state.selectedBlockIdx === bi + 1) state.selectedBlockIdx = bi;
  renderBlockList(pkt);
  state.lastFrameHex = '';
  previewFrame().catch(() => {});
}

function selectPacket(idx) {
  state.selectedPacketIdx = idx;
  state.selectedBlockType = null;
  state.selectedBlockIdx = -1;
  state.lastFrameHex = '';
  state.layerRanges = new Map();
  const pkt = getActivePackets()[idx];
  renderPacketList();
  renderBlockList(pkt || null);
  const body = $('protoFieldsBody');
  if (body) body.innerHTML = pkt ? '<p style="color:var(--muted);font-size:11px;padding:8px;">Select a block above.</p>' : '';
  const t = $('fieldsTitle'); if (t) t.textContent = 'PROTOCOL FIELDS';
  const hexEl = $('hexdump'); if (hexEl) hexEl.innerHTML = '<span style="color:var(--muted)">No preview.</span>';
  const decEl = $('decodeTree'); if (decEl) decEl.innerHTML = '';
  if (pkt) previewFrame().catch(() => {});
}

function renderPacketList() {
  const tbody = $('packetListRows');
  if (!tbody) return;
  const pkts = getActivePackets();
  const isTc = state.activeList === 'tc';
  if (!pkts.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">${isTc ? 'No packets in TC file.' : 'No packets. Click "Add Packet".'}</td></tr>`;
    return;
  }
  // Build FrameRef → sequence Index map so packet list numbers match the sequence table
  const seqIdxByRef = new Map();
  if (isTc) {
    for (const row of _getSeqRows()) {
      if ((row['EventType'] || '').toLowerCase() === 'packet') {
        const ref = (row['FrameRef'] || '').trim();
        if (ref && row['Index'] !== undefined) seqIdxByRef.set(ref, row['Index']);
      }
    }
  }
  tbody.innerHTML = pkts.map((pkt, i) => {
    const eth  = pkt.blocks.find(b => b.type === 'Ethernet') || {};
    const arp  = pkt.blocks.find(b => b.type === 'ARP')  || {};
    const ipv4 = pkt.blocks.find(b => b.type === 'IPv4') || {};
    const protos = pkt.blocks.map(b => {
      if (b.type === 'Ethernet') {
        const et = b.etherType ? (ETHERTYPE_NAMES[(b.etherType+'').toLowerCase()] || b.etherType) : '0x0800';
        return `ETH(${et})`;
      }
      if (b.type === 'UDP')  return `UDP(${b.srcPort||'?'}→${b.dstPort||'?'})`;
      if (b.type === 'TCP')  return `TCP(${b.srcPort||'?'}→${b.dstPort||'?'})`;
      if (b.type === 'VLAN') return `VLAN(${b.vlanId||100})`;
      return BLOCK_ABBR[b.type] || b.type;
    }).join(' › ');
    const srcTarget = eth.srcMac || arp.senderMac || ipv4.srcIp || '';
    const dstValue  = eth.dstMac || arp.targetMac || ipv4.dstIp || '';
    const res = pkt.status || '';
    const resStyle = res === 'Sent' || res === 'Pass' ? 'color:#44FF88;font-weight:600;'
                   : res === 'ERR'  || res === 'Fail' ? 'color:#FF4444;font-weight:600;'
                   : res === 'Running' ? 'color:#FFCC44;font-weight:600;' : '';
    const totalBytes = (() => {
      const ranges = calcLayerRanges(pkt.blocks);
      let max = 0;
      for (const r of ranges.values()) if (r.end > max) max = r.end;
      return max;
    })();
    const descText = totalBytes > 0 ? `${totalBytes} Byte` : '';
    const displayIdx = isTc ? (seqIdxByRef.get(pkt.name) ?? i + 1) : i;
    return `<tr class="${i === state.selectedPacketIdx ? 'selected' : ''}">
      <td><input type="checkbox" name="pkt-chk" class="pkt-chk" data-idx="${i}" ${pkt.checked ? 'checked' : ''}></td>
      <td>${displayIdx}</td>
      <td>${esc(pkt.name)}</td>
      <td style="font-size:10px;color:var(--muted);">${esc(srcTarget)}</td>
      <td style="font-size:10px;color:var(--muted);">${esc(dstValue)}</td>
      <td style="font-size:10px;">${esc(protos)}</td>
      <td><select name="pkt-iface-${i}" class="pkt-iface-sel small-select" data-idx="${i}" style="width:160px;font-size:10px;">
        ${_ifaceSelectOpts(pkt.interface)}
      </select></td>
      <td style="font-size:10px;color:var(--accent);font-weight:600;">${esc(descText)}</td>
      <td style="font-size:10px;${resStyle}">${esc(res)}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', e => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT' || e.target.closest('select')) return; selectPacket(i); });
  });
  tbody.querySelectorAll('.pkt-chk').forEach(chk => {
    chk.addEventListener('change', e => { e.stopPropagation(); const p = getActivePackets()[Number(chk.dataset.idx)]; if (p) p.checked = chk.checked; });
  });
  tbody.querySelectorAll('.pkt-iface-sel').forEach(sel => {
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const idx = Number(sel.dataset.idx);
      const p = getActivePackets()[idx];
      if (p) p.interface = sel.value;
      updateEstimatedTime();
    });
  });
  updateEstimatedTime();
}

function _sortedByDisplayIdx(pkts) {
  const isTc = state.activeList === 'tc';
  const seqIdxByRef = new Map();
  if (isTc) {
    for (const row of _getSeqRows()) {
      if ((row['EventType'] || '').toLowerCase() === 'packet') {
        const ref = (row['FrameRef'] || '').trim();
        if (ref && row['Index'] !== undefined) seqIdxByRef.set(ref, Number(row['Index']));
      }
    }
  }
  return pkts
    .map((p, i) => ({ p, key: isTc ? (seqIdxByRef.get(p.name) ?? i) : i }))
    .sort((a, b) => a.key - b.key)
    .map(({ p }) => p);
}

function updateEstimatedTime() {}

// Re-sorts state.tcPackets to match the packet event order in the current sequence.
function _syncTcPacketsToSeq() {
  if (state.activeList !== 'tc') return;
  const seqRefs = _getSeqRows()
    .filter(r => (r['EventType'] || '').toLowerCase() === 'packet')
    .map(r => (r['FrameRef'] || '').trim())
    .filter(Boolean);
  const pktByName = new Map(state.tcPackets.map(p => [p.name, p]));
  const ordered = seqRefs.map(ref => pktByName.get(ref)).filter(Boolean);
  const inSeq = new Set(seqRefs);
  for (const p of state.tcPackets) { if (!inSeq.has(p.name)) ordered.push(p); }
  state.tcPackets = ordered;
}

// Resets tcNextFrameRef to (max numeric suffix among current packets) + 1.
function _resetTcNextRef() {
  const ap = getActivePackets();
  let maxRef = -1;
  for (const p of ap) {
    const m = (p.name || '').match(/(\d+)$/);
    if (m) maxRef = Math.max(maxRef, parseInt(m[1], 10));
  }
  state.tcNextFrameRef  = maxRef + 1;
  state.tcNextPacketIdx = ap.length;
}

function addPacket() {
  const ap = getActivePackets();
  const insertAt = state.activeList === 'tc'
    ? (state.selectedPacketIdx >= 0 ? state.selectedPacketIdx + 1 : ap.length)
    : ap.length;
  let newPkt;
  if (state.activeList === 'tc') {
    newPkt = {
      id: Date.now() + Math.random(),
      name: `Packet_${state.tcNextFrameRef++}`,
      originalOrder: 0,
      blocks: [{ type:'Ethernet', dstMac:'FF:FF:FF:FF:FF:FF', srcMac:'00:00:00:00:00:00', etherType:'0x0800' }],
      status: '',
      checked: false,
      interface: '',
    };
    ap.splice(insertAt, 0, newPkt);
    // Insert Packet event row after selected sequence row (or at end), then advance cursor
    const rows = _getSeqRows();
    const seqAt = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
    rows.splice(seqAt, 0, { Index: '', Name: newPkt.name, EventType: 'Packet', MAC: '-', FrameRef: newPkt.name, Timeout: '' });
    state.selectedSeqRowIdx = seqAt;
    _setSeqRows(rows);
    _syncTcPacketsToSeq();
    const newIdx = state.tcPackets.indexOf(newPkt);
    updateEstimatedTime();
    selectPacket(newIdx >= 0 ? newIdx : 0);
  } else {
    newPkt = makePacket();
    ap.push(newPkt);
    updateEstimatedTime();
    selectPacket(insertAt);
  }
  toast('Packet added', 'ok');
}
function deletePacket() {
  if (state.selectedPacketIdx < 0) { toast('No packet selected','warn'); return; }
  const ap = getActivePackets();
  const pkt = ap[state.selectedPacketIdx];
  if (state.activeList === 'tc' && pkt) {
    const rows = _getSeqRows();
    const si = rows.findIndex(r => r['FrameRef'] === pkt.name && (r['EventType'] || '').toLowerCase() === 'packet');
    if (si >= 0) { rows.splice(si, 1); _setSeqRows(rows); }
  }
  ap.splice(state.selectedPacketIdx, 1);
  if (state.activeList === 'tc') _resetTcNextRef();
  updateEstimatedTime();
  selectPacket(Math.min(state.selectedPacketIdx, ap.length - 1));
}
function movePacket(dir) {
  const ap = getActivePackets();
  const i = state.selectedPacketIdx, j = i + dir;
  if (i < 0 || j < 0 || j >= ap.length) return;
  if (state.activeList === 'tc') {
    const pkt = ap[i];
    const rows = _getSeqRows();
    const si = rows.findIndex(r => r['FrameRef'] === ap[i].name && (r['EventType'] || '').toLowerCase() === 'packet');
    const sj = rows.findIndex(r => r['FrameRef'] === ap[j].name && (r['EventType'] || '').toLowerCase() === 'packet');
    if (si >= 0 && sj >= 0) {
      [rows[si], rows[sj]] = [rows[sj], rows[si]];
      _setSeqRows(rows);
      _syncTcPacketsToSeq();
      const newIdx = state.tcPackets.indexOf(pkt);
      state.selectedPacketIdx = newIdx >= 0 ? newIdx : j;
      renderPacketList();
      renderBlockList(state.tcPackets[state.selectedPacketIdx]);
    }
    return;
  }
  [ap[i], ap[j]] = [ap[j], ap[i]];
  state.selectedPacketIdx = j;
  renderPacketList();
  renderBlockList(ap[j]);
}
function duplicatePacket() {
  const ap  = getActivePackets();
  const pkt = ap[state.selectedPacketIdx];
  if (!pkt) { toast('No packet selected','warn'); return; }
  const c = JSON.parse(JSON.stringify(pkt));
  c.id = Date.now() + Math.random();
  c.status = '';
  if (state.activeList === 'tc') {
    c.name = `Packet_${state.tcNextFrameRef++}`;
    c.originalOrder = state.tcNextPacketIdx++;
    ap.splice(state.selectedPacketIdx + 1, 0, c);
    const rows = _getSeqRows();
    const seqAt = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
    rows.splice(seqAt, 0, { Index: '', Name: c.name, EventType: 'Packet', MAC: '-', FrameRef: c.name, Timeout: '' });
    state.selectedSeqRowIdx = seqAt;
    _setSeqRows(rows);
    _syncTcPacketsToSeq();
    const newIdx = state.tcPackets.indexOf(c);
    updateEstimatedTime();
    selectPacket(newIdx >= 0 ? newIdx : state.selectedPacketIdx + 1);
    toast('Packet duplicated', 'ok');
    return;
  } else {
    const existingNames = new Set(ap.map(p => p.name));
    let n = 1;
    while (existingNames.has(`${pkt.name} (${n})`)) n++;
    c.name = `${pkt.name} (${n})`;
    ap.splice(state.selectedPacketIdx + 1, 0, c);
  }
  updateEstimatedTime();
  selectPacket(state.selectedPacketIdx + 1);
  toast('Packet duplicated', 'ok');
}

function deleteSelectedPackets() {
  const ap = getActivePackets();
  const filtered = ap.filter(p => !p.checked);
  const removed  = ap.length - filtered.length;
  if (!removed) { toast('No packets checked', 'warn'); return; }
  if (state.activeList === 'tc') {
    // Remove seq rows for each deleted packet
    const deletedNames = new Set(ap.filter(p => p.checked).map(p => p.name));
    const rows = _getSeqRows().filter(r => !(deletedNames.has(r['FrameRef']) && (r['EventType'] || '').toLowerCase() === 'packet'));
    _setSeqRows(rows);
  }
  setActivePackets(filtered);
  if (state.activeList === 'tc') _resetTcNextRef();
  state.selectedPacketIdx = Math.min(state.selectedPacketIdx, filtered.length - 1);
  if (filtered.length === 0) selectPacket(-1);
  else selectPacket(state.selectedPacketIdx);
  updateEstimatedTime();
  toast(`Deleted ${removed} packet(s)`, 'ok');
}

function deleteAllPackets() {
  if (!getActivePackets().length) return;
  if (!confirm('Delete all packets?')) return;
  if (state.activeList === 'tc') {
    // Remove all Packet event rows from sequence
    const rows = _getSeqRows().filter(r => (r['EventType'] || '').toLowerCase() !== 'packet');
    _setSeqRows(rows);
    state.tcNextFrameRef  = 0;
    state.tcNextPacketIdx = 0;
  }
  setActivePackets([]);
  state.selectedPacketIdx = -1;
  selectPacket(-1);
  updateEstimatedTime();
  toast('All packets deleted', 'ok');
}

function _pktSendUrl(ifaceName) {
  const entry = state.allIfaces.find(i => i.name === ifaceName && i.nodeUrl);
  return entry ? `${entry.nodeUrl}/api/send` : '/api/send';
}

function buildPacketPayload(pkt) {
  const blocks   = pkt?.blocks || [];
  const iface    = pkt.interface || '';
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const eth      = blocks.find(b => b.type === 'Ethernet') || {};
  const ipv4B    = blocks.find(b => b.type === 'IPv4');
  const tcpB     = blocks.find(b => b.type === 'TCP');
  const udpB     = blocks.find(b => b.type === 'UDP');
  const icmpB    = blocks.find(b => b.type === 'ICMP');
  const arpB     = blocks.find(b => b.type === 'ARP');
  const vlanB    = blocks.find(b => b.type === 'VLAN');
  const plB      = blocks.find(b => b.type === 'Payload') || {};
  // Determine frame protocol — 'ipv4' = IPv4 header present but no transport layer block
  let protocol = 'raw';
  if (ipv4B)  protocol = 'ipv4';
  if (udpB)   protocol = 'udp';
  if (tcpB)   protocol = 'tcp';
  if (icmpB)  protocol = 'icmp';
  if (arpB)   protocol = 'arp';
  // Map IPv4 block's protocol text field → IP protocol number (used for raw IPv4 frames)
  const ipv4Proto = (() => {
    const s = ((ipv4B?.protocol) || '').toLowerCase();
    if (s === 'udp')  return 17;
    if (s === 'tcp')  return 6;
    if (s === 'icmp') return 1;
    const n = parseInt(s);
    return isNaN(n) ? 0 : n;
  })();
  const p = {
    protocol, interface: iface,
    dstMac: eth.dstMac || 'FF:FF:FF:FF:FF:FF',
    srcMac: eth.srcMac || '00:00:00:00:00:00',
    etherType: eth.etherType || '0x0800',
    ipv4: {
      src:     (ipv4B?.srcIp)  || '192.168.1.1',
      dst:     (ipv4B?.dstIp)  || '192.168.1.2',
      ttl:     ipv4B?.ttl  != null ? Number(ipv4B.ttl)  : 64,
      tos:     ipv4B?.tos  != null ? Number(ipv4B.tos)  : 0,
      ipProto: ipv4Proto,
    },
    count: 1, intervalMs: periodMs,
    payload: { mode: plB.mode || 'text', data: plB.data || '' },
  };
  if (udpB)  p.udp  = { srcPort: Number(udpB.srcPort) || 12345, dstPort: Number(udpB.dstPort) || 50000 };
  if (tcpB)  p.tcp  = { srcPort: Number(tcpB.srcPort) || 1234, dstPort: Number(tcpB.dstPort) || 80,
                         flags: Number(tcpB.flags) || 2, seq: Number(tcpB.seqNum) || 0, ack: Number(tcpB.ackNum) || 0 };
  if (icmpB) p.icmp = { type: Number(icmpB.icmpType) || 8, code: Number(icmpB.icmpCode) || 0 };
  if (arpB)  p.arp  = { operation: Number(arpB.operation) || 1,
                         senderMac: arpB.senderMac || '00:00:00:00:00:00',
                         senderIp:  arpB.senderIp  || '0.0.0.0',
                         targetMac: arpB.targetMac || '00:00:00:00:00:00',
                         targetIp:  arpB.targetIp  || '0.0.0.0' };
  if (vlanB) p.vlan = { enabled: true, id: Number(vlanB.vlanId) || 100, priority: Number(vlanB.priority) || 0 };
  p.blocks = blocks;
  return p;
}

function buildProfile() {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  return pkt ? buildPacketPayload(pkt) : { protocol:'udp', interface:'', dstMac:'FF:FF:FF:FF:FF:FF', srcMac:'00:00:00:00:00:00', srcIp:'192.168.1.1', dstIp:'192.168.1.2', udp:{srcPort:12345,dstPort:50000}, count:1, intervalMs:0, payload:{mode:'text',data:''} };
}

// ── Hex / Decode helpers ──────────────────────────────────────────────────────

function getBlockSize(block) {
  switch (block.type) {
    case 'Ethernet': return 14;
    case 'VLAN':     return 4;
    case 'ARP':      return 28;
    case 'IPv4':     return 20;
    case 'TCP':      return 20;
    case 'UDP':      return 8;
    case 'ICMP':     return 8;
    case 'Payload': {
      const d = block.data || '';
      if ((block.mode || 'text') === 'hex') return Math.floor(d.replace(/[\s:]/g, '').length / 2);
      return new TextEncoder().encode(d).length;
    }
    default: return 0;
  }
}

function calcLayerRanges(blocks) {
  const map = new Map();
  let off = 0;
  for (const block of (blocks || [])) {
    const size = getBlockSize(block);
    if (size > 0) {
      map.set(block.type, { start: off, end: off + size });
      off += size;
    }
  }
  return map;
}

function renderHexHTML(hex, hiStart, hiEnd) {
  if (!hex) return '<span style="color:var(--muted)">No data.</span>';
  const bytes = hex.match(/.{1,2}/g) || [];
  const hi = (i) => hiStart >= 0 && i >= hiStart && i < hiEnd;
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);

    // Wireshark style: left 8 bytes, 2-space gap, right 8 bytes
    const makeHexHalf = (start, end) => {
      const parts = [];
      for (let j = start; j < end; j++) {
        if (j < chunk.length) {
          const cls = hi(off + j) ? ' class="hex-hi"' : '';
          parts.push(`<span${cls}>${chunk[j]}</span>`);
        } else {
          parts.push('  '); // placeholder keeps column width fixed
        }
      }
      return parts.join(' ');
    };

    // ASCII: insert a space gap after the 8th character
    // Use a safe lookup table instead of esc() to avoid multi-char HTML entities
    // that would break monospace column alignment
    const ASCII_SAFE = { 38:'&amp;', 60:'&lt;', 62:'&gt;' }; // & < >
    const asciiParts = [];
    for (let j = 0; j < chunk.length; j++) {
      if (j === 8) asciiParts.push(' ');
      const n = parseInt(chunk[j], 16);
      const ch = n >= 32 && n <= 126 ? (ASCII_SAFE[n] ?? String.fromCharCode(n)) : '.';
      const cls = hi(off + j) ? ' class="hex-hi"' : '';
      asciiParts.push(`<span${cls}>${ch}</span>`);
    }

    lines.push(
      `<span class="hex-off">${off.toString(16).padStart(4, '0')}</span>  ` +
      makeHexHalf(0, 8) + '  ' + makeHexHalf(8, 16) + '  ' +
      `<span class="hex-ascii">${asciiParts.join('')}</span>`
    );
  }
  return lines.join('\n');
}

function buildDecodeTreeDOM(container, obj, depth) {
  depth = depth || 0;
  if (typeof obj !== 'object' || obj === null) return;
  for (const [k, v] of Object.entries(obj)) {
    const isNode = typeof v === 'object' && v !== null && !Array.isArray(v);
    if (isNode) {
      const wrapper = document.createElement('div');
      const header  = document.createElement('div');
      header.className = 'dt-node';
      header.style.paddingLeft = `${depth * 14}px`;
      header.innerHTML = `<span class="dt-toggle">▾</span> <span class="dt-node-key">${esc(k)}</span>`;
      const children = document.createElement('div');
      children.className = 'dt-children';
      buildDecodeTreeDOM(children, v, depth + 1);
      header.addEventListener('click', () => {
        const open = children.style.display !== 'none';
        children.style.display = open ? 'none' : '';
        header.querySelector('.dt-toggle').textContent = open ? '▸' : '▾';
      });
      wrapper.appendChild(header);
      wrapper.appendChild(children);
      container.appendChild(wrapper);
    } else {
      const item = document.createElement('div');
      item.className = 'dt-leaf';
      item.style.paddingLeft = `${depth * 14 + 16}px`;
      const val = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
      item.innerHTML = `<span class="dt-leaf-key">${esc(k)}</span>: <span class="dt-leaf-val">${esc(val)}</span>`;
      container.appendChild(item);
    }
  }
}

// ── Hex / Decode ──────────────────────────────────────────────────────────────
function decodeHexBasic(hex) {
  if (!hex || hex.length < 28) return null;
  const b = hex.match(/.{1,2}/g).map(x => parseInt(x, 16));
  if (b.length < 14) return null;
  const eth = {
    dstMac: b.slice(0,6).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
    srcMac: b.slice(6,12).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
    etherType: `0x${b[12].toString(16).padStart(2,'0').toUpperCase()}${b[13].toString(16).padStart(2,'0').toUpperCase()}`,
  };
  const etherType = (b[12] << 8) | b[13];
  const tree = { Ethernet: eth };
  if (etherType === 0x0806 && b.length >= 42) {
    tree.ARP = {
      operation: (b[20]<<8)|b[21],
      senderMAC: b.slice(22,28).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
      senderIP:  b.slice(28,32).join('.'),
      targetMAC: b.slice(32,38).map(x=>x.toString(16).padStart(2,'0').toUpperCase()).join(':'),
      targetIP:  b.slice(38,42).join('.'),
    };
  } else if (etherType === 0x0800 && b.length >= 34) {
    const ihl = (b[14] & 0x0F) * 4;
    const proto = b[23];
    tree.IPv4 = { src: b.slice(26,30).join('.'), dst: b.slice(30,34).join('.'), protocol: proto, ttl: b[22], tos: b[21] };
    const u = 14 + ihl;
    if (proto === 17 && b.length >= u + 8)  tree.UDP  = { srcPort: (b[u]<<8)|b[u+1], dstPort: (b[u+2]<<8)|b[u+3] };
    else if (proto === 6 && b.length >= u + 20) tree.TCP  = { srcPort: (b[u]<<8)|b[u+1], dstPort: (b[u+2]<<8)|b[u+3] };
    else if (proto === 1 && b.length >= u + 4)  tree.ICMP = { type: b[u], code: b[u+1] };
  }
  return tree;
}

function formatHex(hex) {
  if (!hex) return '';
  const bytes = hex.match(/.{1,2}/g) || [];
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const h1 = chunk.slice(0, 8).join(' ');
    const h2 = chunk.slice(8).join(' ');
    const hexPart = (h1 + (chunk.length > 8 ? '  ' + h2 : '')).padEnd(49);
    const ascii = chunk.map((b, i) => {
      const n = parseInt(b, 16);
      const c = n >= 32 && n <= 126 ? String.fromCharCode(n) : '.';
      return i === 8 ? ' ' + c : c;
    }).join('');
    lines.push(`${off.toString(16).padStart(4,'0')}  ${hexPart}  ${ascii}`);
  }
  return lines.join('\n');
}

function renderDecodeTree(obj, depth = 0) {
  if (typeof obj !== 'object' || obj === null) return `${obj}`;
  return Object.entries(obj).map(([k, v]) => {
    const indent = '  '.repeat(depth);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return `${indent}▸ ${k}\n${renderDecodeTree(v, depth+1)}`;
    const val = Array.isArray(v) ? `[${v.join(', ')}]` : String(v);
    return `${indent}  ${k}: ${val}`;
  }).join('\n');
}

function decodeFromBlocks(blocks) {
  const tree = {};
  for (const block of (blocks || [])) {
    switch (block.type) {
      case 'Ethernet':
        tree.Ethernet = { dstMac: block.dstMac, srcMac: block.srcMac, etherType: block.etherType };
        break;
      case 'VLAN':
        tree.VLAN = { id: block.vlanId ?? 100, priority: block.priority ?? 0 };
        break;
      case 'ARP':
        tree.ARP = { operation: block.operation ?? 1,
                     senderMac: block.senderMac, senderIp: block.senderIp,
                     targetMac: block.targetMac, targetIp: block.targetIp };
        break;
      case 'IPv4':
        tree.IPv4 = { src: block.srcIp, dst: block.dstIp,
                      ttl: block.ttl ?? 64, tos: block.tos ?? 0,
                      protocol: block.protocol || 0 };
        break;
      case 'TCP':
        tree.TCP = { srcPort: block.srcPort ?? 1234, dstPort: block.dstPort ?? 80,
                     flags: block.flags ?? 2, seqNum: block.seqNum ?? 0, ackNum: block.ackNum ?? 0 };
        break;
      case 'UDP':
        tree.UDP = { srcPort: block.srcPort ?? 12345, dstPort: block.dstPort ?? 50000 };
        break;
      case 'ICMP':
        tree.ICMP = { type: block.icmpType ?? 8, code: block.icmpCode ?? 0 };
        break;
      case 'Payload':
        tree.Payload = { mode: block.mode || 'text', data: block.data || '' };
        break;
    }
  }
  return Object.keys(tree).length ? tree : null;
}

function refreshDecodeTree(pkt) {
  const decEl = $('decodeTree');
  if (!decEl) return;
  decEl.innerHTML = '';
  if (!pkt) return;
  const decoded = decodeFromBlocks(pkt.blocks);
  if (decoded) buildDecodeTreeDOM(decEl, decoded);
  else decEl.textContent = 'No decode.';
}

async function previewFrame() {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) { toast('Select a packet first', 'warn'); return; }
  // Decode tree: rebuilt from block model immediately (no API round-trip needed)
  refreshDecodeTree(pkt);
  try {
    const data = await api('/api/build', { method:'POST', body: JSON.stringify(buildPacketPayload(pkt)) });
    const out = data.stdout || data;
    const hex = out.frameHex || out.hex || '';
    state.lastFrameHex = hex;
    state.layerRanges = calcLayerRanges(pkt.blocks);

    const selBlock = pkt.blocks[state.selectedBlockIdx];
    const range    = selBlock ? state.layerRanges.get(selBlock.type) : null;
    const hiStart  = range ? range.start : -1;
    const hiEnd    = range ? range.end   : -1;

    const hexEl = $('hexdump');
    if (hexEl) hexEl.innerHTML = renderHexHTML(hex, hiStart, hiEnd);
  } catch (err) { toast(`Build failed: ${err.message}`, 'bad'); }
}

async function sendFrame() {
  const pkt = getActivePackets()[state.selectedPacketIdx];
  if (!pkt) { toast('Select a packet first', 'warn'); return; }
  const iface = pkt.interface || '';
  if (!iface) { toast('Select a sender interface first', 'warn'); return; }
  try {
    const p = buildPacketPayload(pkt);
    const data = await api(_pktSendUrl(iface), { method:'POST', body: JSON.stringify(p) });
    const out = data.stdout || data;
    toast(`Sent ${out.framesSent || 1} frame(s), ${out.bytesSent || '?'} bytes`, 'ok');
    pkt.status = 'Sent'; renderPacketList();
  } catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}

let _pgListRunning = false;
let _pgSelRunning  = false;
let _pgAbort       = false;

async function sendSelectedPackets() {
  if (_pgSelRunning) { _pgAbort = true; return; }
  // Sort checked packets by ascending display-index order
  const sel = _sortedByDisplayIdx(getActivePackets()).filter(p => p.checked);
  if (!sel.length) { toast('Check at least one packet', 'warn'); return; }
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const repeat   = $('pgRepeat')?.checked || false;
  // periodMs = total cycle time; spread evenly across all selected packets
  _pgSelRunning = true; _pgAbort = false;
  const selBtn = $('pgSendSelected');
  if (selBtn) { selBtn.textContent = '■ Stop'; selBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; }
  const pgSpinner = $('pgSpinner');
  if (pgSpinner) pgSpinner.style.display = 'inline-block';
  const selStats = $('pgStatsText');
  const t0sel = new Date();

  let totalSent = 0, totalAttempts = 0, cycle = 0;
  do {
    cycle++;
    if (selStats) selStats.textContent = `시작: ${t0sel.toLocaleTimeString()} | 종료: — | 주기: ${cycle} | 전송 중…`;
    for (let i = 0; i < sel.length; i++) {
      if (_pgAbort) break;
      const pkt = sel[i];
      if (!pkt.interface) { pkt.status = 'ERR'; toast(`Packet "${pkt.name}": 인터페이스 미설정`, 'bad'); renderPacketList(); continue; }
      try {
        pkt.status = 'Running'; renderPacketList();
        await api(_pktSendUrl(pkt.interface), { method:'POST', body: JSON.stringify(buildPacketPayload(pkt)) });
        pkt.status = 'Sent'; totalSent++;
      } catch (err) { pkt.status = 'ERR'; toast(`Send failed: ${err.message}`, 'bad'); }
      totalAttempts++;
      renderPacketList();
      if (periodMs > 0 && !_pgAbort) await new Promise(r => setTimeout(r, periodMs));
    }
    if (_pgAbort) break;
  } while (repeat && !_pgAbort);

  _pgSelRunning = false; _pgAbort = false;
  if (selBtn) { selBtn.textContent = '▶ Send Selected'; selBtn.style.cssText = ''; }
  if (pgSpinner) pgSpinner.style.display = 'none';
  if (selStats) selStats.textContent = `시작: ${t0sel.toLocaleTimeString()} | 종료: ${new Date().toLocaleTimeString()} | 주기: ${cycle} | 전송: ${totalSent}/${totalAttempts}개`;
  toast(`Send Selected: ${totalSent}/${totalAttempts} 완료`, totalSent === totalAttempts ? 'ok' : 'warn');
}

async function sendPacketList() {
  if (_pgListRunning) { _pgAbort = true; return; }
  // Always send in ascending display-index order
  const activePkts = _sortedByDisplayIdx(getActivePackets());
  if (!activePkts.length) { toast('No packets in list', 'warn'); return; }
  const periodMs = parseInt($('pgPeriod')?.value) || 0;
  const repeat   = $('pgRepeat')?.checked || false;
  _pgListRunning = true; _pgAbort = false;
  const listBtn = $('pgSendList');
  if (listBtn) { listBtn.textContent = '■ Stop'; listBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; }
  const pgSpinnerL = $('pgSpinner');
  if (pgSpinnerL) pgSpinnerL.style.display = 'inline-block';
  const listStats = $('pgStatsText');
  const t0list = new Date();

  let totalSent = 0, totalAttempts = 0, cycle = 0;
  do {
    cycle++;
    if (listStats) listStats.textContent = `시작: ${t0list.toLocaleTimeString()} | 종료: — | 주기: ${cycle} | 전송 중…`;
    for (let i = 0; i < activePkts.length; i++) {
      if (_pgAbort) break;
      const pkt = activePkts[i];
      if (!pkt.interface) { pkt.status = 'ERR'; toast(`Packet "${pkt.name}": 인터페이스 미설정`, 'bad'); renderPacketList(); continue; }
      try {
        pkt.status = 'Running'; renderPacketList();
        await api(_pktSendUrl(pkt.interface), { method:'POST', body: JSON.stringify(buildPacketPayload(pkt)) });
        pkt.status = 'Sent'; totalSent++;
      } catch (err) { pkt.status = 'ERR'; toast(`Send failed: ${err.message}`, 'bad'); }
      totalAttempts++;
      renderPacketList();
      if (periodMs > 0 && !_pgAbort) await new Promise(r => setTimeout(r, periodMs));
    }
    if (_pgAbort) break;
  } while (repeat && !_pgAbort);

  _pgListRunning = false; _pgAbort = false;
  if (listBtn) { listBtn.textContent = '▶▶ Send List'; listBtn.style.cssText = ''; }
  if (pgSpinnerL) pgSpinnerL.style.display = 'none';
  if (listStats) listStats.textContent = `시작: ${t0list.toLocaleTimeString()} | 종료: ${new Date().toLocaleTimeString()} | 주기: ${cycle} | 전송: ${totalSent}/${totalAttempts}개`;
  toast(`Send List: ${totalSent}/${totalAttempts} 완료`, 'ok');
}

// ── TC Import (Packet Generator) ─────────────────────────────────────────────

const ETHERTYPE_NAMES = { '0x0806':'ARP', '0x0800':'IPv4', '0x86dd':'IPv6', '0x8100':'VLAN', '0x88cc':'LLDP', '0x8847':'MPLS', '0x8848':'MPLS-mcast', '0x88e1':'HomePlug', '0x88f7':'PTP', '0x0842':'WakeOnLAN' };
const ETHERTYPE_FROM_NAME = { 'ARP':'0x0806', 'IPv4':'0x0800', 'IP':'0x0800', 'IPv6':'0x86DD', 'VLAN':'0x8100' };

const IP_PROTO_NAMES = {
  '1':'ICMP','2':'IGMP','4':'IPv4-encap','6':'TCP','8':'EGP','9':'IGP',
  '17':'UDP','41':'IPv6','47':'GRE','50':'ESP','51':'AH','58':'ICMPv6',
  '89':'OSPF','132':'SCTP',
  'tcp':'TCP','udp':'UDP','icmp':'ICMP','icmpv6':'ICMPv6','gre':'GRE',
  'esp':'ESP','ospf':'OSPF','sctp':'SCTP',
};

const ICMP_TYPE_NAMES = {
  '0':'Echo Reply','3':'Dest Unreachable','4':'Source Quench','5':'Redirect',
  '8':'Echo Request','9':'Router Advertisement','10':'Router Solicitation',
  '11':'Time Exceeded','12':'Parameter Problem','13':'Timestamp',
  '14':'Timestamp Reply','15':'Information Request','16':'Information Reply',
  '17':'Address Mask Request','18':'Address Mask Reply',
};

const _PROTO_NUM = { tcp:'6', udp:'17', icmp:'1', icmpv6:'58', gre:'47', esp:'50', ospf:'89', sctp:'132' };

function etherTypeHint(v) {
  const s = (v+'').trim().toLowerCase();
  const n = s.startsWith('0x') ? parseInt(s,16) : parseInt(s);
  if (isNaN(n)) return '';
  const name = ETHERTYPE_NAMES[`0x${n.toString(16).padStart(4,'0')}`];
  return name ? `${name}: 0x${n.toString(16).padStart(4,'0').toUpperCase()}` : '';
}
function ipProtoHint(v) {
  const s = (v+'').trim().toLowerCase();
  const num = _PROTO_NUM[s] ?? (isNaN(parseInt(s)) ? null : String(parseInt(s)));
  if (!num) return '';
  const name = IP_PROTO_NAMES[s] || IP_PROTO_NAMES[num];
  return name ? `${name}: ${num}` : '';
}
function icmpTypeHint(v) {
  const n = parseInt(v);
  const name = ICMP_TYPE_NAMES[String(n)];
  return name ? `${name}: ${n}` : '';
}

const FIELD_HINT_FN = { etherType: etherTypeHint, protocol: ipProtoHint, icmpType: icmpTypeHint };

function normEtherType(v) {
  if (!v) return '0x0800';
  return ETHERTYPE_FROM_NAME[v.toUpperCase().trim()] || v;
}

function getActivePackets() {
  return state.activeList === 'tc' ? state.tcPackets : state.packets;
}

function setActivePackets(list) {
  if (state.activeList === 'tc') state.tcPackets = list;
  else state.packets = list;
}

let _tcDropOpen = false;
// Session-level packet cache: filePath → { tcPackets, tcOriginalRefs, tcNextFrameRef }
const _tcSessionCache = new Map();

function updateTcUI() {
  const closeBtn = $('pgTcClose');
  const tcBtn    = $('pgTcBtn');
  const isTc = state.activeList === 'tc';
  if (closeBtn) closeBtn.style.display = isTc ? '' : 'none';
  if (tcBtn) {
    const name = state.tcActivePath ? state.tcActivePath.split('/').pop().replace(/\.csv$/i,'') : '';
    tcBtn.textContent = _tcDropOpen ? 'TC 선택 ▴' : (isTc ? `TC 선택: ${name} ▾` : 'TC 선택 ▾');
  }
  // In TC mode: disable PG-tab packet management buttons (managed via Scenario Lab)
  ['pgAddPacket','pgDelPacket','pgDupPacket','pgUpPacket','pgDownPacket'].forEach(id => {
    const btn = $(id);
    if (btn) { btn.disabled = isTc; btn.style.opacity = isTc ? '.4' : ''; }
  });
}


async function toggleTcDropdown() {
  _tcDropOpen = !_tcDropOpen;
  const dd = $('pgTcDropdown');
  if (!dd) return;
  if (_tcDropOpen) {
    dd.style.display = '';
    positionTcDropdown();
    await renderTcDropdown();
  } else {
    dd.style.display = 'none';
  }
  updateTcUI();
}

function closeTcDropdown() {
  _tcDropOpen = false;
  const dd = $('pgTcDropdown'); if (dd) dd.style.display = 'none';
  updateTcUI();
}

function positionTcDropdown() {
  const btn = $('pgTcBtn'), dd = $('pgTcDropdown');
  if (!btn || !dd) return;
  const r = btn.getBoundingClientRect();
  dd.style.top  = `${r.bottom + 3}px`;
  dd.style.left = `${r.left}px`;
}

// Packet CSV paths collected at dropdown-open time (for nearest-match lookup)
let _knownPacketCsvPaths = [];

async function renderTcDropdown() {
  const dd = $('pgTcDropdown');
  if (!dd) return;
  dd.innerHTML = '<div class="tc-dd-loading">Loading…</div>';
  try {
    const data = await api('/api/testcases/csv-tree');

    // Collect packet CSV paths (TC_Packets.csv files) for later lookup
    _knownPacketCsvPaths = [];
    function collectPaths(nodes) {
      for (const n of (nodes || [])) {
        if (n.type === 'file' && n.isPacket) _knownPacketCsvPaths.push(n.path);
        else if (n.type === 'dir') collectPaths(n.children);
      }
    }
    collectPaths(data.tree || []);

    // Collect non-packet (scenario) CSVs with folder label (skip root-level files)
    function collectScenarioFiles(nodes, folderLabel) {
      const items = [];
      for (const n of (nodes || [])) {
        if (n.type === 'file' && !n.isPacket && folderLabel) {
          items.push({ ...n, folderLabel });
        } else if (n.type === 'dir') {
          const sub = folderLabel ? `${folderLabel}/${n.name}` : n.name;
          items.push(...collectScenarioFiles(n.children, sub));
        }
      }
      return items;
    }

    const scenarioFiles = collectScenarioFiles(data.tree || [], '');
    if (!scenarioFiles.length) { dd.innerHTML = '<div class="tc-dd-loading">No TC files found.</div>'; return; }

    // Group by folder
    const byFolder = new Map();
    for (const f of scenarioFiles) {
      const key = f.folderLabel || '';
      if (!byFolder.has(key)) byFolder.set(key, []);
      byFolder.get(key).push(f);
    }

    let html = '';
    for (const [folder, files] of byFolder) {
      if (folder) html += `<div class="tc-dd-group"><span class="tc-dd-icon">📁</span>${esc(folder)}</div>`;
      for (const f of files) {
        const active = state.tcActivePath === f.path;
        const indent = folder ? 'padding-left:26px;' : '';
        html += `<div class="tc-dd-item${active?' active':''}" data-path="${esc(f.path)}" style="${indent}">
          <span class="tc-dd-icon">📄</span><span>${esc(f.name)}</span>
          ${active ? '<span class="tc-dd-check">✓</span>' : ''}
        </div>`;
      }
    }

    dd.innerHTML = html;
    dd.querySelectorAll('.tc-dd-item').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedSeqTcIdx = -1;
        selectTcCsv(el.dataset.path);
      });
    });
  } catch (err) {
    dd.innerHTML = `<div class="tc-dd-loading" style="color:var(--red);">Error: ${esc(err.message)}</div>`;
  }
}

// Find the nearest TC_Packets.csv by walking up the directory of filePath
function findNearestPacketCsv(filePath) {
  const dirParts = filePath.split('/').slice(0, -1);
  for (let i = dirParts.length; i >= 0; i--) {
    const prefix = dirParts.slice(0, i).join('/');
    const match = _knownPacketCsvPaths.find(p => {
      const pDir = p.split('/').slice(0, -1).join('/');
      return pDir === prefix;
    });
    if (match) return match;
  }
  return null;
}

function parseTcCsvToPackets(rows, frameRefToIdx) {
  const map = new Map();
  for (const row of rows) {
    const ref = row['FrameRef'] || '';
    if (!ref) continue;
    if (!map.has(ref)) map.set(ref, { name: ref, dstMac: '', srcMac: '', etherType: '0x0800', rawHex: '' });
    const g     = map.get(ref);
    const proto = (row['Protocol'] || '').toUpperCase();
    const field = row['Field'] || '';
    const value = (row['Value'] || '').trim();
    if (proto === 'ETH') {
      if (field === 'Destination MAC') g.dstMac = value;
      else if (field === 'Source MAC')  g.srcMac = value;
      else if (field === 'EtherType')   g.etherType = normEtherType(value);
    } else if (proto === 'RAW') {
      g.rawHex = value.replace(/^0x/i, '');
    }
  }
  return [...map.values()].map((g, i) => {
    // Use scenario CSV Index column value if available, else fall back to FrameRef suffix
    let originalOrder;
    if (frameRefToIdx && frameRefToIdx.has(g.name)) {
      originalOrder = frameRefToIdx.get(g.name);
    } else {
      const m = g.name.match(/(\d+)$/);
      originalOrder = m ? parseInt(m[1], 10) : i;
    }
    return {
      id:           Date.now() + Math.random() + i,
      name:         g.name,
      originalOrder,
      blocks:    [
        { type:'Ethernet', dstMac: g.dstMac||'FF:FF:FF:FF:FF:FF', srcMac: g.srcMac||'00:00:00:00:00:00', etherType: g.etherType },
        ...(g.rawHex ? [{ type:'Payload', mode:'hex', data: g.rawHex }] : []),
      ],
      status:    '',
      checked:   false,
      interface: '',
    };
  });
}

// Persist current TC's sequence + packet state into session cache.
function _saveTcToSessionCache() {
  if (state.activeList === 'tc' && state.tcActivePath) {
    _tcSessionCache.set(state.tcActivePath, {
      seqRows:          [...state.seqItems],
      seqHeaders:       [...state.seqItemHeaders],
      seqOriginalItems: [...state.seqOriginalItems],
      tcPackets:        [...state.tcPackets],
      tcOriginalRefs:   new Set(state.tcOriginalRefs),
      tcNextFrameRef:   state.tcNextFrameRef,
    });
  }
}

async function selectTcCsv(filePath) {
  if (state.tcActivePath === filePath && state.activeList === 'tc') return;

  closeTcDropdown();

  // Save current TC state before switching
  _saveTcToSessionCache();

  // Cache hit: restore everything from session memory
  if (_tcSessionCache.has(filePath)) {
    const c = _tcSessionCache.get(filePath);
    state.seqItems          = c.seqRows;
    state.seqItemHeaders    = c.seqHeaders;
    state.seqOriginalItems  = c.seqOriginalItems ? [...c.seqOriginalItems] : [];
    state.tcPackets         = c.tcPackets;
    state.tcOriginalRefs    = c.tcOriginalRefs;
    state.tcNextFrameRef    = c.tcNextFrameRef;
    state.tcActivePath      = filePath;
    state.activeList        = 'tc';
    state.selectedSeqTcIdx  = -1;
    state.selectedSeqRowIdx = -1;
    state.selectedCsvPath   = filePath;
    const name = filePath.split('/').pop().replace(/\.csv$/i, '');
    const titleEl = $('scDetailTitle');
    if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
    renderCsvSequence(state.seqItems);
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
    toast(`TC: ${name} — ${state.tcPackets.length}개 패킷 (세션)`, 'ok');
    return;
  }

  // Cache miss: first visit — load from disk
  try {
    const tcData = await api(`/api/testcases/csv-content?path=${encodeURIComponent(filePath)}`);
    const tcRows = tcData.rows || [];
    const frameRefs = new Set(
      tcRows
        .filter(r => (r['EventType'] || '').toLowerCase() === 'packet')
        .map(r => (r['FrameRef'] || '').trim())
        .filter(r => r && r !== '-')
    );

    let tcPackets = [];
    const packetsCsvPath = findNearestPacketCsv(filePath);
    if (packetsCsvPath) {
      const pktsData = await api(`/api/testcases/csv-content?path=${encodeURIComponent(packetsCsvPath)}`);
      const allRows = pktsData.rows || [];
      let maxLocalRef = -1;
      for (const ref of frameRefs) {
        const m = ref.match(/(\d+)$/);
        if (m) maxLocalRef = Math.max(maxLocalRef, parseInt(m[1], 10));
      }
      state.tcNextFrameRef = maxLocalRef + 1;
      tcPackets = frameRefs.size
        ? parseTcCsvToPackets(allRows.filter(r => frameRefs.has(r['FrameRef'])))
        : [];
    } else {
      state.tcNextFrameRef = 0;
    }

    state.tcPackets        = tcPackets;
    state.tcOriginalRefs   = new Set(frameRefs);
    state.seqItems         = tcRows;
    state.seqOriginalItems = tcRows.map(r => ({...r}));
    state.seqItemHeaders   = tcData.headers || [];
    state.seqItems.forEach((r, i) => { if (!r['Index']) r['Index'] = String(i + 1); });
    const name = filePath.split('/').pop().replace(/\.csv$/i, '');
    const titleEl = $('scDetailTitle');
    if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
    renderCsvSequence(state.seqItems);   // C# LoadSequence에 해당 — 시퀀스 패널 갱신
    state.tcActivePath     = filePath;
    state.activeList       = 'tc';
    state.selectedSeqTcIdx = -1;
    state.selectedCsvPath  = filePath;
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
    toast(`TC: ${name} — ${tcPackets.length}개 패킷 로드`, 'ok');
  } catch (err) { toast(`TC load failed: ${err.message}`, 'bad'); }
}

// Load TC packets for a given filePath+tcRows without touching state.seqItems.
// Used by selectSeqTc() so the PG tab shows the TC's packets.
async function _activateTcPackets(filePath, tcRows) {
  if (state.tcActivePath === filePath && state.activeList === 'tc') {
    // Already active — just sync and refresh PG list
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
    return;
  }
  try {
    if (_tcSessionCache.has(filePath)) {
      const c = _tcSessionCache.get(filePath);
      state.tcPackets      = c.tcPackets;
      state.tcOriginalRefs = c.tcOriginalRefs;
      state.tcNextFrameRef = c.tcNextFrameRef;
    } else {
      const frameRefs = new Set(
        (tcRows || [])
          .filter(r => (r['EventType'] || '').toLowerCase() === 'packet')
          .map(r => (r['FrameRef'] || '').trim())
          .filter(r => r && r !== '-')
      );
      let tcPackets = [];
      const packetsCsvPath = findNearestPacketCsv(filePath);
      if (packetsCsvPath) {
        const pktsData = await api(`/api/testcases/csv-content?path=${encodeURIComponent(packetsCsvPath)}`);
        const allRows = pktsData.rows || [];
        let maxLocalRef = -1;
        for (const ref of frameRefs) {
          const m = ref.match(/(\d+)$/);
          if (m) maxLocalRef = Math.max(maxLocalRef, parseInt(m[1], 10));
        }
        state.tcNextFrameRef = maxLocalRef + 1;
        tcPackets = frameRefs.size
          ? parseTcCsvToPackets(allRows.filter(r => frameRefs.has(r['FrameRef'])))
          : [];
      } else {
        state.tcNextFrameRef = 0;
        tcPackets = [];
      }
      state.tcPackets      = tcPackets;
      state.tcOriginalRefs = new Set(frameRefs);
      state.seqItems       = tcRows || [];
      state.seqItemHeaders = [];
      state.seqItems.forEach((r, i) => { if (!r['Index']) r['Index'] = String(i + 1); });
    }
    state.tcActivePath = filePath;
    state.activeList   = 'tc';
    _syncTcPacketsToSeq();
    updateTcUI();
    selectPacket(-1);
    updateEstimatedTime();
  } catch (err) { toast(`TC 패킷 로드 실패: ${err.message}`, 'bad'); }
}

function clearTcMode() {
  // Save current TC state to session cache BEFORE clearing PG state.
  // This keeps custom packets alive for the rest of the session.
  // Session cache is in-memory only — page refresh or server restart
  // will automatically restore the original disk CSV.
  _saveTcToSessionCache();

  state.tcPackets        = [];
  state.tcActivePath     = '';
  state.tcOriginalRefs   = new Set();
  state.selectedSeqTcIdx = -1;
  state.activeList       = 'pg';

  // Clear scenario lab sequence panel (user can re-click TC to see current state)
  state.seqItems          = [];
  state.seqOriginalItems  = [];
  state.selectedCsvPath   = '';
  state.selectedSeqRowIdx = -1;
  const titleEl = $('scDetailTitle');
  if (titleEl) titleEl.textContent = 'TEST SEQUENCE — (select a TC)';
  const seqTbody = $('sequenceRows');
  if (seqTbody) seqTbody.innerHTML = '';
  document.querySelectorAll('#csvTree .csv-leaf, #csvTree .csv-root-item')
    .forEach(e => e.classList.remove('selected'));

  closeTcDropdown();
  updateTcUI();
  selectPacket(-1);
  updateEstimatedTime();
  toast('TC 종료 — 커스텀 패킷 세션 유지 (새로고침 시 원본 복원)', 'ok');
}

// ── Capture ───────────────────────────────────────────────────────────────────
function formatCaptureRow(r) {
  const eth  = r.decoded?.ethernet || r.decoded?.eth || {};
  const ip   = r.decoded?.ipv4 || {};
  const udp  = r.decoded?.udp || {};
  const tcp  = r.decoded?.tcp || {};
  const icmp = r.decoded?.icmp || {};
  const arp  = r.decoded?.arp || {};

  let protocol = 'RAW';
  if      (udp.srcPort  !== undefined) protocol = 'UDP';
  else if (tcp.srcPort  !== undefined) protocol = 'TCP';
  else if (icmp.type    !== undefined) protocol = 'ICMP';
  else if (arp.op !== undefined || arp.operation !== undefined) protocol = 'ARP';
  else if (ip.src)                     protocol = 'IPv4';

  let source = ip.src  || eth.srcMac || '';
  let dest   = ip.dst  || eth.dstMac || '';
  if (udp.srcPort  !== undefined) { source += `:${udp.srcPort}`;  dest += `:${udp.dstPort}`; }
  else if (tcp.srcPort !== undefined) { source += `:${tcp.srcPort}`; dest += `:${tcp.dstPort}`; }

  let info = '';
  if (udp.srcPort !== undefined)        info = `${udp.srcPort} → ${udp.dstPort}  Len=${r.length}`;
  else if (tcp.srcPort !== undefined)   info = `${tcp.srcPort} → ${tcp.dstPort}`;
  else if (icmp.type !== undefined)     info = `Type=${icmp.type} Code=${icmp.code || 0}`;
  else if (arp.op !== undefined || arp.operation !== undefined) {
    const isRequest = arp.op === 'request' || arp.op === 1 || arp.operation === 1;
    info = isRequest ? `Who has ${arp.targetIp}? Tell ${arp.senderIp}` : `${arp.senderIp} is at ${arp.senderMac}`;
  }
  else if (eth.etherType)               info = `EtherType=0x${Number(eth.etherType).toString(16).toUpperCase().padStart(4,'0')}`;

  const d = new Date((r.timestamp || 0) * 1000);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;

  return {
    no: r.no, time,
    interfaceName: r.interface || r.interfaceName || '',
    srcMac: eth.srcMac || '',
    dstMac: eth.dstMac || '',
    source, destination: dest, protocol, length: r.length, info,
    direction: r.direction || '',
    detailText: JSON.stringify(r.decoded || {}, null, 2),
    decoded: r.decoded || {},
    frameHex: r.frameHex || r.hex || '',
    hexDump: formatHex(r.frameHex || r.hex || ''),
    timeRaw: r.timestamp || 0,
  };
}

function getNodeBUrl() {
  return state.portmap.find(e => e.nodeUrl)?.nodeUrl || null;
}

async function refreshCaptureStatus() {
  try {
    // Ensure portmap is loaded so we know Node B URL
    if (!state.portmap.length) {
      try {
        const pm = await api('/api/portmap');
        state.portmap = pm.portmap || [];
      } catch { /* continue without portmap */ }
    }
    const [data, nodeBUrl] = [await api('/api/capture/status'), getNodeBUrl()];
    const running = data.running || data.capturing || false;
    const total = data.totalPackets || data.captureCount || 0;
    [$('captureRunning'), $('captureRunning2')].forEach(el => { if (el) el.textContent = running ? '● capturing' : 'idle'; });
    [$('captureTotal'), $('captureTotal2')].forEach(el => { if (el) el.textContent = `${total} pkts`; });

    const list = $('captureInterfaces');
    if (!list) return;
    list.innerHTML = '';
    state.captureInterfaces = new Set((data.interfaces || []).filter(i => i.selected).map(i => i.name));

    // Node A interfaces
    const labelA = document.createElement('div');
    labelA.style.cssText = 'font-size:10px;color:var(--muted);margin-bottom:4px;font-weight:600;';
    labelA.textContent = 'Node A (Local)';
    list.appendChild(labelA);
    for (const iface of data.interfaces || []) {
      const label = document.createElement('label');
      label.className = 'check-row';
      label.innerHTML = `<input type="checkbox" name="capture-iface" ${iface.selected ? 'checked' : ''} value="${esc(iface.name)}">
        <span><strong>${esc(iface.name)}</strong><small>${esc(iface.description || iface.state || '')}</small></span>`;
      label.querySelector('input').addEventListener('change', e => {
        if (e.target.checked) state.captureInterfaces.add(iface.name);
        else state.captureInterfaces.delete(iface.name);
      });
      list.appendChild(label);
    }

    // Node B interfaces
    if (nodeBUrl) {
      try {
        const dataB = await fetch(`${nodeBUrl}/api/capture/status`, { signal: AbortSignal.timeout(3000) }).then(r => r.json());
        state.captureInterfacesB = new Set((dataB.interfaces || []).filter(i => i.selected).map(i => i.name));
        const labelB = document.createElement('div');
        labelB.style.cssText = 'font-size:10px;color:var(--muted);margin:8px 0 4px;font-weight:600;';
        labelB.textContent = 'Node B (Remote)';
        list.appendChild(labelB);
        for (const iface of dataB.interfaces || []) {
          const label = document.createElement('label');
          label.className = 'check-row';
          label.innerHTML = `<input type="checkbox" name="capture-iface-b" ${iface.selected ? 'checked' : ''} value="${esc(iface.name)}">
            <span><strong>${esc(iface.name)}</strong><small>${esc(iface.description || iface.state || '')}</small></span>`;
          label.querySelector('input').addEventListener('change', e => {
            if (e.target.checked) state.captureInterfacesB.add(iface.name);
            else state.captureInterfacesB.delete(iface.name);
          });
          list.appendChild(label);
        }
      } catch { /* Node B unreachable — skip */ }
    }
  } catch { /* keep stable */ }
}

async function startCapture() {
  try {
    const promisc = $('capturePromisc')?.checked || false;
    const nodeBUrl = getNodeBUrl();
    const promises = [
      api('/api/capture/start', { method: 'POST', body: JSON.stringify({ interfaces: [...state.captureInterfaces], promisc }) })
    ];
    if (nodeBUrl && state.captureInterfacesB.size > 0) {
      promises.push(
        fetch(`${nodeBUrl}/api/capture/start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ interfaces: [...state.captureInterfacesB], promisc })
        }).catch(e => toast(`Node B capture failed: ${e.message}`, 'warn'))
      );
    }
    await Promise.all(promises);
    toast('Capture started', 'ok');
    startCapturePolling();
    await refreshCaptureStatus();
  } catch (err) { toast(`Capture failed: ${err.message}`, 'bad'); }
}

async function stopCapture() {
  try {
    const nodeBUrl = getNodeBUrl();
    const promises = [api('/api/capture/stop', { method: 'POST', body: '{}' })];
    if (nodeBUrl) {
      promises.push(
        fetch(`${nodeBUrl}/api/capture/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .catch(() => {})
      );
    }
    await Promise.all(promises);
    toast('Capture stopped', 'ok');
    await refreshCaptureStatus();
  } catch (err) { toast(`Stop failed: ${err.message}`, 'bad'); }
}

async function clearCapture() {
  try {
    const nodeBUrl = getNodeBUrl();
    const promises = [api('/api/capture/clear', { method: 'POST', body: '{}' })];
    if (nodeBUrl) {
      promises.push(
        fetch(`${nodeBUrl}/api/capture/clear`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .catch(() => {})
      );
    }
    await Promise.all(promises);
    state.captureRows = [];
    state.captureInterfacesB = new Set();
    state.captureIfaceFilter = new Set();
    updateCaptureIfaceFilters();
    renderCaptureRows();
    if ($('packetDetails')) $('packetDetails').innerHTML = '<span style="color:var(--muted)">Select a packet.</span>';
    if ($('packetHex'))     $('packetHex').innerHTML = '';
    await refreshCaptureStatus();
  } catch { /* ignore */ }
}

function startCapturePolling() {
  if (state.captureTimer) clearInterval(state.captureTimer);
  state.captureTimer = setInterval(loadCapturePackets, 900);
  loadCapturePackets();
}

async function loadCapturePackets() {
  try {
    const nodeBUrl = getNodeBUrl();
    const fetches = [api('/api/capture/packets?limit=1000')];
    if (nodeBUrl && state.captureInterfacesB.size > 0) {
      fetches.push(
        fetch(`${nodeBUrl}/api/capture/packets?limit=1000`, { signal: AbortSignal.timeout(3000) })
          .then(r => r.json()).catch(() => ({ rows: [] }))
      );
    }
    const [dataA, dataB] = await Promise.all(fetches);
    const rowsA = (dataA.rows || []).map(r => ({ ...formatCaptureRow(r), _node: 'A' }));
    const rowsB = dataB ? (dataB.rows || []).map(r => ({ ...formatCaptureRow(r), _node: 'B' })) : [];
    const merged = [...rowsA, ...rowsB].sort((a, b) => (a.timeRaw || 0) - (b.timeRaw || 0));
    state.captureRows = merged;
    updateCaptureIfaceFilters();
    renderCaptureRows();
    updateCaptureProtoSummary();
    const total = merged.length;
    [$('captureTotal'), $('captureTotal2')].forEach(el => { if (el) el.textContent = `${total} pkts`; });
    updateStatusBar();
  } catch { /* keep stable */ }
}

function updateCaptureProtoSummary() {
  const c = { ARP:0, IPv4:0, IPv6:0, TCP:0, UDP:0, ICMP:0 };
  for (const r of state.captureRows) {
    const p = (r.protocol || '').toUpperCase();
    if (p === 'ARP')  c.ARP++;
    else if (p === 'IPV4' || p === 'IPv4') c.IPv4++;
    else if (p === 'IPV6' || p === 'IPv6') c.IPv6++;
    else if (p === 'TCP')  c.TCP++;
    else if (p === 'UDP')  c.UDP++;
    else if (p === 'ICMP') c.ICMP++;
  }
  if ($('capCntArp'))  $('capCntArp').textContent  = c.ARP;
  if ($('capCntIpv4')) $('capCntIpv4').textContent = c.IPv4;
  if ($('capCntIpv6')) $('capCntIpv6').textContent = c.IPv6;
  if ($('capCntTcp'))  $('capCntTcp').textContent  = c.TCP;
  if ($('capCntUdp'))  $('capCntUdp').textContent  = c.UDP;
  if ($('capCntIcmp')) $('capCntIcmp').textContent = c.ICMP;
}

function updateCaptureIfaceFilters() {
  const el = $('capIfaceFilters');
  if (!el) return;
  const ifaces = [...new Set(state.captureRows.map(r => r.interfaceName).filter(Boolean))].sort();
  if (ifaces.length <= 1) { el.innerHTML = ''; return; }
  // Auto-add newly seen interfaces as checked
  for (const iface of ifaces) {
    if (!state.captureIfaceFilter.has('__seen__' + iface)) {
      state.captureIfaceFilter.add('__seen__' + iface);
      state.captureIfaceFilter.add(iface);
    }
  }
  el.innerHTML = ifaces.map(iface => {
    const col = _getIfaceColor(iface);
    const checked = state.captureIfaceFilter.has(iface) ? 'checked' : '';
    const borderStyle = col ? `border:1px solid ${col.border};color:${col.border};background:${col.bg};` : '';
    return `<label class="iface-filter-label" style="${borderStyle}">` +
      `<input type="checkbox" data-iface="${esc(iface)}" ${checked}> ${esc(iface)}</label>`;
  }).join('');
  el.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.captureIfaceFilter.add(cb.dataset.iface);
      else state.captureIfaceFilter.delete(cb.dataset.iface);
      renderCaptureRows();
    });
  });
}

function rowMatchesFilter(row, filter) {
  if (!filter) return true;
  const text = `${row.no} ${row.time} ${row.interfaceName} ${row.source} ${row.destination} ${row.protocol} ${row.length} ${row.info} ${row.srcMac} ${row.dstMac}`.toLowerCase();
  return filter.split(/\s+/).filter(Boolean).every(tok => {
    if (tok.startsWith('mac:'))  return `${row.srcMac} ${row.dstMac}`.toLowerCase().includes(tok.slice(4));
    if (tok.startsWith('ip:'))   return `${row.source} ${row.destination}`.toLowerCase().includes(tok.slice(3));
    if (tok.startsWith('port:')) return `${row.source} ${row.destination} ${row.info}`.toLowerCase().includes(tok.slice(5));
    return text.includes(tok);
  });
}

const _IFACE_COLORS = [
  { border:'#4a9eff', bg:'rgba(74,158,255,.07)'  },
  { border:'#ff6b6b', bg:'rgba(255,107,107,.07)' },
  { border:'#6bcb77', bg:'rgba(107,203,119,.07)' },
  { border:'#ffd93d', bg:'rgba(255,217,61,.07)'  },
  { border:'#c77dff', bg:'rgba(199,125,255,.07)' },
  { border:'#4ecdc4', bg:'rgba(78,205,196,.07)'  },
];
const _ifaceColorMap = new Map();
function _getIfaceColor(iface) {
  if (!iface) return null;
  if (!_ifaceColorMap.has(iface)) _ifaceColorMap.set(iface, _ifaceColorMap.size % _IFACE_COLORS.length);
  return _IFACE_COLORS[_ifaceColorMap.get(iface)];
}

function renderCaptureRows() {
  const tbody = $('captureRows');
  if (!tbody) return;
  const filter = ($('captureFilter')?.value || '').trim().toLowerCase();
  const activeIfaces = [...state.captureIfaceFilter].filter(k => !k.startsWith('__seen__'));
  const rows = state.captureRows.filter(r => {
    if (activeIfaces.length && r.interfaceName && !state.captureIfaceFilter.has(r.interfaceName)) return false;
    return rowMatchesFilter(r, filter);
  });
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="10" class="empty">No packets captured.</td></tr>`; return; }
  tbody.innerHTML = rows.map((r, i) => {
    const col = _getIfaceColor(r.interfaceName);
    const style = col ? ` style="border-left:3px solid ${col.border};background:${col.bg};"` : '';
    const txBadge = r.direction === 'TX' ? `<span class="dir-tx-badge">TX</span>` : '';
    return `
    <tr data-idx="${i}" class="proto-${esc((r.protocol||'').toLowerCase())}${r.direction === 'TX' ? ' cap-row-tx' : ''}"${style}>
      <td>${r.no}</td><td>${esc(r.time)}</td>
      <td>${col ? `<span class="iface-badge" style="border-color:${col.border};color:${col.border};">${esc(r.interfaceName)}</span>${txBadge}` : esc(r.interfaceName) + txBadge}${r._node === 'B' ? `<span class="pm-badge pm-remote" style="margin-left:3px;font-size:9px;">B</span>` : ''}</td>
      <td>${esc(r.srcMac)}</td><td>${esc(r.dstMac)}</td>
      <td>${esc(r.source)}</td><td>${esc(r.destination)}</td>
      <td><strong>${esc(r.protocol)}</strong></td>
      <td>${r.length}</td><td>${esc(r.info)}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
      tr.classList.add('selected');
      const row = rows[Number(tr.dataset.idx)];
      const detEl = $('packetDetails');
      if (detEl) {
        detEl.innerHTML = '';
        detEl.dataset.json = row.detailText || '{}';
        buildDecodeTreeDOM(detEl, row.decoded || {}, 0);
        if (!detEl.children.length) detEl.innerHTML = '<span style="color:var(--muted)">No detail.</span>';
      }
      if ($('packetHex')) $('packetHex').innerHTML = renderHexHTML(row.frameHex || '');
    });
  });
}

function downloadCaptureCsv() {
  // Try server export first, fall back to client-side
  window.open('/api/capture/export-csv', '_blank');
}

// ── Scenario Lab ──────────────────────────────────────────────────────────────
async function loadTestCases() {
  try {
    // CSV에서 직접 읽어 Test_Scenario_ID → TC_ID 순 정렬된 그룹 사용
    const data = await api('/api/testcases/sorted-groups');
    const groups = (data.groups || []).filter(g => !g.isPacketDef && g.name !== '(root)');
    renderTcTree(groups);
  } catch { /* ignore */ }
}

async function loadSequence() {
  // CSV 모드(시나리오 탭에서 TC/CSV 로드된 상태)에서는 서버 시퀀스로 덮어쓰지 않음
  if (state.selectedCsvPath || state.tcSeqList.length) return;
  try {
    const data = await api('/api/sequence/full');
    const items = data.items || [];
    if ($('scenarioTitle')) $('scenarioTitle').textContent = `Test Sequence (${items.length} events)`;
    renderSequenceRows(items);
  } catch { renderSequenceRows([]); }
}

function renderTcTree(groups) {
  state.tcGroups = groups;
  const root = $('tcTree');
  if (!root) return;
  if (!groups.length) { root.innerHTML = '<p style="color:var(--muted);font-size:10px;">No groups. Import CSV or add one.</p>'; return; }
  root.innerHTML = groups.map((g, gi) => `
    <div class="tc-group">
      <div class="tc-group-head">
        <span>${esc(g.name)}</span>
        <button class="small danger tc-del-group" data-group="${gi}">Del</button>
      </div>
      ${(g.cases || g.testCases || []).map((t, ti) => `
        <div class="tc-item" data-group="${gi}" data-tc="${ti}">
          <input type="checkbox" name="tc-check" class="tc-check" data-group="${gi}" data-tc="${ti}">
          <span class="tc-item-name">${esc(t.name)}</span><small>${(t.steps||[]).length} steps</small>
        </div>`).join('')}
    </div>`).join('');
  root.querySelectorAll('.tc-item').forEach(el => el.addEventListener('click', async e => {
    if (e.target.type === 'checkbox') return;
    const gi = Number(el.dataset.group), ti = Number(el.dataset.tc);
    root.querySelectorAll('.tc-item').forEach(e2 => e2.classList.remove('selected'));
    el.classList.add('selected');
    const grp = state.tcGroups[gi];
    const tc  = grp && (grp.cases || grp.testCases || [])[ti];
    if (!tc) return;
    // Re-enable action buttons
    ['seqRun', 'scSendSelected', 'scSendList'].forEach(id => {
      const btn = $(id); if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    });
    // C# SelectTc: 시퀀스 패널 즉시 표시 후 비동기 로드
    renderCsvSequence(tc.steps || []);
    if (tc.path) {
      state.selectedSeqTcIdx = -1;
      selectTcCsv(tc.path).catch(() => {});
    }
  }));
  root.querySelectorAll('.tc-del-group').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Delete this group?')) return;
    await api('/api/testcases/delete', { method: 'POST', body: JSON.stringify({ groupIndex: Number(btn.dataset.group) }) });
    await loadTestCases();
  }));
}


function seqEventSummary(item) {
  const t = (item.eventType || item.type || '').toLowerCase();
  if (t === 'delay')           return `${item.delayMs ?? 100}ms`;
  if (t === 'registerwrite')   return `${item.address}  ←  ${item.value}`;
  if (t === 'registerread')    return `${item.address}`;
  if (t === 'registerexpect')  return `${item.address} & ${item.mask||'0xFFFFFFFF'} == ${item.expected} [${item.timeoutMs||1000}ms]`;
  if (t === 'fdbwrite')        return `MAC:${item.mac}  Port:${item.port}`;
  if (t === 'fdbwritebucket')  return `MAC:${item.mac}  Bucket:${item.bucket}  Slot:${item.slot}`;
  if (t === 'fdbread')         return `MAC:${item.mac}`;
  if (t === 'fdbverify')       return `MAC:${item.mac}  Port:${item.expectedPort}${item.expectedAbsent==='1'||item.expectedAbsent===true?' (absent)':''}`;

  if (t === 'fdbreadbucket')   return `Bucket:${item.bucket}  Slot:${item.slot}`;
  if (t === 'fdbwaitfor')      return `MAC:${item.mac}`;
  if (t === 'fdbinitialize')   return 'flush all';
  if (t === 'rxverify')        return `expected:${item.expected||'?'}  timeout:${item.timeoutMs||''}`;

  return JSON.stringify(item).slice(0,60);
}

function getEventKind(item) {
  const t = (item.eventType || item.type || item.kind || '').toLowerCase();
  if (t.startsWith('fdb')) return 'FDB';
  if (t.includes('register')) return 'Reg';
  if (t === 'delay') return 'Delay';
  if (t.includes('verify') || t.includes('rx')) return 'Verify';
  return 'Event';
}

function renderSequenceRows(items) {
  const tbody = $('sequenceRows');
  if (!tbody) return;
  state.seqItems = items || [];
  state.seqRenderMode = 'tc';
  if (!items || !items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No sequence. Select a TC and press ›.</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((item, i) => {
    const evType  = item.eventType || item.type || item.kind || '';
    const name    = item.name || '';
    const mac     = item.mac || '';
    const details = seqEventSummary(item);
    const timeout = item.delayMs ? `${item.delayMs}ms` : (item.timeoutMs ? `${item.timeoutMs}ms` : '');
    const sel     = i === state.editingSeqRowIdx ? ' row-selected' : '';
    return `<tr data-idx="${i}" draggable="true" class="${sel}">
      <td style="color:var(--muted);">${i+1}</td>
      <td>${esc(name)}</td>
      <td><span class="ev-badge ev-${esc(evType.toLowerCase())}">${esc(evType)}</span></td>
      <td class="mono" style="font-size:10px;">${esc(mac)}</td>
      <td style="color:var(--muted);font-size:10px;">${esc(details)}</td>
      <td style="color:var(--muted);">${esc(timeout)}</td>
      <td style="font-size:10px;">${esc(item.status || '')}</td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => {
      state.selectedSeqRowIdx = i;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('row-selected'));
      tr.classList.add('row-selected');
      showEventEditorForRow(state.seqItems[i], i);
    });
  });
}

// TC Sequence (bottom panel)
function tcSeqAddChecked() {
  const checked = document.querySelectorAll('.tc-check:checked');
  if (!checked.length) { toast('Check at least one TC', 'warn'); return; }
  checked.forEach(chk => {
    const gi = Number(chk.dataset.group), ti = Number(chk.dataset.tc);
    const grp = state.tcGroups[gi];
    const tc  = (grp?.cases || grp?.testCases || [])[ti];
    if (tc) state.tcSeqList.push({ ...tc, _gi:gi, _ti:ti, status:'Queued' });
  });
  renderTcSeqRows();
  toast(`${checked.length} TC(s) added to sequence`, 'ok');
}

function tcSeqRemoveSelected() {
  if (state.selectedTcSeqIdx < 0) { toast('Select a TC first','warn'); return; }
  state.tcSeqList.splice(state.selectedTcSeqIdx, 1);
  state.selectedTcSeqIdx = Math.min(state.selectedTcSeqIdx, state.tcSeqList.length - 1);
  renderTcSeqRows();
}

function tcSeqClearAll() {
  if (!state.tcSeqList.length) return;
  if (!confirm('Clear all queued TCs?')) return;
  state.tcSeqList = []; state.selectedTcSeqIdx = -1; renderTcSeqRows();
}

function renderTcSeqRows() {
  const tbody = $('tcSeqRows');
  if (!tbody) return;
  if (!state.tcSeqList.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No TC queued.</td></tr>'; return; }
  tbody.innerHTML = state.tcSeqList.map((tc, i) => `
    <tr class="${i === state.selectedTcSeqIdx ? 'selected' : ''}">
      <td>${i+1}</td>
      <td>${esc(tc.name || '')}</td>
      <td>${(tc.steps || []).length}</td>
      <td style="font-size:10px;">${esc(tc.status || 'Queued')}</td>
    </tr>`).join('');
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => {
      selectSeqTc(i);
    });
  });
}

async function addTcGroup() {
  const name = prompt('Group name:');
  if (!name?.trim()) return;
  await api('/api/testcases/add-group', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
  await loadTestCases();
}

async function saveTcCurrent() {
  try {
    await api('/api/testcases/save-current', { method: 'POST', body: '{}' });
    toast('Saved', 'ok');
    await loadTestCases();
  } catch (err) { toast(`Save failed: ${err.message}`, 'bad'); }
}

async function importCsvScenarios() {
  const btn = $('tcImportCsv');
  if (btn) btn.disabled = true;
  try {
    const scan = await api('/api/testcases/scan-scenarios');
    if (!scan.files?.length) { toast('No CSV files found in testScenarios/', 'bad'); return; }
    const res = await api('/api/testcases/import-all-csv', { method: 'POST', body: '{}' });
    toast(`Imported ${res.imported ?? 0} CSV file(s)`, 'ok');
    await loadTestCases();
  } catch (err) { toast(`CSV import failed: ${err.message}`, 'bad'); }
  finally { if (btn) btn.disabled = false; }
}

// ── Event Palette (inline editor in sidebar) ──────────────────────────────────
const EVENT_FIELDS = {
  Delay:          [{ id:'delayMs',          label:'Delay (ms)',      type:'number', def:'500' }],
  RegWrite:       [{ id:'address',           label:'Address (hex)',   type:'text',   def:'0x000' },
                   { id:'value',            label:'Value (hex)',     type:'text',   def:'0x00000001' }],
  RegRead:        [{ id:'address',           label:'Address (hex)',   type:'text',   def:'0x000' }],
  RegVerify:      [{ id:'address',           label:'Address (hex)',   type:'text',   def:'0x000' },
                   { id:'expected',         label:'Expected (hex)',  type:'text',   def:'0x00000001' },
                   { id:'mask',             label:'Mask (hex)',      type:'text',   def:'0xFFFFFFFF' },
                   { id:'timeoutMs',        label:'Timeout (ms)',    type:'number', def:'1000' }],
  FdbWrite:       [{ id:'mac',       label:'MAC',        type:'text',     def:'00:00:00:00:00:00' },
                   { id:'vlanId',    label:'VLAN ID',    type:'number',   def:'0' },
                   { id:'vlanValid', label:'VLAN Valid', type:'checkbox', def:false },
                   { id:'port',      label:'Port',       type:'text',     def:'0' }],
  FdbWriteBucket: [{ id:'mac',       label:'MAC',        type:'text',     def:'00:00:00:00:00:00' },
                   { id:'vlanId',    label:'VLAN ID',    type:'number',   def:'0' },
                   { id:'vlanValid', label:'VLAN Valid', type:'checkbox', def:false },
                   { id:'port',      label:'Port',       type:'text',     def:'0' },
                   { id:'bucket',    label:'Bucket',     type:'number',   def:'0' },
                   { id:'slot',      label:'Slot (hex)', type:'text',     def:'0x1' }],
  FdbRead:        [{ id:'mac',       label:'MAC',        type:'text',     def:'00:00:00:00:00:00' },
                   { id:'vlanId',    label:'VLAN ID',    type:'number',   def:'0' },
                   { id:'vlanValid', label:'VLAN Valid', type:'checkbox', def:false }],
  FdbVerify:      [{ id:'mac',            label:'MAC',             type:'text',     def:'00:00:00:00:00:00' },
                   { id:'vlanId',         label:'VLAN ID',         type:'number',   def:'0' },
                   { id:'vlanValid',      label:'VLAN Valid',      type:'checkbox', def:false },
                   { id:'expectedPort',   label:'Expected Port',   type:'text',     def:'0' },
                   { id:'expectedAbsent', label:'Expected Absent', type:'checkbox', def:false }],
  FdbReadBucket:  [{ id:'bucket',           label:'Bucket',          type:'number', def:'0' },
                   { id:'slot',             label:'Slot (hex)',       type:'text',   def:'0x1' }],
  FdbInitialize:    [],
  RxVerify:         [{ id:'expected',  label:'Expected (port bitmask)', type:'text', def:'0b000001' },
                     { id:'timeoutMs', label:'Timeout',                 type:'text', def:'1000ms'   }],
  BranchOnResult:   [{ id:'value',   label:'Match Value (pass/fail/hex)', type:'text', def:'pass' },
                     { id:'ref',     label:'Branch CSV (e.g. VLAN/TC_Branch.csv)', type:'text', def:'' }],
};

const EVENT_API_TYPE = {
  Delay:'delay', RegWrite:'regwrite', RegRead:'regread', RegVerify:'regverify',
  FdbWrite:'fdbwrite', FdbWriteBucket:'fdbwritebucket', FdbRead:'fdbread', FdbReadBucket:'fdbreadbucket',
  FdbVerify:'fdbverify', FdbInitialize:'fdbinitialize', RxVerify:'rxverify',
  BranchOnResult:'branchonresult',
};

// Reverse map: lowercased API-type string → EVENT_FIELDS kind key
const EVENT_KIND_BY_API_TYPE = (() => {
  const m = {};
  for (const [k, v] of Object.entries(EVENT_API_TYPE)) m[v.toLowerCase()] = k;
  // Legacy aliases from older CSV files
  m['registerwrite']  = 'RegWrite';
  m['registerread']   = 'RegRead';
  m['registerverify'] = 'RegVerify';
  m['registerexpect'] = 'RegVerify';
  m['fdbflush']       = 'FdbInitialize';
  m['branchonresult'] = 'BranchOnResult';
  return m;
})();

/** Read a field value from a row in either TC-step (camelCase) or CSV (PascalCase) format. */
function getRowField(row, fieldId) {
  const v = row[fieldId];
  if (v !== undefined && v !== '' && v !== '-') return v;
  const csvAlt = {
    address:          ['Address'],
    value:            ['Value'],
    mac:              ['MAC', 'mac', 'Mac'],
    vlanId:           ['VlanID', 'VlanId', 'vlanid'],
    vlanValid:        ['VlanValid', 'vlanvalid'],
    port:             ['Port'],
    bucket:           ['Bucket'],
    slot:             ['Slot'],
    expected:         ['Expected'],
    mask:             ['Mask'],
    timeoutMs:        ['Timeout', 'timeout'],
    delayMs:          ['Timeout', 'timeout', 'DelayMs'],
    captureInterface: ['CaptureInterface'],
    captureFilter:    ['CaptureFilter', 'Filter'],
    captureExpected:  ['CaptureExpected'],
    expectedPort:     ['ExpectedPort'],
    expectedAbsent:   ['ExpectedAbsent'],
  };
  for (const alt of (csvAlt[fieldId] || [])) {
    const a = row[alt];
    if (a !== undefined && a !== '' && a !== '-') {
      if ((fieldId === 'timeoutMs' || fieldId === 'delayMs') && typeof a === 'string') {
        const n = parseInt(a); return isNaN(n) ? a : n;
      }
      return a;
    }
  }
  return null;
}

/**
 * Populate the event editor with an existing row's values and switch the
 * button to "Update Row" mode so it overwrites instead of appending.
 */
function showEventEditorForRow(row, rowIdx) {
  const evType = (row.eventType || row.EventType || row['Event Type'] || row.type || '')
    .toLowerCase().replace(/\s+/g, '');
  const kind = EVENT_KIND_BY_API_TYPE[evType];
  if (!kind) { toast(`Unknown event type: "${evType}"`, 'warn'); return; }

  showEventEditor(kind);  // populates default values

  for (const f of EVENT_FIELDS[kind] || []) {
    const val = getRowField(row, f.id);
    if (val !== null && val !== undefined) {
      const el = $(`eef-${f.id}`); if (!el) continue;
      if (f.type === 'checkbox') {
        const s = String(val).toLowerCase().trim();
        el.checked = s === '1' || s === 'y' || s === 'yes' || s === 'true' || val === true;
      } else {
        el.value = val;
      }
    }
  }

  const addBtn = $('addToSequence');
  if (addBtn) {
    addBtn.textContent = 'Update Row';
    addBtn.dataset.editMode  = 'update';
    addBtn.dataset.editRowIdx = String(rowIdx);
  }
  state.editingSeqRowIdx = rowIdx;
}

function resetEditorToAddMode() {
  const addBtn = $('addToSequence');
  if (addBtn) {
    addBtn.textContent = 'Add to Sequence';
    delete addBtn.dataset.editMode;
    delete addBtn.dataset.editRowIdx;
  }
  state.editingSeqRowIdx = -1;
}

function updateRowFromEditor() {
  const btn = $('addToSequence');
  const kind = btn?.dataset.evKind;
  const rowIdx = parseInt(btn?.dataset.editRowIdx ?? '-1');
  if (!kind || rowIdx < 0) return;

  if (state.seqRenderMode === 'tc') {
    const rows = state.seqItems;
    if (!rows[rowIdx]) return;
    const step = rows[rowIdx];
    step.eventType = EVENT_API_TYPE[kind] || kind.toLowerCase();
    for (const f of EVENT_FIELDS[kind] || []) {
      const el = $(`eef-${f.id}`); if (!el) continue;
      step[f.id] = f.type === 'number' ? Number(el.value) : f.type === 'checkbox' ? el.checked : el.value;
    }
    renderSequenceRows(rows);
  } else {
    const rows = _getSeqRows();
    if (!rows[rowIdx]) return;
    const row = rows[rowIdx];
    row.EventType = EVENT_API_TYPE[kind] || kind.toLowerCase();
    const toCSV = {
      address: 'Address', value: 'Value', mac: 'MAC', vlanId: 'VlanID', vlanValid: 'VlanValid', port: 'Port',
      bucket: 'Bucket', slot: 'Slot', expected: 'Expected', mask: 'Mask',
      timeoutMs: 'Timeout', delayMs: 'Timeout',
      captureInterface: 'CaptureInterface', captureFilter: 'CaptureFilter', captureExpected: 'CaptureExpected',
      expectedPort: 'ExpectedPort', expectedAbsent: 'ExpectedAbsent',
    };
    for (const f of EVENT_FIELDS[kind] || []) {
      const el = $(`eef-${f.id}`); if (!el) continue;
      const val = f.type === 'number' ? Number(el.value) : f.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
      const csvKey = toCSV[f.id] || f.id;
      row[csvKey] = String(val);
      if (csvKey !== f.id) row[f.id] = String(val); // camelCase 키도 동기화 (getRowField 우선순위)
    }
    _setSeqRows(rows);
  }

  resetEditorToAddMode();
  toast('Row updated', 'ok');
}

function showEventEditor(kind) {
  document.querySelectorAll('.palette-item, .ev-add-btn').forEach(el => el.classList.toggle('active', el.dataset.event === kind));
  const titleEl = $('eventEditorTitle'), fieldsEl = $('eventEditorFields'), addBtn = $('addToSequence');
  if (!titleEl || !fieldsEl) return;
  titleEl.textContent = kind;
  const fields = EVENT_FIELDS[kind] || [];
  fieldsEl.innerHTML = fields.length
    ? (() => {
        const out = [];
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          const nx = fields[i + 1];
          if (f.id === 'vlanId' && nx?.id === 'vlanValid') {
            out.push(`<div class="field"><label>${esc(f.label)}</label><span style="display:flex;gap:6px;align-items:center;"><input id="eef-${f.id}" type="${f.type}" value="${esc(String(f.def))}" placeholder="${esc(f.label)}" style="flex:1;min-width:0;"><label style="display:flex;align-items:center;gap:3px;white-space:nowrap;font-size:11px;cursor:pointer;"><input id="eef-${nx.id}" type="checkbox"${nx.def ? ' checked' : ''}> ${esc(nx.label)}</label></span></div>`);
            i++;
          } else if (f.type === 'checkbox') {
            out.push(`<div class="field"><label>${esc(f.label)}</label><input id="eef-${f.id}" type="checkbox"${f.def ? ' checked' : ''}></div>`);
          } else {
            out.push(`<div class="field"><label>${esc(f.label)}</label><input id="eef-${f.id}" type="${f.type}" value="${esc(String(f.def))}" placeholder="${esc(f.label)}"></div>`);
          }
        }
        return out.join('');
      })()
    : `<p style="font-size:11px;color:var(--muted);padding:0 0 4px;">No parameters required.</p>`;
  if (addBtn) {
    addBtn.disabled = false;
    addBtn.dataset.evKind = kind;
    addBtn.textContent = 'Add to Sequence';
    delete addBtn.dataset.editMode;
    delete addBtn.dataset.editRowIdx;
  }
  state.editingSeqRowIdx = -1;
}

async function addEventFromEditor() {
  const btn = $('addToSequence');
  const kind = btn?.dataset.evKind;
  if (!kind) return;

  // CSV 모드: 서버 API 대신 로컬 시퀀스에 직접 추가 (renderSequenceRows 호출 방지)
  if (state.selectedCsvPath || state.tcSeqList.length) {
    const toCSV = {
      address:'Address', value:'Value', mac:'MAC', vlanId:'VlanID', vlanValid:'VlanValid', port:'Port',
      bucket:'Bucket', slot:'Slot', expected:'Expected', mask:'Mask',
      timeoutMs:'Timeout', delayMs:'Timeout',
      captureInterface:'CaptureInterface', captureFilter:'CaptureFilter', captureExpected:'CaptureExpected',
    };
    const newRow = { Name: kind, EventType: EVENT_API_TYPE[kind] || kind, MAC: '-', Timeout: '' };
    for (const f of EVENT_FIELDS[kind] || []) {
      const el = $(`eef-${f.id}`); if (!el) continue;
      const val = f.type === 'number' ? Number(el.value) : f.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
      newRow[toCSV[f.id] || f.id] = String(val);
    }
    const rows = _getSeqRows();
    const idx = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
    rows.splice(idx, 0, newRow);
    state.selectedSeqRowIdx = idx;
    _setSeqRows(rows);
    toast(`${kind} added`, 'ok');
    return;
  }

  // 레거시: 서버 시퀀스 API 경로
  const event = { eventType: EVENT_API_TYPE[kind] || kind.toLowerCase() };
  for (const f of EVENT_FIELDS[kind] || []) {
    const el = $(`eef-${f.id}`); if (!el) continue;
    event[f.id] = f.type === 'number' ? Number(el.value) : f.type === 'checkbox' ? el.checked : el.value;
  }
  try {
    await api('/api/sequence/event/add', { method:'POST', body: JSON.stringify(event) });
    await loadSequence();
    toast(`${kind} added`, 'ok');
  } catch (err) { toast(`Add failed: ${err.message}`, 'bad'); }
}

// ── Sequence Run/Stop/Reset ───────────────────────────────────────────────────
function resetSequence() {
  if (_seqPollTimer) { clearInterval(_seqPollTimer); _seqPollTimer = null; }
  state.tcSeqList.forEach(tc => { tc.status = 'Queued'; });
  renderTcSeqRows();
  renderSequenceRows([]);
  appendSeqTerm('↺ Sequence reset');
}

let _seqPollTimer = null;

async function runSequence() {
  try {
    await api('/api/sequence/run', { method:'POST', body:'{}' });
    appendSeqTerm('▶ Sequence started');
    toast('Sequence started', 'ok');
    let prevStatus = '';
    _seqPollTimer = setInterval(async () => {
      try {
        const s = await api('/api/auto/status');
        if (s.statusText && s.statusText !== prevStatus) { appendSeqTerm(s.statusText); prevStatus = s.statusText; }
        if (!s.running) {
          clearInterval(_seqPollTimer); _seqPollTimer = null;
          appendSeqTerm(`■ Done: ${s.result || 'COMPLETED'}`);
          try {
            const r = await api('/api/auto/results');
            (r.rows || []).forEach(row => appendSeqTerm(`  [${row.result}] Step ${row.step} — ${row.name}: ${row.detail || ''}`));
          } catch { /* ignore */ }
          toast(`Sequence ${s.result || 'done'}`, s.result === 'PASS' ? 'ok' : 'bad');
        }
      } catch { clearInterval(_seqPollTimer); _seqPollTimer = null; }
    }, 500);
  } catch (err) { toast(`Run failed: ${err.message}`, 'bad'); }
}

async function stopSequence() {
  if (_seqPollTimer) { clearInterval(_seqPollTimer); _seqPollTimer = null; }
  try {
    await api('/api/auto/stop', { method:'POST', body:'{}' });
    appendSeqTerm('■ Sequence stopped');
    toast('Stopped', 'ok');
  } catch (err) { toast(`Stop failed: ${err.message}`, 'bad'); }
}

async function clearSequence() {
  if (!confirm('Clear all sequence events?')) return;
  try {
    await api('/api/sequence/events/clear', { method:'POST', body:'{}' }).catch(() =>
      api('/api/sequence/clear', { method:'POST', body:'{}' }));
    await loadSequence();
    toast('Sequence cleared', 'ok');
  } catch (err) { toast(`Clear failed: ${err.message}`, 'bad'); }
}

// ── CSV-based Test Case tree ──────────────────────────────────────────────────
// ── CSV Upload ────────────────────────────────────────────────────────────────

let _uploadFiles = [];

function initCsvUpload() {
  const btn      = $('tcUploadBtn');
  const panel    = $('tcUploadPanel');
  const pickBtn  = $('tcUploadPickBtn');
  const doBtn    = $('tcUploadDoBtn');
  const fileInput= $('tcUploadFileInput');
  const fileList = $('tcUploadFileList');
  const folderSel= $('tcUploadFolder');
  if (!btn || !panel) return;

  btn.addEventListener('click', async () => {
    const open = panel.style.display === 'none' || panel.style.display === '';
    panel.style.display = open ? '' : 'none';
    if (open) {
      // Populate folder dropdown from current tree
      folderSel.innerHTML = '<option value="">(root) testScenarios/</option>';
      try {
        const data = await api('/api/testcases/csv-tree');
        function addFolderOpts(nodes, prefix) {
          for (const n of (nodes || [])) {
            if (n.type === 'dir') {
              const p = prefix ? `${prefix}/${n.name}` : n.name;
              folderSel.innerHTML += `<option value="${esc(p)}">${esc(p)}/</option>`;
              addFolderOpts(n.children, p);
            }
          }
        }
        addFolderOpts(data.tree || [], '');
      } catch {}
    }
  });

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    _uploadFiles = Array.from(fileInput.files || []);
    fileList.innerHTML = _uploadFiles.map(f => `<span class="tc-upload-chip">${esc(f.name)}</span>`).join('');
    doBtn.disabled = _uploadFiles.length === 0;
    fileInput.value = '';
  });

  doBtn.addEventListener('click', async () => {
    if (!_uploadFiles.length) return;
    const folder = folderSel.value;
    doBtn.disabled = true;
    doBtn.textContent = '⏳ Uploading…';
    try {
      const fileObjs = await Promise.all(_uploadFiles.map(async f => ({
        name: f.name,
        content: await f.text(),
      })));
      const data = await api('/api/testcases/upload', {
        method: 'POST',
        body: JSON.stringify({ files: fileObjs, folder }),
      });
      const ok  = (data.results || []).filter(r => r.ok).length;
      const bad = (data.results || []).filter(r => !r.ok);
      if (ok) toast(`✓ ${ok}개 파일 업로드 완료`, 'ok');
      bad.forEach(r => toast(`✗ ${r.name}: ${r.error}`, 'bad'));
      _uploadFiles = [];
      fileList.innerHTML = '';
      doBtn.disabled = true;
      _csvTreeHash = '';
      loadCsvTree();
      if (!bad.length) panel.style.display = 'none';
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'bad');
    }
    doBtn.disabled = false;
    doBtn.textContent = '📤 업로드';
  });
}

let _csvTreeHash = '';
let _csvPollTimer = null;
let _lastCsvTreeData = null;

/** Flatten tree nodes into Map<relPath, mtime> for quick lookup. */
function flattenTreeMtimes(nodes, out) {
  out = out || new Map();
  for (const n of (nodes || [])) {
    if (n.type === 'file') out.set(n.path, n.mtime || 0);
    else if (n.type === 'dir') flattenTreeMtimes(n.children, out);
  }
  return out;
}

async function loadCsvTree() {
  try {
    const data = await api('/api/testcases/csv-tree');
    _lastCsvTreeData = data;
    // Always keep packet CSV paths up to date so findNearestPacketCsv works
    _knownPacketCsvPaths = [];
    (function collectPaths(nodes) {
      for (const n of (nodes || [])) {
        if (n.type === 'file' && n.isPacket) _knownPacketCsvPaths.push(n.path);
        else if (n.type === 'dir') collectPaths(n.children);
      }
    })(data.tree || []);
    const hash = JSON.stringify(data);
    const changed = hash !== _csvTreeHash;
    if (changed) {
      _csvTreeHash = hash;
      renderCsvTree(data);
    }
    // Always check sequence items for stale CSV content
    await _refreshStaleSeqItems(data);
  } catch {
    const root = $('csvTree');
    if (root && !root.innerHTML) root.innerHTML = '<p style="color:var(--muted);font-size:10px;padding:8px;">No CSV files found.</p>';
  }
}

/** Re-fetch CSV content for any queued TC whose file mtime changed or was deleted. */
async function _refreshStaleSeqItems(treeData) {
  if (!state.tcSeqList.length) return;
  const mtimeMap = flattenTreeMtimes((treeData || _lastCsvTreeData)?.tree);
  let seqListDirty = false;

  for (let i = 0; i < state.tcSeqList.length; i++) {
    const tc = state.tcSeqList[i];
    if (!tc.path) continue;

    const currentMtime = mtimeMap.get(tc.path);
    if (currentMtime === undefined) {
      // File deleted from disk
      if (!tc._missing) {
        tc._missing = true;
        seqListDirty = true;
        toast(`CSV 삭제됨: ${tc.name}`, 'warn');
      }
      continue;
    }

    if (tc._missing) { tc._missing = false; seqListDirty = true; }

    // mtime matches stored — nothing to do
    if (tc.mtime !== undefined && tc.mtime === currentMtime) continue;

    // mtime changed (content or name) — reload rows
    try {
      const d = await api(`/api/testcases/csv-content?path=${encodeURIComponent(tc.path)}`);
      tc.rows    = d.rows || [];
      tc.headers = d.headers || tc.headers || [];
      tc.mtime   = currentMtime;
      // Re-render detail panel if this TC is currently selected
      if (i === state.selectedSeqTcIdx) renderCsvSequence(tc.rows);
    } catch { /* leave stale rows intact */ }
  }

  if (seqListDirty) renderTcSeqList();
}

function renderCsvTree(tree) {
  const root = $('csvTree');
  if (!root) return;
  const prev = root.querySelector('.selected')?.getAttribute('data-path') || state.selectedCsvPath;

  function renderNodes(nodes, depth) {
    let h = '';
    for (const n of (nodes || [])) {
      // Root-level files (not inside any subfolder) are hidden from TEST CASES panel
      if (n.type === 'file' && depth === 0) continue;
      const pad = depth > 0 ? `padding-left:${depth * 14}px;` : '';
      if (n.type === 'file') {
        if (n.isPacket) {
          h += `<div class="csv-root-item" data-path="${esc(n.path)}" title="${esc(n.file)} — packet reference" style="${pad}">
            &#x1F4C4; ${esc(n.name)}
          </div>`;
        } else {
          h += `<div class="csv-leaf" data-path="${esc(n.path)}" title="${esc(n.file)}" style="${pad}">
            <input type="checkbox" name="csv-leaf-chk" class="csv-leaf-chk" data-path="${esc(n.path)}" style="flex-shrink:0;" onclick="event.stopPropagation()">
            <span>${esc(n.name)}</span>
          </div>`;
        }
      } else if (n.type === 'dir') {
        h += `<div class="csv-group">
          <div class="csv-group-head" style="${pad}">&#x1F4C1; ${esc(n.name)}</div>
          ${renderNodes(n.children, depth + 1)}
        </div>`;
      }
    }
    return h;
  }

  const html = renderNodes(tree.tree || [], 0);
  if (!html) { root.innerHTML = '<p style="color:var(--muted);font-size:10px;padding:8px;">No CSV files in testScenarios/.</p>'; return; }
  root.innerHTML = html;

  root.querySelectorAll('.csv-leaf, .csv-root-item').forEach(el => {
    el.addEventListener('click', async e => {
      if (e.target.type === 'checkbox') return;
      root.querySelectorAll('.csv-leaf, .csv-root-item').forEach(e2 => e2.classList.remove('selected'));
      el.classList.add('selected');
      const csvPath = el.getAttribute('data-path');
      state.selectedCsvPath = csvPath;
      // Scenario CSV (csv-leaf = non-packet): preview rows in detail panel + load packets
      if (el.classList.contains('csv-leaf')) {
        try {
          const name = csvPath.split('/').pop().replace(/\.csv$/i, '');
          state.selectedSeqTcIdx = -1;
          state.selectedSeqRowIdx = -1;

          if (_tcSessionCache.has(csvPath)) {
            // Already visited this session — save current TC first, then restore
            _saveTcToSessionCache();
            const c = _tcSessionCache.get(csvPath);
            state.seqItems       = c.seqRows;
            state.seqItemHeaders = c.seqHeaders;
            state.tcPackets      = c.tcPackets;
            state.tcOriginalRefs = c.tcOriginalRefs;
            state.tcNextFrameRef = c.tcNextFrameRef;
            state.tcActivePath   = csvPath;
            state.activeList     = 'tc';
            state.selectedCsvPath = csvPath;
            const titleEl = $('scDetailTitle');
            if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
            renderTcSeqList();
            renderCsvSequence(state.seqItems);
            _syncTcPacketsToSeq();
            updateTcUI();
            selectPacket(-1);
            updateEstimatedTime();
            toast(`TC: ${name} — ${state.tcPackets.length}개 패킷 (세션)`, 'ok');
          } else {
            // First visit — save current TC state to cache BEFORE changing seqItems,
            // then let selectTcCsv load and render everything (avoids cache corruption).
            _saveTcToSessionCache();
            const titleEl = $('scDetailTitle');
            if (titleEl) titleEl.textContent = `TEST SEQUENCE — ${name}`;
            renderTcSeqList();
            await selectTcCsv(csvPath);
          }
        } catch (err) { toast(`CSV load: ${err.message}`, 'bad'); }
      }
    });
  });

  const selectAllChk = $('csvSelectAll');
  if (selectAllChk) {
    selectAllChk.onchange = e => {
      root.querySelectorAll('.csv-leaf-chk').forEach(c => { c.checked = e.target.checked; });
    };
  }

  if (prev) {
    const sel = root.querySelector(`[data-path="${CSS.escape ? CSS.escape(prev) : prev}"]`);
    if (sel) { sel.classList.add('selected'); state.selectedCsvPath = prev; }
  }
}

async function tcAddToSeq() {
  // Collect all checked csv-leaf paths; fall back to currently selected path
  const checkedEls = document.querySelectorAll('.csv-leaf-chk:checked');
  const paths = checkedEls.length > 0
    ? Array.from(checkedEls).map(c => c.dataset.path).filter(Boolean)
    : (state.selectedCsvPath ? [state.selectedCsvPath] : []);
  if (!paths.length) { toast('왼쪽에서 TC를 선택하거나 체크하세요', 'warn'); return; }

  const mtimes = flattenTreeMtimes(_lastCsvTreeData?.tree);
  let added = 0, dup = 0;
  const firstAddIdx = state.tcSeqList.length;

  for (const path of paths) {
    if (state.tcSeqList.find(tc => tc.path === path)) { dup++; continue; }
    try {
      // If this TC is currently active and has unsaved modifications, persist them first
      if (state.activeList === 'tc' && state.tcActivePath === path) {
        _saveTcToSessionCache();
      }
      const data = await api(`/api/testcases/csv-content?path=${encodeURIComponent(path)}`);
      const name = path.split('/').pop().replace(/\.csv$/i, '');
      const diskRows = (data.rows || []).map(r => ({...r}));
      // Prefer session-cached rows (may include user modifications like added packets)
      const rows = _tcSessionCache.has(path)
        ? [..._tcSessionCache.get(path).seqRows]
        : diskRows;
      state.tcSeqList.push({
        path, name, status: 'pending',
        rows,
        originalRows: diskRows,   // always disk-original for revert on X TC
        headers: data.headers || [],
        mtime: mtimes.get(path),
      });
      added++;
    } catch (err) { toast(`로드 실패 (${path}): ${err.message}`, 'bad'); }
  }

  if (!added && !dup) return;
  renderTcSeqList();
  if (added && state.selectedSeqTcIdx < 0) selectSeqTc(firstAddIdx);
  toast(added ? `${added}개 TC 추가${dup ? `, ${dup}개 중복 건너뜀` : ''}` : `모두 이미 시퀀스에 있음`, added ? 'ok' : 'warn');
}

const _CSV_BASE_COLS = new Set([
  'Test_Scenario_ID','TC_Id','TC_ID','TC_id','Index','Name',
  'EventType','Event Type','MAC','timeout','Timeout',
]);

function buildCsvRowDetails(row) {
  const evType = (row['EventType'] || row['Event Type'] || '').toLowerCase();
  if (evType === 'packet') {
    const frameRef = row['FrameRef'] || row['frameref'] || '';
    const pkt = (state.tcPackets || []).find(p => p.name === frameRef);
    if (pkt) {
      const eth = pkt.blocks?.find(b => b.type === 'Ethernet') || {};
      const seqIdx = row['Index'] ?? ((state.tcPackets || []).indexOf(pkt) + 1);
      return `#${seqIdx}  Dst: ${eth.dstMac || '-'}   Src: ${eth.srcMac || '-'}`;
    }
    return frameRef ? `FrameRef: ${frameRef}` : '';
  }
  return Object.entries(row)
    .filter(([k, v]) => !_CSV_BASE_COLS.has(k) && v && v.trim() && v !== '-')
    .map(([k, v]) => `${k}: ${v}`)
    .join('   ');
}

let _seqDragFrom = -1;

/** Returns the rows currently shown in the detail panel (editable). */
function _getSeqRows() {
  const tc = state.tcSeqList[state.selectedSeqTcIdx];
  return tc ? tc.rows : state.seqItems;
}
/** Updates the rows, renormalizes indices, and re-renders. */
function _setSeqRows(rows) {
  rows.forEach((r, i) => { r['Index'] = String(i + 1); });
  const tc = state.tcSeqList[state.selectedSeqTcIdx];
  if (tc) tc.rows = rows;
  renderCsvSequence(rows);
}

function renderCsvSequence(rows) {
  const tbody = $('sequenceRows');
  if (!tbody) return;
  state.seqItems = rows || [];
  state.seqRenderMode = 'csv';
  state.seqItems.forEach((r, i) => { r['Index'] = String(i + 1); });
  if (state.selectedSeqRowIdx >= rows.length) state.selectedSeqRowIdx = rows.length - 1;
  if (!rows || !rows.length) {
    tbody.innerHTML = '';
    return;
  }
  // Packet 행의 Interface 컬럼("Port 0" 등)을 _iface로 해석 (미설정인 경우만)
  rows.forEach(row => {
    if ((row['EventType'] || '').toLowerCase() === 'packet' && !row._iface) {
      const ifaceVal = row['Interface'] || '';
      if (ifaceVal && ifaceVal !== '-') row._iface = _resolveIfaceValue(ifaceVal);
    }
  });
  tbody.innerHTML = rows.map((row, i) => {
    const idx     = row['Index'] !== undefined ? row['Index'] : String(i + 1);
    const name    = row['Name'] || '';
    const evType  = row['EventType'] || row['Event Type'] || '';
    const mac     = row['MAC'] || '';
    const details = buildCsvRowDetails(row);
    const sel      = i === state.selectedSeqRowIdx ? ' row-selected' : '';
    const result   = row._result || '';
    const rStyle   = result === 'Done' ? ';color:var(--green)' : result === 'Fail' ? ';color:var(--red)' : '';
    const isPacket = evType.toLowerCase() === 'packet';
    const ifaceCell = isPacket
      ? `<select name="sc-row-iface-${i}" class="sc-row-iface-sel small-select" data-row-idx="${i}" style="width:140px;font-size:10px;">
           ${_ifaceSelectOpts(row._iface || '')}
         </select>`
      : '';
    return `<tr data-idx="${i}" draggable="true" class="${sel}">
      <td><input type="checkbox" name="sc-row-chk" class="sc-row-chk" data-idx="${i}"></td>
      <td style="color:var(--muted);">${esc(idx)}</td>
      <td>${esc(name)}</td>
      <td><span class="ev-badge ev-${esc(evType.toLowerCase())}">${esc(evType)}</span></td>
      <td class="mono" style="font-size:10px;">${esc(mac)}</td>
      <td style="color:var(--muted);font-size:10px;">${esc(details)}</td>
      <td>${ifaceCell}</td>
      <td style="font-size:11px;font-weight:600${rStyle}" title="${esc(row._resultDetail||'')}">${esc(result)}</td>
    </tr>`;
  }).join('');

  const saChk = $('scSeqSelectAll');
  if (saChk) saChk.onchange = e => { tbody.querySelectorAll('.sc-row-chk').forEach(c => { c.checked = e.target.checked; }); };

  tbody.querySelectorAll('.sc-row-iface-sel').forEach(sel => {
    sel.addEventListener('change', e => {
      e.stopPropagation();
      const rowIdx = parseInt(sel.dataset.rowIdx);
      const rows2 = _getSeqRows();
      if (rows2[rowIdx]) rows2[rowIdx]._iface = sel.value;
    });
  });

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', e => {
      if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      state.selectedSeqRowIdx = i;
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('row-selected'));
      tr.classList.add('row-selected');
      showEventEditorForRow(rows[i], i);
    });
    tr.addEventListener('dragstart', e => {
      _seqDragFrom = i;
      e.dataTransfer.setData('text/x-seq-row', String(i));
      e.dataTransfer.effectAllowed = 'move';
      tr.classList.add('dragging');
    });
    tr.addEventListener('dragend', () => { tr.classList.remove('dragging'); _seqDragFrom = -1; });
    tr.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/x-seq-row')) { e.preventDefault(); tr.classList.add('drag-over'); }
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('drag-over'));
    tr.addEventListener('drop', e => {
      e.preventDefault(); tr.classList.remove('drag-over');
      if (!e.dataTransfer.types.includes('text/x-seq-row')) return; // palette drop — let bubble
      const from = Number(e.dataTransfer.getData('text/x-seq-row') ?? '-1');
      if (isNaN(from) || from < 0 || from === i) { _seqDragFrom = -1; return; }
      const rows2 = _getSeqRows();
      const [moved] = rows2.splice(from, 1);
      const insertAt = from < i ? i - 1 : i;
      rows2.splice(insertAt, 0, moved);
      state.selectedSeqRowIdx = insertAt;
      _seqDragFrom = -1;
      _setSeqRows(rows2);
      if (state.activeList === 'tc') { _syncTcPacketsToSeq(); renderPacketList(); }
    });
  });
}

// ── Sequence row edit (5 buttons) ────────────────────────────────────────────
function scRowAdd() {
  const rows = _getSeqRows();
  const newRow = { Index: '', Name: '', EventType: 'Delay', MAC: '-', Timeout: '' };
  const idx = state.selectedSeqRowIdx >= 0 ? state.selectedSeqRowIdx + 1 : rows.length;
  rows.splice(idx, 0, newRow);
  state.selectedSeqRowIdx = idx;
  _setSeqRows(rows);
}

function scRowDel() {
  const rows = _getSeqRows();
  if (state.selectedSeqRowIdx < 0 || state.selectedSeqRowIdx >= rows.length) { toast('먼저 행을 선택하세요', 'warn'); return; }
  rows.splice(state.selectedSeqRowIdx, 1);
  state.selectedSeqRowIdx = Math.min(state.selectedSeqRowIdx, rows.length - 1);
  _setSeqRows(rows);
}

function scRowDup() {
  const rows = _getSeqRows();
  if (state.selectedSeqRowIdx < 0 || state.selectedSeqRowIdx >= rows.length) { toast('먼저 행을 선택하세요', 'warn'); return; }
  const dup = { ...rows[state.selectedSeqRowIdx] };
  const idx = state.selectedSeqRowIdx + 1;
  rows.splice(idx, 0, dup);
  state.selectedSeqRowIdx = idx;
  _setSeqRows(rows);
}

function scRowMoveUp() {
  const rows = _getSeqRows();
  const i = state.selectedSeqRowIdx;
  if (i <= 0) return;
  [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
  state.selectedSeqRowIdx = i - 1;
  _setSeqRows(rows);
}

function scRowMoveDown() {
  const rows = _getSeqRows();
  const i = state.selectedSeqRowIdx;
  if (i < 0 || i >= rows.length - 1) return;
  [rows[i], rows[i + 1]] = [rows[i + 1], rows[i]];
  state.selectedSeqRowIdx = i + 1;
  _setSeqRows(rows);
}

// ── Event palette → sequence table DnD ───────────────────────────────────────
function initPaletteDnD() {
  document.querySelectorAll('.palette-item[data-event]').forEach(el => {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-palette-event', el.dataset.event);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });

  // Table area: accept palette drops (insert row) and keep seq-row drops working
  const tableArea = $('scTableArea');
  if (tableArea) {
    tableArea.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/x-palette-event')) {
        e.preventDefault();
        tableArea.classList.add('drop-target');
      }
    });
    tableArea.addEventListener('dragleave', e => {
      if (!tableArea.contains(e.relatedTarget)) tableArea.classList.remove('drop-target');
    });
    tableArea.addEventListener('drop', e => {
      tableArea.classList.remove('drop-target');
      const evType = e.dataTransfer.getData('text/x-palette-event');
      if (!evType) return;
      e.preventDefault();
      const rows = _getSeqRows();
      const newRow = { Index: '', Name: evType, EventType: evType, MAC: '-', Timeout: '' };
      // Insert before the hovered row; if dropped on empty area, append at end
      const targetTr = e.target.closest?.('tr[data-idx]');
      const idx = targetTr ? parseInt(targetTr.dataset.idx ?? rows.length) : rows.length;
      rows.splice(idx, 0, newRow);
      state.selectedSeqRowIdx = idx;
      _setSeqRows(rows);
    });
  }

  // Bottom drop zone — move or insert row at end of list
  const seqDropEnd = $('scSeqDropEnd');
  if (seqDropEnd) {
    seqDropEnd.addEventListener('dragover', e => {
      const ok = e.dataTransfer.types.includes('text/x-seq-row') || e.dataTransfer.types.includes('text/x-palette-event');
      if (ok) { e.preventDefault(); seqDropEnd.classList.add('drag-over'); }
    });
    seqDropEnd.addEventListener('dragleave', () => seqDropEnd.classList.remove('drag-over'));
    seqDropEnd.addEventListener('drop', e => {
      e.preventDefault(); seqDropEnd.classList.remove('drag-over');
      const rows2 = _getSeqRows();
      if (e.dataTransfer.types.includes('text/x-seq-row')) {
        const from = Number(e.dataTransfer.getData('text/x-seq-row') ?? '-1');
        if (isNaN(from) || from < 0 || from >= rows2.length) { _seqDragFrom = -1; return; }
        const [moved] = rows2.splice(from, 1);
        rows2.push(moved);
        state.selectedSeqRowIdx = rows2.length - 1;
        _seqDragFrom = -1;
        _setSeqRows(rows2);
        if (state.activeList === 'tc') { _syncTcPacketsToSeq(); renderPacketList(); }
      } else if (e.dataTransfer.types.includes('text/x-palette-event')) {
        const evType = e.dataTransfer.getData('text/x-palette-event');
        if (!evType) return;
        const newRow = { Index: '', Name: evType, EventType: evType, MAC: '-', Timeout: '' };
        rows2.push(newRow);
        state.selectedSeqRowIdx = rows2.length - 1;
        _setSeqRows(rows2);
      }
    });
  }

  // Event panel: drop a seq-row here to remove it
  const evPanel = $('scEventPanel');
  if (evPanel) {
    evPanel.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/x-seq-row')) {
        e.preventDefault();
        evPanel.classList.add('drop-remove');
      }
    });
    evPanel.addEventListener('dragleave', e => {
      if (!evPanel.contains(e.relatedTarget)) evPanel.classList.remove('drop-remove');
    });
    evPanel.addEventListener('drop', e => {
      evPanel.classList.remove('drop-remove');
      const idxStr = e.dataTransfer.getData('text/x-seq-row');
      if (idxStr === '') return;
      e.preventDefault();
      const rowIdx = Number(idxStr);
      const rows = _getSeqRows();
      if (rowIdx >= 0 && rowIdx < rows.length) {
        rows.splice(rowIdx, 1);
        state.selectedSeqRowIdx = Math.min(rowIdx, rows.length - 1);
        _setSeqRows(rows);
      }
    });
  }
}

// ── CSV Save (session-only, no disk write) ───────────────────────────────────
function _rowsToCsv(headers, rows) {
  const csvEsc = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(csvEsc).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEsc(row[h] ?? '')).join(','));
  }
  return lines.join('\r\n');
}

async function saveCsvTc() {
  const tc      = state.tcSeqList[state.selectedSeqTcIdx];
  const csvPath = tc?.path ?? state.selectedCsvPath;
  if (!csvPath) { toast('저장할 CSV 경로가 없습니다', 'warn'); return; }

  _saveTcToSessionCache();

  const rows = [..._getSeqRows()];
  rows.forEach((r, i) => { r['Index'] = String(i + 1); });

  // Build headers: use saved headers, then append any new fields found in rows
  let headers = (tc?.headers ?? state.seqItemHeaders ?? []).filter(h => !h.startsWith('_'));
  if (!headers.length) headers = ['Index', 'Name', 'EventType', 'MAC', 'FrameRef', 'Timeout'];
  const knownKeys = new Set(headers);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!k.startsWith('_') && !knownKeys.has(k)) { headers.push(k); knownKeys.add(k); }
    }
  }

  const csvText = _rowsToCsv(headers, rows);
  try {
    await api('/api/testcases/save-csv', { method: 'POST', body: JSON.stringify({ path: csvPath, csvText }) });
    const name = csvPath.split('/').pop().replace(/\.csv$/i, '');
    toast(`[${name}] CSV 파일 저장 완료`, 'ok');
  } catch (err) {
    toast(`저장 실패: ${err.message}`, 'bad');
  }
}

function startCsvPoller() {
  if (_csvPollTimer) return;
  _csvPollTimer = setInterval(loadCsvTree, 5000);
}

// ── TEST SEQUENCE panel (Panel 3) ─────────────────────────────────────────────
let _tcSeqDragFrom = -1;

function renderTcSeqList() {
  const el = $('tcSeqList');
  if (!el) return;
  if (!state.tcSeqList.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:10px;padding:12px;">No TC queued. Select one on the left and press ›.</div>';
    return;
  }
  el.innerHTML = state.tcSeqList.map((tc, i) => {
    const dotClass = tc._missing             ? 'missing'
                   : tc.status === 'running' ? 'running'
                   : tc.status === 'pass'    ? 'pass'
                   : tc.status === 'fail'    ? 'fail' : 'pending';
    return `<div class="tc-seq-row${i === state.selectedSeqTcIdx ? ' selected' : ''}" data-idx="${i}" draggable="true">
      <span class="tc-drag-handle" title="Drag to reorder">⠿</span>
      <span class="tc-dot ${dotClass}" title="${tc.status}"></span>
      <span class="tc-seq-idx">${i+1}</span>
      <span class="tc-seq-name" title="${esc(tc.name)}">${esc(tc.name)}</span>
    </div>`;
  }).join('') + '<div class="tc-seq-drop-end"></div>';

  el.querySelectorAll('.tc-seq-row').forEach((row, i) => {
    row.addEventListener('click', () => selectSeqTc(i));
    row.addEventListener('contextmenu', e => { e.preventDefault(); _showSeqCtxMenu(e.clientX, e.clientY, i); });
    row.addEventListener('dragstart', e => { _tcSeqDragFrom = i; row.style.opacity = '.4'; e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend',   () => { row.style.opacity = ''; _tcSeqDragFrom = -1; });
    row.addEventListener('dragover',  e => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
      e.preventDefault(); row.classList.remove('drag-over');
      if (_tcSeqDragFrom < 0 || _tcSeqDragFrom === i) { _tcSeqDragFrom = -1; return; }
      const selTc = state.tcSeqList[state.selectedSeqTcIdx];
      const [moved] = state.tcSeqList.splice(_tcSeqDragFrom, 1);
      const insertAt = _tcSeqDragFrom < i ? i - 1 : i;
      state.tcSeqList.splice(insertAt, 0, moved);
      state.selectedSeqTcIdx = selTc ? state.tcSeqList.indexOf(selTc) : -1;
      _tcSeqDragFrom = -1;
      renderTcSeqList();
    });
  });

  // Drop zone at the bottom: append to end
  const endZone = el.querySelector('.tc-seq-drop-end');
  if (endZone) {
    endZone.addEventListener('dragover',  e => { e.preventDefault(); endZone.classList.add('drag-over'); });
    endZone.addEventListener('dragleave', () => endZone.classList.remove('drag-over'));
    endZone.addEventListener('drop', e => {
      e.preventDefault(); endZone.classList.remove('drag-over');
      if (_tcSeqDragFrom < 0) return;
      const selTc = state.tcSeqList[state.selectedSeqTcIdx];
      const [moved] = state.tcSeqList.splice(_tcSeqDragFrom, 1);
      state.tcSeqList.push(moved);
      state.selectedSeqTcIdx = selTc ? state.tcSeqList.indexOf(selTc) : -1;
      _tcSeqDragFrom = -1;
      renderTcSeqList();
    });
  }
}

// ── Sequence context menu ─────────────────────────────────────────────────────
let _seqCtxMenu = null;

function _showSeqCtxMenu(x, y, idx) {
  _hideSeqCtxMenu();
  _seqCtxMenu = document.createElement('div');
  _seqCtxMenu.className = 'ctx-menu';
  _seqCtxMenu.style.cssText = `left:${x}px;top:${y}px;`;
  _seqCtxMenu.innerHTML = `<div class="ctx-item ctx-remove">✕ 시퀀스에서 제거</div>`;
  document.body.appendChild(_seqCtxMenu);
  _seqCtxMenu.querySelector('.ctx-remove').addEventListener('click', () => {
    _hideSeqCtxMenu();
    state.tcSeqList.splice(idx, 1);
    if (state.selectedSeqTcIdx >= state.tcSeqList.length)
      state.selectedSeqTcIdx = state.tcSeqList.length - 1;
    renderTcSeqList();
    if (state.selectedSeqTcIdx >= 0) selectSeqTc(state.selectedSeqTcIdx);
    else {
      const t = $('scDetailTitle'); if (t) t.textContent = 'TEST SEQUENCE — (select a TC)';
      const b = $('sequenceRows');
      if (b) b.innerHTML = '';
    }
  });
  setTimeout(() => document.addEventListener('click', _hideSeqCtxMenu, { once: true }), 0);
}

function _hideSeqCtxMenu() {
  if (_seqCtxMenu) { _seqCtxMenu.remove(); _seqCtxMenu = null; }
}

async function selectSeqTc(idx) {
  // Save current TC state BEFORE switching context so seqItems still reflects old TC
  _saveTcToSessionCache();
  state.selectedSeqTcIdx = idx;
  state.selectedSeqRowIdx = -1;
  const tc = state.tcSeqList[idx];
  const titleEl = $('scDetailTitle');
  if (titleEl) titleEl.textContent = tc ? `TEST SEQUENCE — ${tc.name}` : 'TEST SEQUENCE — (select a TC)';
  if (tc) {
    // Sync tc.rows from session cache so user-modified state (packets added, rows edited) is shown
    if (_tcSessionCache.has(tc.path)) {
      tc.rows = [..._tcSessionCache.get(tc.path).seqRows];
    }
    renderCsvSequence(tc.rows || []);
    // Also load this TC's packets into PG view (TC mode)
    await _activateTcPackets(tc.path, tc.rows);
  } else {
    const tbody = $('sequenceRows'); if (tbody) tbody.innerHTML = '';
  }
  renderTcSeqList();
}

// ── Run State Management ──────────────────────────────────────────────────────
function setRunState(mode) {
  state.seqRunning  = mode === 'seq';
  state.sendRunning = mode === 'selSend' || mode === 'listSend';

  const seqRunBtn = $('seqRun');
  if (seqRunBtn) {
    if (mode === 'seq') {
      seqRunBtn.textContent = '■ Stop'; seqRunBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;';
    } else {
      seqRunBtn.textContent = '▶ Run Seq'; seqRunBtn.style.cssText = 'background:var(--green);border-color:var(--green);color:#000;';
      seqRunBtn.disabled = !!(mode === 'selSend' || mode === 'listSend');
    }
  }
  const selBtn = $('scSendSelected');
  if (selBtn) {
    if (mode === 'selSend') {
      selBtn.textContent = '■ Stop'; selBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; selBtn.className = 'small';
    } else {
      selBtn.textContent = '▶ Send Selected'; selBtn.style.cssText = ''; selBtn.className = 'small';
      selBtn.disabled = !!(mode === 'seq' || mode === 'listSend');
    }
  }
  const listBtn = $('scSendList');
  if (listBtn) {
    if (mode === 'listSend') {
      listBtn.textContent = '■ Stop'; listBtn.style.cssText = 'background:var(--red);border-color:var(--red);color:#fff;'; listBtn.className = 'small';
    } else {
      listBtn.textContent = '▶▶ Send List'; listBtn.style.cssText = ''; listBtn.className = 'small primary';
      listBtn.disabled = !!(mode === 'seq' || mode === 'selSend');
    }
  }
  const spin = $('seqRunSpinner');
  if (spin) spin.style.display = mode === 'seq' ? '' : 'none';
}

function stopRunning() {
  if (_seqPollTimer) { clearInterval(_seqPollTimer); _seqPollTimer = null; }
  state._runAbort = true;
  const sc = $('scSelSpinner');  if (sc)  sc.style.display = 'none';
  const sl = $('scListSpinner'); if (sl) sl.style.display = 'none';
  setRunState(null);
}

// ── 이진수 포트 파싱 (0b000001 → 1) ─────────────────────────────────────────
function parseBinPort(s) {
  const t = String(s || '0').trim();
  if (t.startsWith('0b') || t.startsWith('0B')) return parseInt(t.slice(2), 2) || 0;
  return parseInt(t) || 0;
}

function parseVlanValid(row) {
  const v = row['VlanValid'] ?? row['vlanValid'] ?? row['vlanvalid'];
  if (v === undefined || v === null || v === '' || v === '-') return false;
  const s = String(v).toLowerCase().trim();
  return s === '1' || s === 'y' || s === 'yes' || s === 'true' || v === true;
}

// ── Event executor ────────────────────────────────────────────────────────────
async function executeEvent(row, iface, ctx = {}) {
  // 'Event Type'(공백) 와 'EventType' 모두 지원
  const evType = (row['EventType'] || row['Event Type'] || '').toLowerCase().trim();

  if (evType === 'delay') {
    const ms = Math.min(parseInt(row['Timeout'] || row['timeout'] || '200') || 200, 30000);
    await new Promise(r => setTimeout(r, ms));
    return { ok: true };
  }

  // ── RegWrite (TC_LinkStatus: 'RegWrite', TC_AutoLearning: 'RegWrite') ─────────
  if (evType === 'regwrite' || evType === 'registerwrite') {
    const offset = row['Address'] || row['address'] || '';
    const value  = row['Value']   || row['value']   || '';
    if (!offset || offset === '-') return { ok: false, error: 'No Address' };
    try {
      const data = await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value }) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'Write failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── RegRead ───────────────────────────────────────────────────────────────────
  if (evType === 'regread' || evType === 'registerread') {
    const offset = row['Address'] || row['address'] || '';
    if (!offset || offset === '-') return { ok: false, error: 'No Address' };
    try {
      const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
      return data.ok !== false ? { ok: true, detail: data.value || '' } : { ok: false, error: data.error || 'Read failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── Verify / RegVerify (TC_LinkStatus: 'Verify') ──────────────────────────────
  if (evType === 'verify' || evType === 'regverify' || evType === 'registerverify' || evType === 'registerexpect') {
    const offset    = row['Address']  || row['address']  || '';
    const expected  = row['Expected'] || row['expected'] || '0x0';
    const mask      = row['Mask']     || row['mask']     || '0xFFFFFFFF';
    const rawTo     = row['Timeout']  || row['timeout']  || '1000';
    const timeoutMs = parseInt(rawTo) || 1000;
    if (!offset || offset === '-') return { ok: false, error: 'No Address' };
    const expVal  = parseInt(String(expected).replace(/^0x/i,''), 16) || 0;
    const maskVal = parseInt(String(mask).replace(/^0x/i,''), 16) || 0xFFFFFFFF;
    const deadline = Date.now() + timeoutMs;
    let lastVal = null;
    while (true) {
      try {
        const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
        if (data.ok === false) return { ok: false, error: data.error || 'Read failed' };
        const actual = parseInt(String(data.value || '0').replace(/^0x/i,''), 16) || 0;
        lastVal = actual;
        if ((actual & maskVal) === (expVal & maskVal))
          return { ok: true, detail: `0x${actual.toString(16).toUpperCase()}` };
      } catch { /* retry */ }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(100, remaining)));
    }
    return { ok: false, error: `Verify timeout (${timeoutMs}ms), last=0x${(lastVal||0).toString(16).toUpperCase()}` };
  }

  // ── FdbInitialize / FdbFlush ──────────────────────────────────────────────────
  if (evType === 'fdbinitialize' || evType === 'fdbflush') {
    try {
      const data = await api('/api/fdb/flush', { method: 'POST', body: JSON.stringify({}) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'FDB flush failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── FdbWrite (TC_Fowarding_Static: Port='0b000001' 이진수) ────────────────────
  if (evType === 'fdbwrite') {
    const mac      = row['MAC'] || row['mac'] || '';
    const vlanId   = parseInt(row['VlanID'] || row['VlanId'] || row['vlanid'] || '0') || 0;
    const vlanValid = parseVlanValid(row);
    const port     = parseBinPort(row['Port'] || row['port'] || '0');
    if (!mac || mac === '-') return { ok: false, error: 'No MAC' };
    try {
      const data = await api('/api/fdb/write', { method: 'POST', body: JSON.stringify({ mac, vlanId, vlanValid, port }) });
      // FdbWrite 후 Waiting 딜레이 처리 (TC_Fowarding_Static: Waiting='10ms')
      const waitMs = parseInt(row['Waiting'] || row['waiting'] || '0') || 0;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'FDB write failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── FdbWriteBucket ────────────────────────────────────────────────────────────
  if (evType === 'fdbwritebucket') {
    const mac       = row['MAC'] || row['mac'] || '';
    const vlanId    = parseInt(row['VlanID'] || row['VlanId'] || row['vlanid'] || '0') || 0;
    const vlanValid = parseVlanValid(row);
    const port      = parseBinPort(row['Port'] || row['port'] || '0');
    const bucket    = parseInt(row['Bucket'] || row['bucket'] || '0') || 0;
    const slot      = parseInt(String(row['Slot'] || row['slot'] || '0x1').replace(/^0x/i, ''), 16) || 1;
    if (!mac || mac === '-') return { ok: false, error: 'No MAC' };
    try {
      const data = await api('/api/fdb/write-bucket', { method: 'POST', body: JSON.stringify({ mac, vlanId, vlanValid, port, bucket, slot }) });
      const waitMs = parseInt(row['Waiting'] || row['waiting'] || '0') || 0;
      if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'FDB write-bucket failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── FdbRead ───────────────────────────────────────────────────────────────────
  if (evType === 'fdbread') {
    const mac       = row['MAC'] || row['mac'] || '';
    const vlanId    = parseInt(row['VlanID'] || row['VlanId'] || row['vlanid'] || '0') || 0;
    const vlanValid = parseVlanValid(row);
    if (!mac || mac === '-') return { ok: false, error: 'No MAC' };
    try {
      const data = await api('/api/fdb/read', { method: 'POST', body: JSON.stringify({ mac, vlanId, vlanValid }) });
      if (data.ok === false) return { ok: false, error: data.error || 'FDB read failed' };
      const e = data.entry || {};
      const detail = e.found
        ? `found mac=${e.mac} port=${e.port} bucket=${e.bucket}`
        : `not found: ${mac}`;
      return { ok: true, detail };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── FdbVerify ─────────────────────────────────────────────────────────────────
  if (evType === 'fdbverify') {
    const mac            = row['MAC'] || row['mac'] || '';
    const vlanId         = parseInt(row['VlanID'] || row['VlanId'] || row['vlanid'] || '0') || 0;
    const vlanValid      = parseVlanValid(row);
    const expectedPort   = parseBinPort(row['ExpectedPort'] || row['expectedPort'] || '0');
    const rawAbsent      = row['ExpectedAbsent'] || row['expectedAbsent'] || '';
    const expectedAbsent = ['1','y','yes','true'].includes(String(rawAbsent).toLowerCase().trim()) || rawAbsent === true;
    if (!mac || mac === '-') return { ok: false, error: 'No MAC' };
    try {
      const data = await api('/api/fdb/read', { method: 'POST', body: JSON.stringify({ mac, vlanId, vlanValid }) });
      if (data.ok === false) return { ok: false, error: data.error || 'FDB read failed' };
      const entry = data.entry || {};
      if (expectedAbsent) {
        return entry.found
          ? { ok: false, error: `Expected absent but MAC found (port=${entry.port})` }
          : { ok: true, detail: `absent confirmed` };
      }
      if (!entry.found) return { ok: false, error: `MAC not found: ${mac}` };
      const portMatch = (entry.port & 0x1FF) === (expectedPort & 0x1FF);
      return portMatch
        ? { ok: true,  detail: `port=${entry.port} (expected ${expectedPort})` }
        : { ok: false, error: `Port mismatch: got ${entry.port}, expected ${expectedPort}` };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── FdbReadBucket (TC_BucketCapacityCheck: Bucket, Slot, Expected=MAC) ────────
  if (evType === 'fdbreadbucket') {
    const bucket   = parseInt(row['Bucket'] || row['bucket'] || '0') || 0;
    const slotMask = parseInt(String(row['Slot'] || row['slot'] || '0x1').replace(/^0x/i,''), 16) || 1;
    const expected = (row['Expected'] || row['expected'] || '').trim();
    try {
      const data = await api('/api/fdb/read-bucket', { method: 'POST', body: JSON.stringify({ bucket, slot: slotMask }) });
      if (data.ok === false) return { ok: false, error: data.error || 'FdbReadBucket failed' };
      if (expected && expected !== '-') {
        const got = (data.entry?.mac || '').toUpperCase();
        const exp = expected.toUpperCase();
        return got === exp ? { ok: true, detail: `bucket=${bucket} slot=0x${slotMask.toString(16)} mac=${got}` }
                           : { ok: false, error: `MAC mismatch: got ${got}, expected ${exp}` };
      }
      return { ok: true, detail: JSON.stringify(data.entry || {}) };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── Packet send ───────────────────────────────────────────────────────────────
  if (evType === 'packet') {
    const frameRef = row['FrameRef'] || row['frameref'] || row['Name'] || '';
    const pkt = (state.tcPackets || []).find(p => p.name === frameRef) || getActivePackets().find(p => p.name === frameRef);
    if (!pkt) return { ok: false, error: `Packet not found: ${frameRef}` };
    try {
      const payload = buildPacketPayload(pkt);
      const effectiveIface = row._iface || iface;
      if (effectiveIface) payload.interface = effectiveIface;
      // Route to remote node if the selected interface belongs to Node B
      const ifaceEntry = effectiveIface ? state.allIfaces.find(ai => ai.name === effectiveIface) : null;
      const sendUrl = ifaceEntry?.nodeUrl
        ? `${ifaceEntry.nodeUrl}/api/packet/send`
        : '/api/packet/send';
      const data = await api(sendUrl, { method: 'POST', body: JSON.stringify(payload) });
      return data.ok !== false ? { ok: true } : { ok: false, error: data.error || 'Send failed' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── RxVerify — 포트 비트맵 기반 수신 검증 ───────────────────────────────────
  if (evType === 'rxverify') {
    const expectedBitmap = parseBinPort(row['Expected'] || row['expected'] || '0');
    const timeoutMs      = parseInt(row['Timeout'] || row['timeout'] || '1000') || 1000;

    // 비트맵에서 기대 포트 번호 추출 (0b000000이면 "수신 없어야 함" 검증)
    const expectedPorts = [];
    for (let i = 0; i < 8; i++) { if (expectedBitmap & (1 << i)) expectedPorts.push(i); }

    // portmap → 로컬 / Node B 분리
    // expected=0b000000이면 전체 포트 대상으로 캡처 ("수신 없어야 함" 검증)
    const scanPorts = expectedPorts.length
      ? expectedPorts
      : state.portmap.map(e => Number(e.port));
    const localIfaces = [], nodeBIfaceMap = new Map();
    for (const p of scanPorts) {
      const entry = state.portmap.find(e => Number(e.port) === p);
      if (!entry?.iface) continue;
      if (entry.nodeUrl) {
        const list = nodeBIfaceMap.get(entry.nodeUrl) || [];
        list.push(entry.iface);
        nodeBIfaceMap.set(entry.nodeUrl, list);
      } else {
        localIfaces.push(entry.iface);
      }
    }
    if (!localIfaces.length && !nodeBIfaceMap.size) {
      return { ok: false, error: `RxVerify: portmap에 0b${expectedBitmap.toString(2)} 해당 포트 없음 — Settings 확인` };
    }

    // 폴링 시 모든 Node B URL 대상 (expected 외 포트 수신도 감지)
    const allNodeBUrls = [...new Set(
      state.portmap.filter(e => e.nodeUrl).map(e => e.nodeUrl)
    )];

    try {
      if (!ctx.capturePrestarted) {
        // portmap 전체 인터페이스 캡처 시작
        const allLocalIfaces = state.portmap.filter(e => !e.nodeUrl && e.iface).map(e => e.iface);
        const allNodeBIfaceMap = new Map();
        for (const e of state.portmap.filter(e => e.nodeUrl && e.iface)) {
          const list = allNodeBIfaceMap.get(e.nodeUrl) || [];
          list.push(e.iface);
          allNodeBIfaceMap.set(e.nodeUrl, list);
        }

        const clearPs = [api('/api/capture/clear', { method: 'POST', body: '{}' })];
        for (const url of allNodeBUrls)
          clearPs.push(fetch(`${url}/api/capture/clear`, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }).catch(() => {}));
        await Promise.all(clearPs);

        const startPs = [];
        if (allLocalIfaces.length)
          startPs.push(api('/api/capture/start', { method: 'POST', body: JSON.stringify({ interfaces: allLocalIfaces, promisc: true }) }));
        for (const [url, ifaces] of allNodeBIfaceMap)
          startPs.push(fetch(`${url}/api/capture/start`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ interfaces: ifaces, promisc: true }) }).catch(() => {}));
        await Promise.all(startPs);
      }

      const deadline = Date.now() + timeoutMs;
      const receivedPorts = new Set();
      const expectNone = expectedPorts.length === 0;  // 0b000000: 수신 없어야 함
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
        const fetches = [api('/api/capture/packets?limit=1000')];
        for (const url of allNodeBUrls)
          fetches.push(fetch(`${url}/api/capture/packets?limit=1000`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => ({ rows: [] })));
        const results = await Promise.all(fetches);
        for (const data of results) {
          for (const pkt of (data.rows || [])) {
            if (pkt.direction === 'TX') continue;
            const entry = state.portmap.find(e => e.iface === pkt.interface);
            if (entry !== undefined) receivedPorts.add(Number(entry.port));
          }
        }
        // 수신이 있어야 하는 경우: 기대 포트 모두 수신 확인 시 break
        // 수신이 없어야 하는 경우: 타임아웃까지 전체 대기 (중간에 수신 감지되면 즉시 fail)
        if (!expectNone && expectedPorts.every(p => receivedPorts.has(p))) break;
        if (expectNone && receivedPorts.size > 0) break;  // 수신 감지 → 즉시 fail 확정
      }

      const stopPs = [api('/api/capture/stop', { method: 'POST', body: '{}' })];
      for (const url of allNodeBUrls)
        stopPs.push(fetch(`${url}/api/capture/stop`, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }).catch(() => {}));
      await Promise.all(stopPs);

      const gotBitmap   = [...receivedPorts].reduce((acc, p) => acc | (1 << p), 0);
      const rawStr = String(row['Expected'] || row['expected'] || '0');
      const origLen = rawStr.startsWith('0b') || rawStr.startsWith('0B')
        ? rawStr.length - 2 : Math.max(expectedBitmap.toString(2).length, gotBitmap.toString(2).length);
      const padLen = Math.max(origLen, gotBitmap.toString(2).length);
      const allReceived = gotBitmap === expectedBitmap;
      return allReceived
        ? { ok: true,  detail: `received 0b${gotBitmap.toString(2).padStart(padLen, '0')}` }
        : { ok: false, error:  `expected 0b${expectedBitmap.toString(2).padStart(padLen,'0')}, got 0b${gotBitmap.toString(2).padStart(padLen,'0')} in ${timeoutMs}ms` };
    } catch (e) { return { ok: false, error: `RxVerify error: ${e.message}` }; }
  }

  // ── BranchOnResult ────────────────────────────────────────────────────────────
  if (evType === 'branchonresult') {
    const matchValue = (row['Value'] || row['value'] || '').trim().toLowerCase();
    const refFile    = (row['Ref']   || row['ref']   || '').trim();
    const scenarioId = row['Test_Scenario_ID'] || row['Scenario_ID'] || '';
    const tcId       = row['TC_ID'] || row['tc_id'] || '';

    if (!refFile) return { ok: false, error: 'BranchOnResult: Ref(CSV파일) 없음' };

    // 이전 스텝 결과 가져오기 (ctx.lastResult)
    const prevResult = (ctx.lastResult || '').toLowerCase();

    // Value 매칭: pass/fail이면 이전 스텝 결과와 비교, hex값이면 직접 비교
    const actualValue = (matchValue === 'pass' || matchValue === 'fail')
      ? prevResult
      : prevResult;

    if (actualValue !== matchValue) {
      return { ok: true, detail: `branch skipped (value="${actualValue}" ≠ "${matchValue}")` };
    }

    // branch CSV 로드
    let branchRows;
    try {
      const res = await api('/api/testcases/branch-rows', {
        method: 'POST',
        body: JSON.stringify({ file: refFile, scenarioId, tcId, value: matchValue })
      });
      if (!res.ok) throw new Error(res.error || 'branch load failed');
      branchRows = res.rows || [];
    } catch(e) {
      return { ok: false, error: `Branch CSV 로드 실패: ${e.message}` };
    }

    if (!branchRows.length) {
      return { ok: true, detail: `branch matched but no rows (value="${matchValue}")` };
    }

    // 현재 BranchOnResult 행의 DOM 위치 찾아서 sub-rows 동적 삽입
    const tbody   = document.getElementById('sequenceRows');
    const allTrs  = tbody ? [...tbody.querySelectorAll('tr')] : [];
    const branchTr = allTrs[ctx.rowIdx];  // BranchOnResult 행

    // sub-row 삽입 함수
    function insertSubRow(afterTr, subIdx, subRow) {
      const tr = document.createElement('tr');
      tr.className = 'branch-sub-row';
      tr.dataset.branchIdx = subIdx;
      const name   = subRow['Name'] || subRow['name'] || `Branch Step ${subIdx}`;
      const evName = subRow['EventType'] || subRow['Event Type'] || '';
      tr.innerHTML =
        `<td></td>` +
        `<td style="padding-left:20px;color:var(--muted);">↳ ${subIdx}</td>` +
        `<td style="color:var(--muted);">${name}</td>` +
        `<td style="color:var(--muted);">${evName}</td>` +
        `<td colspan="4"></td>` +
        `<td id="branch-result-${subIdx}" style="font-size:11px;"></td>`;
      if (afterTr && afterTr.parentNode) {
        afterTr.parentNode.insertBefore(tr, afterTr.nextSibling);
      }
      return tr;
    }

    // sub-rows 삽입 (역순으로 삽입해야 순서 유지)
    const insertedTrs = [];
    let anchor = branchTr;
    for (let i = 0; i < branchRows.length; i++) {
      const tr = insertSubRow(anchor, i, branchRows[i]);
      insertedTrs.push(tr);
      anchor = tr;
    }

    // sub-rows 순서대로 실행
    let allOk = true;
    for (let i = 0; i < branchRows.length; i++) {
      const subRow = branchRows[i];
      const resultEl = document.getElementById(`branch-result-${i}`);
      if (resultEl) { resultEl.textContent = '…'; resultEl.style.color = 'var(--muted)'; }

      let subRes;
      try {
        subRes = await executeEvent(subRow, iface, { ...ctx, rowIdx: -1 });
      } catch(e) {
        subRes = { ok: false, error: e.message };
      }

      if (resultEl) {
        resultEl.textContent  = subRes.ok ? 'Done' : 'Fail';
        resultEl.style.color  = subRes.ok ? 'var(--green)' : 'var(--red)';
        resultEl.title        = subRes.ok ? (subRes.detail || '') : (subRes.error || '');
      }
      if (!subRes.ok) { allOk = false; break; }
    }

    return allOk
      ? { ok: true,  detail: `branch "${matchValue}" OK (${branchRows.length} steps)` }
      : { ok: false, error:  `branch "${matchValue}" failed` };
  }

  // unknown event type
  await new Promise(r => setTimeout(r, 20));
  return { ok: false, error: `Unknown event type: ${evType}` };
}

// ── Row result updater (in-place, no full re-render) ─────────────────────────
function setRowResult(rowIdx, result, detail) {
  const rows = _getSeqRows();
  if (rowIdx < 0 || rowIdx >= rows.length) return;
  rows[rowIdx]._result       = result;
  rows[rowIdx]._resultDetail = detail || '';
  const tbody = $('sequenceRows');
  if (!tbody) return;
  const trs = tbody.querySelectorAll('tr');
  if (!trs[rowIdx]) return;
  const tds    = trs[rowIdx].querySelectorAll('td');
  const lastTd = tds[tds.length - 1];
  if (!lastTd) return;
  const clr = result === 'Done' ? ';color:var(--green)' : result === 'Fail' ? ';color:var(--red)' : '';
  lastTd.style.cssText = `font-size:11px;font-weight:600${clr}`;
  lastTd.textContent   = result;
  lastTd.title         = detail || '';
}

async function runSeqSequence() {
  if (!state.tcSeqList.length) { toast('No TCs in sequence — press › to add some', 'warn'); return; }
  const failIgnore = $('scFailIgnore')?.checked || false;
  const iface      = $('scInterface')?.value    || '';
  state._runAbort  = false;
  setRunState('seq');
  const statsEl = $('scStats');
  const t0 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: —`;
  appendSeqTerm('▶ Starting sequence run…');

  for (let i = 0; i < state.tcSeqList.length; i++) {
    if (state._runAbort) break;
    const tc = state.tcSeqList[i];
    tc.status = 'running';
    selectSeqTc(i);
    appendSeqTerm(`  ▶ [${i+1}/${state.tcSeqList.length}] ${tc.name}`);

    // Clear previous results for this TC
    for (const row of (tc.rows || [])) { row._result = ''; row._resultDetail = ''; }
    renderCsvSequence(tc.rows || []);

    let tcOk = true;
    let nextCapturePrestarted_seq = false;
    let lastResult_seq = '';
    for (let j = 0; j < (tc.rows || []).length; j++) {
      if (state._runAbort) break;
      const row = tc.rows[j];
      const ev  = (row['EventType'] || row['Event Type'] || '').toLowerCase();
      setRowResult(j, '…', '');
      const capturePrestarted = nextCapturePrestarted_seq;
      nextCapturePrestarted_seq = false;
      let res;
      try {
        if (await _maybePreStartCapture(tc.rows, j)) nextCapturePrestarted_seq = true;
        res = await executeEvent(row, iface, { capturePrestarted, rowIdx: j, lastResult: lastResult_seq });
      }
      catch (err) { res = { ok: false, error: err.message }; }
      const resultStr = res.ok ? 'Done' : 'Fail';
      lastResult_seq = resultStr.toLowerCase();
      setRowResult(j, resultStr, res.ok ? (res.detail || '') : (res.error || ''));
      appendSeqTerm(`    ${res.ok ? '✓' : '✗'} ${ev}: ${res.ok ? (res.detail || 'OK') : res.error}`);
      if (!res.ok) {
        tcOk = false;
        if (!failIgnore) break;
      }
    }

    tc.status = tcOk ? 'pass' : 'fail';
    renderTcSeqList();
    appendSeqTerm(`  ${tcOk ? '✓ PASS' : '✗ FAIL'}: ${tc.name}`);
    if (!tcOk && !failIgnore) { toast(`TC Fail: ${tc.name}`, 'bad'); break; }
  }

  const t1 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: ${t1.toLocaleTimeString()}`;
  setRunState(null);
  if (!state._runAbort) toast('Sequence complete', 'ok');
  else appendSeqTerm('■ Sequence aborted');
}

async function scenarioSendSelected() {
  const iface = '';
  const rows  = _getSeqRows();
  if (!rows.length) { toast('No rows — TC를 선택하거나 왼쪽에서 CSV를 클릭하세요', 'warn'); return; }
  const checkedIdxs = [];
  const tbody = $('sequenceRows');
  if (tbody) tbody.querySelectorAll('.sc-row-chk').forEach((c, i) => { if (c.checked) checkedIdxs.push(i); });
  if (!checkedIdxs.length) { toast('최소 한 행을 체크하세요', 'warn'); return; }

  const failIgnore = $('scFailIgnore')?.checked || false;
  for (const idx of checkedIdxs) { rows[idx]._result = ''; rows[idx]._resultDetail = ''; }
  renderCsvSequence(rows);

  state._runAbort = false;
  setRunState('selSend');
  const sp = $('scSelSpinner'); if (sp) sp.style.display = '';
  const statsEl = $('scStats');
  const t0 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: —`;
  appendSeqTerm(`▶ Send Selected (${checkedIdxs.length} rows)…`);

  let nextCapturePrestarted_sel = false;
  for (let ci = 0; ci < checkedIdxs.length; ci++) {
    if (state._runAbort) break;
    const idx  = checkedIdxs[ci];
    const nextIdx = checkedIdxs[ci + 1] ?? -1;
    const row  = rows[idx];
    const ev   = (row['EventType'] || row['Event Type'] || '').toLowerCase();
    setRowResult(idx, '…', '');
    const capturePrestarted = nextCapturePrestarted_sel;
    nextCapturePrestarted_sel = false;
    let res;
    try {
      // Build a virtual adjacent-row pair so look-ahead works on sparse selections
      const pairRows = nextIdx >= 0 ? [rows[idx], rows[nextIdx]] : [rows[idx]];
      if (await _maybePreStartCapture(pairRows, 0)) nextCapturePrestarted_sel = true;
      res = await executeEvent(row, iface, { capturePrestarted });
    }
    catch (err) { res = { ok: false, error: err.message }; }
    const resultStr = res.ok ? 'Done' : 'Fail';
    setRowResult(idx, resultStr, res.ok ? (res.detail || '') : (res.error || ''));
    appendSeqTerm(`  ${res.ok ? '✓' : '✗'} ${ev}: ${res.ok ? (res.detail || 'OK') : res.error}`);
    if (!res.ok && !failIgnore) { toast(`Fail: ${ev} — ${res.error}`, 'bad'); break; }
  }

  const t1 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: ${t1.toLocaleTimeString()}`;
  if (sp) sp.style.display = 'none';
  setRunState(null);
  if (!state._runAbort) toast('Send Selected complete', 'ok');
}

async function scenarioSendList() {
  const iface = '';
  const rows  = _getSeqRows();
  if (!rows.length) { toast('No rows — TC를 선택하거나 왼쪽에서 CSV를 클릭하세요', 'warn'); return; }

  const failIgnore = $('scFailIgnore')?.checked || false;
  for (const row of rows) { row._result = ''; row._resultDetail = ''; }
  renderCsvSequence(rows);

  state._runAbort = false;
  setRunState('listSend');
  const sp = $('scListSpinner'); if (sp) sp.style.display = '';
  const statsEl = $('scStats');
  const t0 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: —`;
  appendSeqTerm(`▶ Send List (${rows.length} rows)…`);

  let nextCapturePrestarted_list = false;
  for (let i = 0; i < rows.length; i++) {
    if (state._runAbort) break;
    const row = rows[i];
    const ev  = (row['EventType'] || row['Event Type'] || '').toLowerCase();
    setRowResult(i, '…', '');
    const capturePrestarted = nextCapturePrestarted_list;
    nextCapturePrestarted_list = false;
    let res;
    try {
      if (await _maybePreStartCapture(rows, i)) nextCapturePrestarted_list = true;
      res = await executeEvent(row, iface, { capturePrestarted });
    }
    catch (err) { res = { ok: false, error: err.message }; }
    const resultStr = res.ok ? 'Done' : 'Fail';
    setRowResult(i, resultStr, res.ok ? (res.detail || '') : (res.error || ''));
    appendSeqTerm(`  ${res.ok ? '✓' : '✗'} ${ev}: ${res.ok ? (res.detail || 'OK') : res.error}`);
    if (!res.ok && !failIgnore) { toast(`Fail: ${ev} — ${res.error}`, 'bad'); break; }
  }

  const t1 = new Date();
  if (statsEl) statsEl.textContent = `S: ${t0.toLocaleTimeString()} | E: ${t1.toLocaleTimeString()}`;
  if (sp) sp.style.display = 'none';
  setRunState(null);
  if (!state._runAbort) toast('Send List complete', 'ok');
}

// Pre-start capture before a packet step if the next step is rxverify, so the
// sent frame is already in the capture buffer when rxverify polls.
async function _maybePreStartCapture(rows, currentIdx) {
  const cur = rows[currentIdx];
  const next = rows[currentIdx + 1];
  if (!cur || !next) return false;
  const curEv  = (cur['EventType']  || cur['Event Type']  || '').toLowerCase().trim();
  const nextEv = (next['EventType'] || next['Event Type'] || '').toLowerCase().trim();
  if (curEv !== 'packet' || nextEv !== 'rxverify') return false;

  // portmap 전체 인터페이스 캡처 (수신된 포트를 빠짐없이 확인)
  const localIfaces = [], nodeBIfaceMap = new Map();
  for (const entry of state.portmap) {
    if (!entry?.iface) continue;
    if (entry.nodeUrl) {
      const list = nodeBIfaceMap.get(entry.nodeUrl) || [];
      list.push(entry.iface);
      nodeBIfaceMap.set(entry.nodeUrl, list);
    } else {
      localIfaces.push(entry.iface);
    }
  }

  try {
    const clearPs = [api('/api/capture/clear', { method: 'POST', body: '{}' })];
    for (const [url] of nodeBIfaceMap)
      clearPs.push(fetch(`${url}/api/capture/clear`, { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }).catch(() => {}));
    await Promise.all(clearPs);

    const startPs = [];
    if (localIfaces.length)
      startPs.push(api('/api/capture/start', { method: 'POST', body: JSON.stringify({ interfaces: localIfaces, promisc: true }) }));
    for (const [url, ifaces] of nodeBIfaceMap)
      startPs.push(fetch(`${url}/api/capture/start`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ interfaces: ifaces, promisc: true }) }).catch(() => {}));
    await Promise.all(startPs);
  } catch { return false; }
  // 항상 true 반환 → RxVerify가 자체 capture/clear 호출 안 함 (TX 프레임 보존)
  return true;
}

// Stubs for dead IDs referenced in preserved init() — must exist to avoid ReferenceError
function confirmEventModal()   {}
function closeEventModal()     {}
function addTcFromCurrent()    {}
async function readRegister()  {}
async function writeRegister() {}

async function refreshRegStatus() {
  try {
    const data = await api('/api/register/status');
    if (data.baseAddress !== undefined) {
      const b = typeof data.baseAddress === 'number' ? `0x${data.baseAddress.toString(16).toUpperCase().padStart(8,'0')}` : data.baseAddress;
      if ($('regBaseAddr')) $('regBaseAddr').value = b;
    }
  } catch { /* offline */ }
}

// ── Sequence Terminal ─────────────────────────────────────────────────────────
function appendSeqTerm(text) {
  const el = $('seqTerminal');
  if (!el) return;
  if (el.textContent === 'No output.') el.textContent = '';
  el.textContent += `${tsNow()}  ${text}\n`;
  el.scrollTop = el.scrollHeight;
}

async function seqTermSend() {
  const text = $('seqTermInput')?.value.trim();
  if (!text) return;
  try {
    await api('/api/serial/send', { method: 'POST', body: JSON.stringify({ text }) });
    appendHyperTerm(`> ${text}`);
    $('seqTermInput').value = '';
  } catch (err) { toast(`Send failed: ${err.message}`, 'bad'); }
}


// ── Register Viewer (HyperTerminal) ──────────────────────────────────────────
function setRegStatus(id, text, isOk) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `reg-status${isOk ? ' ok' : ''}`;
  if (isOk) setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'reg-status'; } }, 3000);
}

async function rvRead(offset, valId, statusId) {
  try {
    const data = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset }) });
    const val = data.value || `0x${(data.valueDec || 0).toString(16).toUpperCase().padStart(8,'0')}`;
    if (valId && $(valId)) $(valId).value = val;
    setRegStatus(statusId, 'OK', true);
    return data;
  } catch (err) { setRegStatus(statusId, `Error: ${err.message}`, false); }
}

async function rvWrite(offset, value, statusId) {
  try {
    await api('/api/register/write', { method: 'POST', body: JSON.stringify({ offset, value }) });
    setRegStatus(statusId, 'Write OK', true);
  } catch (err) { setRegStatus(statusId, `Error: ${err.message}`, false); }
}

function parseSysCtrlVersion(v) {
  const major = (v >>> 24) & 0xFF;
  const year  = (v >>> 16) & 0xFF;
  const month = (v >>> 12) & 0xF;
  const day   = (v >>>  4) & 0xFF;
  const minor =  v         & 0xF;
  const name  = major === 0x52 ? 'TSGW' : `0x${major.toString(16).toUpperCase().padStart(2,'0')}`;
  const yr    = ((year >> 4) & 0xF) * 10 + (year & 0xF);
  const dy    = ((day  >> 4) & 0xF) * 10 + (day  & 0xF);
  return `${name}  20${String(yr).padStart(2,'0')}-${month}-${String(dy).padStart(2,'0')}  v${minor}`;
}

function syncSysCtrlEnable(v) {
  const ports = (v >>> 8) & 0xFF;
  if ($('rv-en-tsgw')) $('rv-en-tsgw').checked = (v & 1) !== 0;
  for (let i = 0; i < 8; i++) { const el = $(`rv-en-p${i}`); if (el) el.checked = (ports & (1 << i)) !== 0; }
}

function buildSysCtrlEnable() {
  let ports = 0;
  for (let i = 0; i < 8; i++) { if ($(`rv-en-p${i}`)?.checked) ports |= (1 << i); }
  return (($('rv-en-tsgw')?.checked ? 1 : 0) | (ports << 8)) >>> 0;
}

function syncHostIf(v) {
  if ($('rv-ahb-wr')) $('rv-ahb-wr').value = v & 0xF;
  if ($('rv-ahb-rd')) $('rv-ahb-rd').value = (v >>> 4) & 0xF;
}

function buildHostIf() {
  const wr = Math.max(0, Math.min(15, parseInt($('rv-ahb-wr')?.value || '0')));
  const rd = Math.max(0, Math.min(15, parseInt($('rv-ahb-rd')?.value || '0')));
  return ((rd << 4) | wr) >>> 0;
}

// ── FDB register helpers ──────────────────────────────────────────────────────
const FDB_OFF = {
  VERSION:0xA00, FDB_LOAD:0xA04, ENABLE:0xA0C, AGE_PERIOD:0xA10, AGING_THR:0xA14,
  MCU_MAC0:0xA18, MCU_MAC1:0xA1C, MCU_VLAN:0xA20, MCU_PORT:0xA24, MCU_BUCKET:0xA28,
  MCU_CMD:0xA2C, FDB_STATUS:0xA40, CMD_STATUS:0xA44, RD_BUCKET:0xA48, RD_PORT:0xA4C,
  RD_FLAGS:0xA50, RD_MAC0:0xA54, RD_MAC1:0xA58, RD_MAC2:0xA5C,
};
const FDB_CMD = { HASH_READ:0x12, READ_BUCKET:0x13, HASH_WRITE:0x14, WRITE_BUCKET:0x15, HASH_DELETE:0x16, FLUSH_ALL:0x70 };

function parseRegD(d) {
  const raw = d.value || `0x${((d.valueDec||0)>>>0).toString(16).toUpperCase().padStart(8,'0')}`;
  return parseInt(raw, 16) >>> 0;
}

async function fdbReg(off) {
  const hex = `0x${off.toString(16).toUpperCase().padStart(3,'0')}`;
  const d = await api('/api/register/read', { method:'POST', body: JSON.stringify({ offset: hex }) });
  return parseRegD(d);
}

async function fdbWr(off, val) {
  const offset = `0x${off.toString(16).toUpperCase().padStart(3,'0')}`;
  const value  = `0x${(val >>> 0).toString(16).toUpperCase().padStart(8,'0')}`;
  await api('/api/register/write', { method:'POST', body: JSON.stringify({ offset, value }) });
}

async function fdbPoll(off, mask, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 500);
  while (Date.now() < deadline) {
    if ((await fdbReg(off) & mask) !== 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`Poll timeout off=0x${off.toString(16)}`);
}

function fdbInputs() {
  const mac    = $('rv-fdb-mac')?.value.trim() || '00:00:00:00:00:00';
  const vlanId = parseInt($('rv-fdb-vlan')?.value || '0') & 0xFFF;
  const vlanV  = !!$('rv-fdb-vlan-valid')?.checked;
  const port   = parseInt($('rv-fdb-port')?.value || '0') & 0x1FF;
  const bucket = parseInt(($('rv-fdb-bucket')?.value || '0').trim()) & 0x3FF;
  const slot   = parseInt(($('rv-fdb-slot')?.value || '0x1').trim()) & 0xF || 1;
  return { mac, vlanId, vlanV, port, bucket, slot };
}

function fdbAddRow(row) {
  const tbody = $('rv-fdb-tbody');
  if (!tbody) return;
  if (tbody.querySelector('[colspan]')) tbody.innerHTML = '';
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${row.bucket??'-'}</td><td>${row.slot??'-'}</td><td class="mono">${row.mac||'-'}</td><td>${row.port??'-'}</td><td>${row.status??'-'}</td><td>${row.ts??'-'}</td>`;
  tbody.insertBefore(tr, tbody.firstChild);
}

function fdbClearRows() {
  const tbody = $('rv-fdb-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);">No results yet</td></tr>';
}

function fdbSession() { return $('serialPort')?.value || ''; }

async function fdbReadByHash() {
  const { mac, vlanId, vlanV } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', 'Reading...', false);
  try {
    const res = await api('/api/fdb/read', {
      method: 'POST',
      body: JSON.stringify({ session: fdbSession(), mac, vlanId, vlanValid: vlanV })
    });
    if (!res.ok) throw new Error(res.error || 'read failed');
    fdbClearRows();
    const e = res.entry;
    if (!e.found) {
      fdbAddRow({ mac, port:'-', bucket:'-', slot:'-', ts:'-', status:'Not found' });
      setRegStatus('rv-st-fdb-cmd', 'Not learned', false);
    } else {
      fdbAddRow({ mac: e.mac, port: e.port, bucket: e.bucket, slot: '-', ts: '-', status: e.static ? 'Static' : 'Dynamic' });
      setRegStatus('rv-st-fdb-cmd', 'Entry found', true);
    }
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `Error: ${err.message}`, false); }
}

async function fdbReadByBucket() {
  const { bucket, slot } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', 'Reading...', false);
  try {
    const res = await api('/api/fdb/read-bucket', {
      method: 'POST',
      body: JSON.stringify({ session: fdbSession(), bucket, slot })
    });
    if (!res.ok) throw new Error(res.error || 'read failed');
    fdbClearRows();
    const e = res.entry;
    if (!e.found) {
      fdbAddRow({ bucket, slot: `0x${slot.toString(16)}`, mac:'-', port:'-', ts:'-', status:'Empty' });
      setRegStatus('rv-st-fdb-cmd', 'Slot empty', false);
    } else {
      fdbAddRow({ bucket: e.bucket, slot: `0x${(e.slot||slot).toString(16)}`, mac: e.mac, port: e.port, ts:'-', status: e.static ? 'Static' : 'Dynamic' });
      setRegStatus('rv-st-fdb-cmd', 'Entry found', true);
    }
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `Error: ${err.message}`, false); }
}

async function fdbWriteByHash() {
  const { mac, vlanId, vlanV, port } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', 'Writing...', false);
  try {
    const res = await api('/api/fdb/write', {
      method: 'POST',
      body: JSON.stringify({ session: fdbSession(), mac, vlanId, vlanValid: vlanV, port })
    });
    if (!res.ok) throw new Error(res.error || 'write failed');
    setRegStatus('rv-st-fdb-cmd', 'Write OK', true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `Error: ${err.message}`, false); }
}

async function fdbWriteByBucket() {
  const { mac, vlanId, vlanV, port, bucket, slot } = fdbInputs();
  setRegStatus('rv-st-fdb-cmd', 'Writing...', false);
  try {
    const res = await api('/api/fdb/write-bucket', {
      method: 'POST',
      body: JSON.stringify({ session: fdbSession(), mac, vlanId, vlanValid: vlanV, port, bucket, slot })
    });
    if (!res.ok) throw new Error(res.error || 'write failed');
    setRegStatus('rv-st-fdb-cmd', `Write OK  Bkt:${res.bucket} Slot:0x${(res.slot||slot).toString(16)}`, true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `Error: ${err.message}`, false); }
}

async function fdbDeleteByHash() {
  const { mac, vlanId, vlanV } = fdbInputs();
  if (!confirm(`Delete FDB entry for ${mac}?`)) return;
  setRegStatus('rv-st-fdb-cmd', 'Deleting...', false);
  try {
    const res = await api('/api/fdb/delete', {
      method: 'POST',
      body: JSON.stringify({ session: fdbSession(), mac, vlanId, vlanValid: vlanV })
    });
    if (!res.ok) throw new Error(res.error || 'delete failed');
    fdbClearRows();
    setRegStatus('rv-st-fdb-cmd', `Deleted (${mac})`, true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `Error: ${err.message}`, false); }
}

async function fdbInitAll() {
  if (!confirm('Init all FDB tables?')) return;
  setRegStatus('rv-st-fdb-cmd', 'Flushing...', false);
  try {
    const res = await api('/api/fdb/flush', {
      method: 'POST',
      body: JSON.stringify({ session: fdbSession() })
    });
    if (!res.ok) throw new Error(res.error || 'flush failed');
    fdbClearRows();
    setRegStatus('rv-st-fdb-cmd', 'Flush All done', true);
  } catch(err) { setRegStatus('rv-st-fdb-cmd', `Error: ${err.message}`, false); }
}

async function fdbCtrlReadConfig() {
  setRegStatus('rv-st-fdb-ctrl','Reading...',false);
  try{
    const ver=await fdbReg(FDB_OFF.VERSION);if($('rv-fdb-ver'))$('rv-fdb-ver').value=`0x${ver.toString(16).toUpperCase().padStart(8,'0')}`;
    const en=await fdbReg(FDB_OFF.ENABLE);if($('rv-fdb-age-scan'))$('rv-fdb-age-scan').checked=(en&(1<<4))!==0;if($('rv-fdb-learning'))$('rv-fdb-learning').checked=(en&(1<<1))!==0;if($('rv-fdb-lookup'))$('rv-fdb-lookup').checked=(en&1)!==0;
    const ap=(await fdbReg(FDB_OFF.AGE_PERIOD))&0xFFFFFF;   // [23:0] 유효
    const at=(await fdbReg(FDB_OFF.AGING_THR))&0xFFFF;      // [15:0] 유효
    if($('rv-fdb-age-period'))$('rv-fdb-age-period').value=ap;
    if($('rv-fdb-aging-thr'))$('rv-fdb-aging-thr').value=at;
    setRegStatus('rv-st-fdb-ctrl','Read OK',true);
  }catch(err){setRegStatus('rv-st-fdb-ctrl',`Error: ${err.message}`,false);}
}

async function fdbCtrlApplyEnable() {
  setRegStatus('rv-st-fdb-ctrl','Applying...',false);
  try {
    let en=0;if($('rv-fdb-age-scan')?.checked)en|=(1<<4);if($('rv-fdb-learning')?.checked)en|=(1<<1);if($('rv-fdb-lookup')?.checked)en|=1;
    const ap = (parseInt($('rv-fdb-age-period')?.value||'0')||0) & 0xFFFFFF;  // [23:0]
    const at = (parseInt($('rv-fdb-aging-thr')?.value||'0')||0) & 0xFFFF;    // [15:0]
    await fdbWr(FDB_OFF.ENABLE, en);
    await fdbWr(FDB_OFF.AGE_PERIOD, ap);
    await fdbWr(FDB_OFF.AGING_THR, at);
    setRegStatus('rv-st-fdb-ctrl','Applied',true);
  } catch(err){setRegStatus('rv-st-fdb-ctrl',`Error: ${err.message}`,false);}
}

async function fdbCtrlLoadDefault() {
  setRegStatus('rv-st-fdb-ctrl','Loading...',false);
  try {
    await fdbWr(FDB_OFF.ENABLE,     0x01);     // Lookup Enable
    await fdbWr(FDB_OFF.AGE_PERIOD, 0xF4240);  // 1,000,000 ns
    await fdbWr(FDB_OFF.AGING_THR,  0xBB8);    // 3,000
    await fdbCtrlReadConfig();
    setRegStatus('rv-st-fdb-ctrl','Default Load OK',true);
  } catch(err) { setRegStatus('rv-st-fdb-ctrl',`Error: ${err.message}`,false); }
}

// ── INTERRUPT ─────────────────────────────────────────────────────────────────
let _intrPollTimer = null;

function initIntrDots() {
  const portDiv=$('rv-intr-port-dots'), mdioDiv=$('rv-intr-mdio-dots'), pmDiv=$('rv-intr-port-mask'), mmDiv=$('rv-intr-mdio-mask');
  if(portDiv&&!portDiv.children.length)for(let i=0;i<16;i++)portDiv.insertAdjacentHTML('beforeend',`<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;"><span id="rv-intr-p${i}" class="led-dot"></span>P${i}</span>`);
  if(mdioDiv&&!mdioDiv.children.length)for(let i=0;i<8;i++)mdioDiv.insertAdjacentHTML('beforeend',`<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;"><span id="rv-intr-m${i}" class="led-dot"></span>M${i}</span>`);
  if(pmDiv&&!pmDiv.children.length)for(let i=0;i<16;i++)pmDiv.insertAdjacentHTML('beforeend',`<label class="rv-chk"><input id="rv-intr-pm${i}" type="checkbox"><span>P${i}</span></label>`);
  if(mmDiv&&!mmDiv.children.length)for(let i=0;i<8;i++)mmDiv.insertAdjacentHTML('beforeend',`<label class="rv-chk"><input id="rv-intr-mm${i}" type="checkbox"><span>M${i}</span></label>`);
}

async function intrCtrlRead() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x010'})});const v=parseRegD(d);const low=(v&1)!==0;if($('rv-intr-act-high'))$('rv-intr-act-high').checked=!low;if($('rv-intr-act-low'))$('rv-intr-act-low').checked=low;setRegStatus('rv-st-intr-ctrl',`OK — Active ${low?'Low':'High'}`,true);}
  catch(err){setRegStatus('rv-st-intr-ctrl',`Error: ${err.message}`,false);}
}

async function intrCtrlApply() {
  const low=$('rv-intr-act-low')?.checked?1:0;
  await rvWrite('0x010',`0x${low.toString(16).padStart(8,'0')}`,'rv-st-intr-ctrl');
}

async function intrRawRead() {
  try{
    const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x014'})});const v=parseRegD(d);
    for(let i=0;i<16;i++){const dot=$(`rv-intr-p${i}`);if(dot)dot.classList.toggle('connected',((v>>i)&1)!==0);}
    for(let i=0;i<8;i++){const dot=$(`rv-intr-m${i}`);if(dot)dot.classList.toggle('connected',((v>>(16+i))&1)!==0);}
    const swDot=$('rv-intr-sw-dot');if(swDot)swDot.classList.toggle('connected',((v>>>31)&1)!==0);
    setRegStatus('rv-st-intr-raw',`0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`,true);
  }catch(err){setRegStatus('rv-st-intr-raw',`Error: ${err.message}`,false);}
}

function intrTogglePoll() {
  const btn=$('rv-intr-raw-poll');
  if(_intrPollTimer){clearInterval(_intrPollTimer);_intrPollTimer=null;if(btn){btn.textContent='▶ Poll';btn.className='small';}}
  else{_intrPollTimer=setInterval(intrRawRead,500);if(btn){btn.textContent='■ Stop';btn.className='small danger';}intrRawRead();}
}

async function intrMaskRead() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x018'})});const v=parseRegD(d);for(let i=0;i<16;i++){const c=$(`rv-intr-pm${i}`);if(c)c.checked=((v>>i)&1)!==0;}for(let i=0;i<8;i++){const c=$(`rv-intr-mm${i}`);if(c)c.checked=((v>>(16+i))&1)!==0;}const sw=$('rv-intr-sw-mask');if(sw)sw.checked=((v>>>31)&1)!==0;setRegStatus('rv-st-intr-mask','OK',true);}
  catch(err){setRegStatus('rv-st-intr-mask',`Error: ${err.message}`,false);}
}

async function intrMaskApply() {
  let v=0;for(let i=0;i<16;i++){if($(`rv-intr-pm${i}`)?.checked)v|=(1<<i);}for(let i=0;i<8;i++){if($(`rv-intr-mm${i}`)?.checked)v|=(1<<(16+i));}if($('rv-intr-sw-mask')?.checked)v|=0x80000000;
  await rvWrite('0x018',`0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`,'rv-st-intr-mask');
}

async function intrSwTrigger() {
  setRegStatus('rv-st-intr-sw','Triggering...',true);
  try{await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x01C',value:'0x00000001'})});setRegStatus('rv-st-intr-sw','SW Trigger OK',true);const btn=$('rv-intr-sw-trigger');if(btn){btn.className='small primary';setTimeout(()=>{btn.className='small danger';},600);}}
  catch(err){setRegStatus('rv-st-intr-sw',`Error: ${err.message}`,false);}
}

// ── TIMESTAMP ─────────────────────────────────────────────────────────────────
async function tsReadTime() {
  setRegStatus('rv-st-ts','Reading...',true);
  try{
    const dNs=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x020'})}),dSecLo=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x024'})}),dSecHi=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x028'})});
    const ns=parseRegD(dNs),secLo=parseRegD(dSecLo),secHi=parseRegD(dSecHi);
    const sec=BigInt(secHi&0xFFFF)*4294967296n+BigInt(secLo>>>0);
    const dt=new Date(Number(sec)*1000);
    if($('rv-ts-current'))$('rv-ts-current').value=`${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}  ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}.${String(ns).padStart(9,'0')} ns`;
    setRegStatus('rv-st-ts','OK',true);
  }catch(err){setRegStatus('rv-st-ts',`Error: ${err.message}`,false);}
}

function tsSetNow() {
  const now=new Date();
  if($('rv-ts-year'))$('rv-ts-year').value=now.getFullYear();if($('rv-ts-month'))$('rv-ts-month').value=now.getMonth()+1;if($('rv-ts-day'))$('rv-ts-day').value=now.getDate();
  if($('rv-ts-hour'))$('rv-ts-hour').value=now.getHours();if($('rv-ts-min'))$('rv-ts-min').value=now.getMinutes();if($('rv-ts-sec'))$('rv-ts-sec').value=now.getSeconds();if($('rv-ts-set-ns'))$('rv-ts-set-ns').value=0;
}

async function tsSetTime() {
  setRegStatus('rv-st-ts','Setting...',true);
  try{
    const yr=parseInt($('rv-ts-year')?.value||'2025'),mo=parseInt($('rv-ts-month')?.value||'1'),dy=parseInt($('rv-ts-day')?.value||'1'),hr=parseInt($('rv-ts-hour')?.value||'0'),mn=parseInt($('rv-ts-min')?.value||'0'),sc=parseInt($('rv-ts-sec')?.value||'0'),ns=parseInt($('rv-ts-set-ns')?.value||'0')>>>0;
    const unixSec=BigInt(Math.floor(new Date(yr,mo-1,dy,hr,mn,sc).getTime()/1000));
    const secLo=Number(unixSec&0xFFFFFFFFn)>>>0,secHi=Number((unixSec>>32n)&0xFFFFn)>>>0;
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x020',value:`0x${ns.toString(16).padStart(8,'0')}`})});
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x024',value:`0x${secLo.toString(16).padStart(8,'0')}`})});
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x028',value:`0x${secHi.toString(16).padStart(8,'0')}`})});
    setRegStatus('rv-st-ts','Time set OK',true);
  }catch(err){setRegStatus('rv-st-ts',`Error: ${err.message}`,false);}
}

async function tsReadClock() {
  setRegStatus('rv-st-ts-clk','Reading...',true);
  try{
    const dA=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x02C'})}),dC1=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});
    const addend=parseRegD(dA),ctrl1=parseRegD(dC1),increment=ctrl1&0xFFFF;
    const scaled=increment+addend/4294967296.0,nsPerTick=scaled*1e9/4294967296.0,mhz=nsPerTick>0?Math.round(1000.0/nsPerTick*1e6)/1e6:0;
    if($('rv-ts-clk-mhz'))$('rv-ts-clk-mhz').value=mhz;
    // PPS fields share the same 0x030 register — update them here to avoid a duplicate read
    const src=(ctrl1>>16)&0x3,wid=((ctrl1>>>24)&0xFF)*2;
    document.querySelectorAll('input[name="ts-pps-src"]').forEach(r=>{r.checked=parseInt(r.value)===(src>=2?2:src);});
    if($('rv-ts-pps-width'))$('rv-ts-pps-width').value=wid;
    const srcLabel=['Disable','Internal','GPS'][src]||'GPS';
    setRegStatus('rv-st-ts-clk',`INCREMENT=${increment}  ADDEND=0x${addend.toString(16).toUpperCase().padStart(8,'0')}  PPS:${srcLabel}`,true);
  }catch(err){setRegStatus('rv-st-ts-clk',`Error: ${err.message}`,false);}
}

async function tsApplyClock() {
  const mhz=parseFloat($('rv-ts-clk-mhz')?.value||'200');if(!mhz){setRegStatus('rv-st-ts-clk','Invalid MHz',false);return;}
  setRegStatus('rv-st-ts-clk','Setting...',true);
  try{
    const periodNs=1000.0/mhz,exactIncr=periodNs*4294967296.0/1e9,increment=Math.floor(exactIncr)>>>0,addend=Math.round((exactIncr-increment)*4294967296.0)>>>0;
    const dC1=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});let ctrl1=parseRegD(dC1)&0xFFFF0000;ctrl1|=(increment&0xFFFF);
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x02C',value:`0x${addend.toString(16).padStart(8,'0')}`})});
    await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x030',value:`0x${ctrl1.toString(16).padStart(8,'0')}`})});
    setRegStatus('rv-st-ts-clk',`OK INCREMENT=${increment}`,true);
  }catch(err){setRegStatus('rv-st-ts-clk',`Error: ${err.message}`,false);}
}

async function tsReadPps() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});const v=parseRegD(d),src=(v>>16)&0x3,wid=((v>>24)&0xFF)*2;document.querySelectorAll('input[name="ts-pps-src"]').forEach(r=>{r.checked=parseInt(r.value)===(src>=2?2:src);});if($('rv-ts-pps-width'))$('rv-ts-pps-width').value=wid;const srcLabel=['Disable','Internal','GPS'][src]||'GPS';setRegStatus('rv-st-ts-clk',`PPS: ${srcLabel}  width=${wid}ms`,true);}
  catch(err){setRegStatus('rv-st-ts-clk',`PPS read error: ${err.message}`,false);}
}

async function tsApplyPps() {
  try{const src=parseInt(document.querySelector('input[name="ts-pps-src"]:checked')?.value||'1'),wid=parseInt($('rv-ts-pps-width')?.value||'100');const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x030'})});let v=parseRegD(d)&~0xFF030000;v|=(src&0x3)<<16;v|=((Math.floor(wid/2)&0xFF)<<24);await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x030',value:`0x${v.toString(16).padStart(8,'0')}`})});setRegStatus('rv-st-ts-clk','PPS set OK',true);}
  catch(err){setRegStatus('rv-st-ts-clk',`Error: ${err.message}`,false);}
}

async function tsApplyAdj() {
  const nsMs=parseInt($('rv-ts-ns-adj')?.value||'0'),secS=parseInt($('rv-ts-sec-adj')?.value||'0');
  const nsV=((Math.abs(nsMs)*1000000)>>>0&0x3FFFFFFF)|(nsMs>=0?0x40000000:0x80000000);
  const secV=(Math.abs(secS)&0x3FFFFFFF)|(secS>=0?0x40000000:0x80000000);
  await rvWrite('0x034',`0x${(nsV>>>0).toString(16).padStart(8,'0')}`,'rv-st-ts-adj');
  await rvWrite('0x038',`0x${(secV>>>0).toString(16).padStart(8,'0')}`,'rv-st-ts-adj');
}

// ── LED / CLOCK ───────────────────────────────────────────────────────────────
const LED_FPGA_LABELS=['System CLK Blink(400M)','AHB CLK Blink(400M)','RGMII CLK Blink(125M)','Reset_n','EXT_SW[0]','EXT_SW[1]','EXT_SW[2]','EXT_SW[3]'];

function initLedDots() {
  const fpgaDiv=$('rv-led-fpga-dots'),regDiv=$('rv-led-reg-chks'),swDiv=$('rv-ext-sw-dots');
  if(fpgaDiv&&!fpgaDiv.children.length)LED_FPGA_LABELS.forEach((lbl,i)=>fpgaDiv.insertAdjacentHTML('beforeend',`<div style="display:flex;align-items:center;gap:4px;font-size:11px;margin:1px 0;"><span id="rv-led-fpga-${i}" class="led-dot"></span>${esc(lbl)}</div>`));
  if(regDiv&&!regDiv.children.length)for(let i=0;i<8;i++)regDiv.insertAdjacentHTML('beforeend',`<label class="rv-chk"><input id="rv-led-rb-${i}" type="checkbox"><span>LED${i}</span></label>`);
  if(swDiv&&!swDiv.children.length)for(let i=0;i<6;i++)swDiv.insertAdjacentHTML('beforeend',`<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;"><span id="rv-ext-sw-${i}" class="led-dot"></span>SW${i}</span>`);
}

function ledModeChanged() {
  const mode=parseInt(document.querySelector('input[name="led-mode"]:checked')?.value??'1');
  const fpgaDiv=$('rv-led-fpga-dots'),regDiv=$('rv-led-reg-chks'),cpuWarn=$('rv-led-cpu-warn');
  if(fpgaDiv)fpgaDiv.style.display=mode===1?'':'none';if(regDiv)regDiv.style.display=mode===3?'':'none';if(cpuWarn)cpuWarn.style.display=mode===0?'':'none';
}

async function ledRead() {
  setRegStatus('rv-st-led','Reading...',true);
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x060'})});const v=parseRegD(d),mode=(v>>8)&0x3,leds=v&0xFF;document.querySelectorAll('input[name="led-mode"]').forEach(r=>{r.checked=parseInt(r.value)===mode;});for(let i=0;i<8;i++){const on=((leds>>i)&1)!==0;const fpgaDot=$(`rv-led-fpga-${i}`);if(fpgaDot)fpgaDot.classList.toggle('connected',on);const regChk=$(`rv-led-rb-${i}`);if(regChk)regChk.checked=on;}ledModeChanged();setRegStatus('rv-st-led',`OK — mode=${mode}  leds=0x${leds.toString(16).padStart(2,'0').toUpperCase()}`,true);}
  catch(err){setRegStatus('rv-st-led',`Error: ${err.message}`,false);}
}

async function ledApply() {
  const mode=parseInt(document.querySelector('input[name="led-mode"]:checked')?.value??'1');
  let leds=0;for(let i=0;i<8;i++){if($(`rv-led-rb-${i}`)?.checked)leds|=(1<<i);}
  setRegStatus('rv-st-led','Setting...',true);
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x060'})});let v=parseRegD(d)&~0x3FF;v|=(mode<<8)|leds;await api('/api/register/write',{method:'POST',body:JSON.stringify({offset:'0x060',value:`0x${v.toString(16).padStart(8,'0')}`})});ledModeChanged();setRegStatus('rv-st-led','OK',true);}
  catch(err){setRegStatus('rv-st-led',`Error: ${err.message}`,false);}
}

async function extSwRead() {
  try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x064'})});const v=parseRegD(d);for(let i=0;i<6;i++){const dot=$(`rv-ext-sw-${i}`);if(dot)dot.classList.toggle('connected',((v>>i)&1)!==0);}setRegStatus('rv-st-ext-sw',`0x${(v>>>0).toString(16).toUpperCase().padStart(8,'0')}`,true);}
  catch(err){setRegStatus('rv-st-ext-sw',`Error: ${err.message}`,false);}
}

function clkLimitToMhz(limit){return limit>0?Math.round(limit*2/1e6*1e6)/1e6:0;}
function clkMhzToLimit(mhz){return Math.round(mhz*1e6/2)>>>0;}

async function clkRead() {
  setRegStatus('rv-st-clk-limit','Reading...',true);
  try{
    const d0=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x068'})});
    const d1=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x06C'})});
    const dr=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x0D0'})});
    if($('rv-clk-sys'))$('rv-clk-sys').value=clkLimitToMhz(parseRegD(d0));
    if($('rv-clk-ahb'))$('rv-clk-ahb').value=clkLimitToMhz(parseRegD(d1));
    if($('rv-clk-rgmii'))$('rv-clk-rgmii').value=clkLimitToMhz(parseRegD(dr));
    setRegStatus('rv-st-clk-limit','OK',true);
  }catch(err){setRegStatus('rv-st-clk-limit',`Error: ${err.message}`,false);}
}

async function clkApply(offset,inputId){const mhz=parseFloat($(inputId)?.value||'0');await rvWrite(offset,`0x${clkMhzToLimit(mhz).toString(16).padStart(8,'0')}`,'rv-st-clk-limit');}

// ── COUNT ─────────────────────────────────────────────────────────────────────
async function countRead() {
  const port=$('rv-count-port')?.value||'all';
  setRegStatus('rv-st-count','Reading...',true);
  try{
    const data=await api(`/api/counter/read?port=${encodeURIComponent(port)}`);
    const tbody=$('rv-count-tbody');if(!tbody)return;
    if(!data.counters||data.counters.length===0){tbody.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--muted);">No data — check serial connection</td></tr>';setRegStatus('rv-st-count','No data',false);return;}
    tbody.innerHTML=data.counters.map(c=>`<tr><td>${esc(c.name)}</td><td class="mono" style="font-size:11px;">${esc(c.address)}</td><td class="mono" style="font-size:11px;">${esc(c.value)}</td><td style="text-align:right;">${c.valueDec}</td></tr>`).join('');
    setRegStatus('rv-st-count',`${data.counters.length} counters  port: ${port==='all'?'ALL':`Port ${port}`}`,true);
  }catch(err){setRegStatus('rv-st-count',`Error: ${err.message}`,false);}
}

// ── MDIO ──────────────────────────────────────────────────────────────────────
const MDIO_PHY_ADDRS=[0x00,0x04,0x05,0x08,0x0A,0x0C];

// Per-port setup cache populated by mdioReadAllLink(); null = not yet read
let _mdioSetupsCache = null;

function _applyMdioSetupToUI(setup) {
  if (!setup) return;
  if ($('rv-mdio-en'))    $('rv-mdio-en').checked     = setup.enable     ?? false;
  if ($('rv-mdio-predis'))$('rv-mdio-predis').checked = setup.preDisable ?? false;
  if ($('rv-mdio-intr'))  $('rv-mdio-intr').checked   = setup.intrEnable ?? false;
  if ($('rv-mdio-clk'))   $('rv-mdio-clk').value      = String(setup.clk  ?? 20);
  if ($('rv-mdio-ms'))    $('rv-mdio-ms').value        = String(setup.ms   ?? 2500);
  if ($('rv-mdio-unit'))  $('rv-mdio-unit').value      = String(setup.unit ?? 100);
  if ($('rv-mdio-mhz'))   $('rv-mdio-mhz').value       = String(setup.targetMhz ?? 2.5);
}

function mdioPortChanged() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),phy=MDIO_PHY_ADDRS[port]??0;
  if($('rv-mdio-phy-addr'))$('rv-mdio-phy-addr').value=`0x${phy.toString(16).toUpperCase().padStart(2,'0')}`;
  if (_mdioSetupsCache) _applyMdioSetupToUI(_mdioSetupsCache[port] ?? null);
}

function mdioCalcMdc() {
  const mhz=parseFloat($('rv-mdio-mhz')?.value||'2.5');if(isNaN(mhz)||mhz<=0){setRegStatus('rv-st-mdio','Invalid MHz',false);return;}
  const ahbMhz=100.0,clk=Math.max(1,Math.min(255,Math.round(ahbMhz/(2.0*mhz)))),ms=Math.max(1,Math.min(4095,Math.round(mhz*1000.0)));
  if($('rv-mdio-clk'))$('rv-mdio-clk').value=String(clk);if($('rv-mdio-ms'))$('rv-mdio-ms').value=String(ms);if($('rv-mdio-unit'))$('rv-mdio-unit').value='100';
  setRegStatus('rv-st-mdio',`f_MDC ≈ ${(ahbMhz/(2.0*clk)).toFixed(3)} MHz  (CLK=${clk}, MILLISEC=${ms})`,true);
}

async function mdioReadSetup() {
  const port = parseInt($('rv-mdio-port')?.value || '0');
  const base = 0x0080 + port * 0x0040;
  const setupOff = `0x${base.toString(16).toUpperCase().padStart(8, '0')}`;
  const timeOff  = `0x${(base + 0x0004).toString(16).toUpperCase().padStart(8, '0')}`;
  setRegStatus('rv-st-mdio', 'Reading...', true);
  try {
    const [sd, td] = await Promise.all([
      api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset: setupOff }) }),
      api('/api/register/read', { method: 'POST', body: JSON.stringify({ offset: timeOff  }) }),
    ]);
    const setupVal = parseInt((sd.value || '0').replace(/^0x/i, ''), 16) || 0;
    const timeVal  = parseInt((td.value || '0').replace(/^0x/i, ''), 16) || 0;
    const enable     = Boolean(setupVal & 0x00010000);
    const preDisable = Boolean(setupVal & 0x01000000);
    const intrEnable = Boolean(setupVal & 0x80000000);
    const clk  = timeVal & 0xFF;
    const ms   = (timeVal >>> 8) & 0xFFF;
    const unit = (timeVal >>> 20) & 0xFFF;
    const targetMhz = ms > 0 ? parseFloat((ms / 1000).toFixed(3)) : 2.5;
    _applyMdioSetupToUI({ enable, preDisable, intrEnable, clk, ms, unit, targetMhz });
    setRegStatus('rv-st-mdio', `Port ${port}: SETUP=0x${setupVal.toString(16).toUpperCase().padStart(8,'0')}`, true);
  } catch(err) { setRegStatus('rv-st-mdio', `Error: ${err.message}`, false); }
}

async function mdioApplySetup() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),enable=$('rv-mdio-en')?.checked??false,preDisable=$('rv-mdio-predis')?.checked??false,intrEnable=$('rv-mdio-intr')?.checked??false,targetMhz=parseFloat($('rv-mdio-mhz')?.value||'2.5');
  setRegStatus('rv-st-mdio','Applying...',true);
  try{const data=await api('/api/mdio/setup',{method:'POST',body:JSON.stringify({port,enable,preDisable,interruptEnable:intrEnable,targetMhz})});setRegStatus('rv-st-mdio',`SETUP=0x${String(data.setup||'').replace(/^0x/i,'')}  CLK=${data.clk}`,true);}
  catch(err){setRegStatus('rv-st-mdio',`Error: ${err.message}`,false);}
}

async function mdioReadPhy() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),phyAddr=$('rv-mdio-phy-addr')?.value||'0x00',regAddr=$('rv-mdio-reg-addr')?.value||'0x01';
  setRegStatus('rv-st-mdio-acc','Reading...',true);
  try{const data=await api('/api/mdio/read',{method:'POST',body:JSON.stringify({port,phyAddr,regAddr})});if($('rv-mdio-acc-data'))$('rv-mdio-acc-data').value=data.value||'0x0000';setRegStatus('rv-st-mdio-acc',`PHY[${phyAddr}] Reg[${regAddr}] = ${data.value}`,true);}
  catch(err){setRegStatus('rv-st-mdio-acc',`Error: ${err.message}`,false);}
}

async function mdioWritePhy() {
  const port=parseInt($('rv-mdio-port')?.value||'0'),phyAddr=$('rv-mdio-phy-addr')?.value||'0x00',regAddr=$('rv-mdio-reg-addr')?.value||'0x01',value=$('rv-mdio-acc-data')?.value||'0x0000';
  setRegStatus('rv-st-mdio-acc','Writing...',true);
  try{await api('/api/mdio/write',{method:'POST',body:JSON.stringify({port,phyAddr,regAddr,value})});setRegStatus('rv-st-mdio-acc',`PHY[${phyAddr}] Reg[${regAddr}] ← ${value} OK`,true);}
  catch(err){setRegStatus('rv-st-mdio-acc',`Error: ${err.message}`,false);}
}

async function mdioReadAllLink() {
  setRegStatus('rv-st-mdio-link','Reading...',true);
  try {
    const data = await api('/api/mdio/link-status');
    if (data.ports) {
      data.ports.forEach(p => {
        const td = $(`rv-mdio-link-${p.port}`);
        if (!td) return;
        const linked = p.linkUp === true;
        const label  = p.linkUp === null ? '—' : (p.linkUp ? 'Link UP' : 'Link DOWN');
        td.innerHTML = `<span class="led-dot${linked?' connected':''}"></span> ${label}`;
      });
      // Cache per-port setup data and populate SETUP fields for the current port
      _mdioSetupsCache = data.ports.map(p => p.setup ?? null);
      const curPort = parseInt($('rv-mdio-port')?.value || '0');
      _applyMdioSetupToUI(_mdioSetupsCache[curPort] ?? null);
      setRegStatus('rv-st-mdio', `Read from HW (Port ${curPort})`, true);
    }
    setRegStatus('rv-st-mdio-link', `Updated ${new Date().toLocaleTimeString()}`, true);
  } catch(err) {
    setRegStatus('rv-st-mdio-link', `Error: ${err.message}`, false);
  }
}

function initRegViewer() {
  const rc=$('regContent');if(!rc)return;

  rc.addEventListener('click', async e => {
    const btn=e.target.closest('[data-rw]');if(!btn)return;
    const rw=btn.dataset.rw,valId=btn.dataset.val,stId=btn.dataset.st,offset=btn.dataset.offVal||(btn.dataset.off?$(btn.dataset.off)?.value||btn.dataset.off:null);
    if(!offset)return;
    try{if(rw==='read'){await rvRead(offset,valId,stId);}else{const val=valId&&$(valId)?$(valId).value:'0x00000000';await rvWrite(offset,val,stId);}}catch{/* status already set */}
  });

  const sysctlReadVersion=async()=>{try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x000'})});const v=parseInt(d.value||`0x${(d.valueDec||0).toString(16)}`,16)>>>0;if($('rv-ver-str'))$('rv-ver-str').value=parseSysCtrlVersion(v);setRegStatus('rv-st-version','OK',true);}catch(err){setRegStatus('rv-st-version',`Error: ${err.message}`,false);}};
  const sysctlReadEnable=async()=>{try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x008'})});syncSysCtrlEnable(parseInt(d.value||`0x${(d.valueDec||0).toString(16)}`,16)>>>0);setRegStatus('rv-st-enable','OK',true);}catch(err){setRegStatus('rv-st-enable',`Error: ${err.message}`,false);}};
  const sysctlReadHostIf=async()=>{try{const d=await api('/api/register/read',{method:'POST',body:JSON.stringify({offset:'0x00C'})});syncHostIf(parseInt(d.value||`0x${(d.valueDec||0).toString(16)}`,16)>>>0);setRegStatus('rv-st-ahb','OK',true);}catch(err){setRegStatus('rv-st-ahb',`Error: ${err.message}`,false);}};
  $('rv-ver-default')?.addEventListener('click',async()=>{await rvWrite('0x004','0x00000001','rv-st-version');});
  $('rv-en-apply')?.addEventListener('click',async()=>{await rvWrite('0x008',`0x${buildSysCtrlEnable().toString(16).toUpperCase().padStart(8,'0')}`,'rv-st-enable');});
  $('rv-ahb-apply')?.addEventListener('click',async()=>{await rvWrite('0x00C',`0x${buildHostIf().toString(16).toUpperCase().padStart(8,'0')}`,'rv-st-ahb');});
  $('sysctlReadAll')?.addEventListener('click',async()=>{await sysctlReadVersion();await sysctlReadEnable();await sysctlReadHostIf();});

  initIntrDots();
  $('interruptReadAll')?.addEventListener('click',async()=>{await intrCtrlRead();await intrRawRead();await intrMaskRead();});
  $('rv-intr-ctrl-apply')?.addEventListener('click',intrCtrlApply);
  $('rv-intr-raw-poll')?.addEventListener('click',intrTogglePoll);
  $('rv-intr-mask-apply')?.addEventListener('click',intrMaskApply);
  $('rv-intr-sw-trigger')?.addEventListener('click',intrSwTrigger);

  $('timestampReadAll')?.addEventListener('click',async()=>{await tsReadTime();await tsReadClock();});
  $('rv-ts-now')?.addEventListener('click',tsSetNow);$('rv-ts-set-time')?.addEventListener('click',tsSetTime);
  $('rv-ts-apply-all')?.addEventListener('click',async()=>{await tsApplyClock();await tsApplyPps();});
  $('rv-ts-apply-adj')?.addEventListener('click',tsApplyAdj);

  initLedDots();
  document.querySelectorAll('input[name="led-mode"]').forEach(r=>r.addEventListener('change',ledModeChanged));
  $('ledclockReadAll')?.addEventListener('click',async()=>{await ledRead();await extSwRead();await clkRead();});
  $('rv-led-apply')?.addEventListener('click',ledApply);
  $('rv-clk-apply-all')?.addEventListener('click',async()=>{await clkApply('0x068','rv-clk-sys');await clkApply('0x06C','rv-clk-ahb');await clkApply('0x0D0','rv-clk-rgmii');});

  const TD_OFFSETS=['0x040','0x044','0x048','0x04C','0x050','0x054','0x058','0x05C'];
  $('testdataReadAll')?.addEventListener('click',async()=>{for(let i=0;i<TD_OFFSETS.length;i++)await rvRead(TD_OFFSETS[i],`rv-td-${i}`,`rv-st-td-${i}`);});
  $('testdataWriteAll')?.addEventListener('click',async()=>{for(let i=0;i<TD_OFFSETS.length;i++)await rvWrite(TD_OFFSETS[i],$(`rv-td-${i}`)?.value||'0x00000000',`rv-st-td-${i}`);});

  $('rv-count-read')?.addEventListener('click',countRead);
  $('rv-count-clear')?.addEventListener('click',()=>{const tbody=$('rv-count-tbody');if(tbody)tbody.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--muted);">No data</td></tr>';setRegStatus('rv-st-count','',true);});

  $('rv-mdio-port')?.addEventListener('change',mdioPortChanged);$('rv-mdio-calc')?.addEventListener('click',mdioCalcMdc);$('rv-mdio-read-setup')?.addEventListener('click',mdioReadSetup);$('rv-mdio-apply')?.addEventListener('click',mdioApplySetup);$('rv-mdio-read-phy')?.addEventListener('click',mdioReadPhy);$('rv-mdio-write-phy')?.addEventListener('click',mdioWritePhy);$('rv-mdio-read-link')?.addEventListener('click',mdioReadAllLink);

  $('rv-fdb-read-config')?.addEventListener('click',fdbCtrlReadConfig);$('fdbReadConfig')?.addEventListener('click',fdbCtrlReadConfig);
  $('rv-fdb-apply-en')?.addEventListener('click',fdbCtrlApplyEnable);
  $('rv-fdb-load-default')?.addEventListener('click',fdbCtrlLoadDefault);

  // ── FDB MODE (0xA08) ────────────────────────────────────────────────────────
  const FDB_MODE_OFF = 0xA08;
  const FDB_MODE_BITS = [0,1,2,3,4,5,8,9];

  $('rv-fdb-mode-read')?.addEventListener('click', async () => {
    const st = $('rv-st-fdb-mode');
    setRegStatus('rv-st-fdb-mode','Reading...',false);
    try {
      const val = await rvRead(FDB_MODE_OFF);
      FDB_MODE_BITS.forEach(b => {
        const el = $('rv-fdb-mode-' + b);
        if (el) el.checked = !!(val & (1 << b));
      });
      setRegStatus('rv-st-fdb-mode','0x' + (val>>>0).toString(16).toUpperCase().padStart(8,'0'),true);
    } catch(e) { setRegStatus('rv-st-fdb-mode','Error: '+e.message,false); }
  });

  $('rv-fdb-mode-apply')?.addEventListener('click', async () => {
    let val = 0;
    FDB_MODE_BITS.forEach(b => {
      const el = $('rv-fdb-mode-' + b);
      if (el && el.checked) val |= (1 << b);
    });
    setRegStatus('rv-st-fdb-mode','Applying...',false);
    try {
      await rvWrite(FDB_MODE_OFF, val);
      setRegStatus('rv-st-fdb-mode','Applied 0x'+(val>>>0).toString(16).toUpperCase().padStart(8,'0'),true);
    } catch(e) { setRegStatus('rv-st-fdb-mode','Error: '+e.message,false); }
  });
  (()=>{
    const FDB_MAC_OPTIONS = [
      { label:'Port 0 (enp12s0f0)', value:'A0:36:9F:A8:DA:60' },
      { label:'Port 1 (enp12s0f1)', value:'A0:36:9F:A8:DA:61' },
      { label:'Port 2 (enp12s0f2)', value:'A0:36:9F:A8:DA:62' },
      { label:'Port 3 (enp12s0f3)', value:'A0:36:9F:A8:DA:63' },
    ];
    let _drop = null;
    function _closeDrop(){ if(_drop){ _drop.remove(); _drop=null; } }
    $('rv-fdb-mac-pick')?.addEventListener('click', e => {
      e.stopPropagation();
      if(_drop){ _closeDrop(); return; }
      const btn = $('rv-fdb-mac-pick');
      const inp = $('rv-fdb-mac');
      if(!btn||!inp) return;
      const rect = btn.getBoundingClientRect();
      _drop = document.createElement('div');
      _drop.style.cssText = `position:fixed;z-index:9999;background:var(--surf,#1e1e1e);border:1px solid var(--border,#444);border-radius:4px;min-width:220px;box-shadow:0 4px 12px rgba(0,0,0,.4);top:${rect.bottom+2}px;left:${rect.left}px;`;
      FDB_MAC_OPTIONS.forEach(opt => {
        const row = document.createElement('div');
        row.textContent = `${opt.label}  ${opt.value}`;
        row.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:12px;font-family:monospace;white-space:nowrap;';
        row.addEventListener('mouseenter', ()=> row.style.background='var(--hover,#333)');
        row.addEventListener('mouseleave', ()=> row.style.background='');
        row.addEventListener('click', ()=>{ inp.value=opt.value; _closeDrop(); });
        _drop.appendChild(row);
      });
      document.body.appendChild(_drop);
      setTimeout(()=> document.addEventListener('click', _closeDrop, {once:true}), 0);
    });
  })();
  $('rv-fdb-rdhash')?.addEventListener('click',fdbReadByHash);$('rv-fdb-rdbucket')?.addEventListener('click',fdbReadByBucket);
  $('rv-fdb-wrhash')?.addEventListener('click',fdbWriteByHash);$('rv-fdb-wrbucket')?.addEventListener('click',fdbWriteByBucket);
  $('rv-fdb-delete')?.addEventListener('click',fdbDeleteByHash);$('rv-fdb-initall')?.addEventListener('click',fdbInitAll);

  // ── Flood Mask Table ──────────────────────────────────────────────────────────
  function floodSession() { return $('serialPort')?.value || ''; }

  function floodMaskFromCheckboxes() {
    let mask = 0;
    document.querySelectorAll('.fdb-flood-port').forEach(chk => {
      if (chk.checked) mask |= (1 << Number(chk.dataset.bit));
    });
    return mask;
  }

  function floodMaskToCheckboxes(mask) {
    document.querySelectorAll('.fdb-flood-port').forEach(chk => {
      chk.checked = !!(mask & (1 << Number(chk.dataset.bit)));
    });
  }

  $('rv-fdb-flood-read')?.addEventListener('click', async () => {
    const vlanId = parseInt($('rv-fdb-flood-vlan')?.value || '0') & 0xFFF;
    setRegStatus('rv-st-fdb-flood', 'Reading...', false);
    try {
      const res = await api('/api/fdb/flood-read', {
        method: 'POST',
        body: JSON.stringify({ session: floodSession(), vlanId })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      floodMaskToCheckboxes(res.mask);
      setRegStatus('rv-st-fdb-flood',
        `VLAN ${res.vlanId} → mask=0x${res.mask.toString(16).toUpperCase().padStart(3,'0')} (0b${res.mask.toString(2).padStart(9,'0')})`, true);
    } catch(e) { setRegStatus('rv-st-fdb-flood', `Error: ${e.message}`, false); }
  });

  $('rv-fdb-flood-write')?.addEventListener('click', async () => {
    const vlanId = parseInt($('rv-fdb-flood-vlan')?.value || '0') & 0xFFF;
    const mask   = floodMaskFromCheckboxes();
    setRegStatus('rv-st-fdb-flood', 'Writing...', false);
    try {
      const res = await api('/api/fdb/flood-write', {
        method: 'POST',
        body: JSON.stringify({ session: floodSession(), vlanId, mask })
      });
      if (!res.ok) throw new Error(res.error || 'write failed');
      setRegStatus('rv-st-fdb-flood',
        `VLAN ${vlanId} written → mask=0x${mask.toString(16).toUpperCase().padStart(3,'0')}`, true);
    } catch(e) { setRegStatus('rv-st-fdb-flood', `Error: ${e.message}`, false); }
  });

  $('rv-fdb-flood-init')?.addEventListener('click', async () => {
    if (!confirm('Flood Mask 테이블을 초기화하시겠습니까?')) return;
    setRegStatus('rv-st-fdb-flood', 'Initializing...', false);
    try {
      const res = await api('/api/fdb/flood-init', {
        method: 'POST',
        body: JSON.stringify({ session: floodSession() })
      });
      if (!res.ok) throw new Error(res.error || 'init failed');
      floodMaskToCheckboxes(0);
      setRegStatus('rv-st-fdb-flood', 'Flood Mask initialized', true);
    } catch(e) { setRegStatus('rv-st-fdb-flood', `Error: ${e.message}`, false); }
  });

  $('regBaseAddr')?.addEventListener('keydown',async function(e){if(e.key!=='Enter')return;e.preventDefault();const val=this.value.trim();if(!val)return;try{await api('/api/register/base-addr',{method:'POST',body:JSON.stringify({address:val})});}catch{/*worker mode*/}await refreshRegStatus();});
  $('regBaseAddr')?.addEventListener('blur',async function(){const val=this.value.trim();if(!val)return;try{await api('/api/register/base-addr',{method:'POST',body:JSON.stringify({address:val})});}catch{/*worker mode*/}});
}

// ── TOC Navigation ────────────────────────────────────────────────────────────
function initTocNav() {
  document.querySelectorAll('[data-sec]').forEach(btn => {
    btn.addEventListener('click', () => {
      // 모든 활성 상태 초기화
      document.querySelectorAll('[data-sec]').forEach(b => b.classList.remove('toc-active'));

      // 클릭한 버튼 활성화
      btn.classList.add('toc-active');

      // sub 클릭 시 부모 toc-head도 활성화
      if (btn.classList.contains('toc-sub')) {
        const group = btn.closest('.toc-group');
        if (group) {
          const head = group.querySelector('.toc-head');
          if (head) head.classList.add('toc-active');
        }
      }

      // 대상 섹션 스크롤 + 하이라이트
      const target = document.getElementById(`rsec-${btn.dataset.sec}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // 그룹 하이라이트 (data-highlight-group 있으면 같은 그룹 전체)
        const group = target.dataset.highlightGroup;
        const targets = group
          ? document.querySelectorAll(`[data-highlight-group="${group}"]`)
          : [target];
        targets.forEach(el => {
          el.style.outline = '2px solid var(--accent)';
          el.style.outlineOffset = '2px';
        });
        setTimeout(() => {
          targets.forEach(el => { el.style.outline = ''; el.style.outlineOffset = ''; });
        }, 1500);
      }
    });
  });
}

// ── Layout Toggle & Splitter ──────────────────────────────────────────────────
function initLayoutToggle() {
  const btn=$('layoutToggle'),wrap=$('hyperContent');if(!btn||!wrap)return;
  let vert=false; // default: horizontal (terminal on right)
  btn.textContent='⊞'; btn.title='Vertical layout';
  btn.addEventListener('click',()=>{
    vert=!vert;
    wrap.classList.toggle('vertical',vert);
    btn.textContent=vert?'⊟':'⊞';
    btn.title=vert?'Horizontal layout':'Vertical layout';
  });
}

function initSplitter() {
  const splitter=$('hyperSplitter'),wrap=$('hyperContent'),terminal=document.querySelector('.hyper-terminal');
  if(!splitter||!wrap||!terminal)return;
  let dragging=false,startPos=0,startSize=0;
  splitter.addEventListener('mousedown',e=>{
    dragging=true;
    const isVert=wrap.classList.contains('vertical');
    startPos=isVert?e.clientY:e.clientX;
    startSize=isVert?terminal.offsetHeight:terminal.offsetWidth;
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const isVert=wrap.classList.contains('vertical');
    const delta=(isVert?e.clientY:e.clientX)-startPos;
    const size=Math.max(80,startSize-delta);
    terminal.style[isVert?'height':'width']=`${size}px`;
  });
  document.addEventListener('mouseup',()=>{dragging=false;});
}

// ── HyperTerminal (Serial) ────────────────────────────────────────────────────
function updateSerialUI(connected, statusText) {
  state.serialConnected = connected;
  updateStatusBar();
  const led=$('serialLed'),st=$('serialState');
  if(led)led.classList.toggle('connected',connected);
  const toggleBtn=$('serialToggle');
  if(toggleBtn){toggleBtn.textContent=connected?'Disconnect':'Connect';toggleBtn.className=connected?'small danger':'primary small';}
  if(st&&statusText!==undefined)st.textContent=statusText;
  const brk=$('serialBrk');if(brk)brk.disabled=!connected;
}

function appendHyperTerm(text) {
  const now=new Date(),ts=`[${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3,'0')}]`;
  const line=`${ts}  ${text}\n`;
  const out=$('serialOutput');
  if(out){if(out.textContent==='No terminal output.')out.textContent='';out.textContent+=line;out.scrollTop=out.scrollHeight;}
  const seq=$('seqTerminal');
  if(seq){if(seq.textContent==='No output.')seq.textContent='';seq.textContent+=line;seq.scrollTop=seq.scrollHeight;}
}

let _ttyStreamCtrl=null;
let _ttyStreamSession='';
let _hyperTermLineBuffer='';
// Device-echo suppression: { cmd: count } — suppress one echo per outstanding command
const _echoSuppress=new Map();
function suppressEchoOnce(cmd){_echoSuppress.set(cmd,(_echoSuppress.get(cmd)||0)+1);setTimeout(()=>{const c=(_echoSuppress.get(cmd)||0)-1;if(c<=0)_echoSuppress.delete(cmd);else _echoSuppress.set(cmd,c);},2000);}
function checkSuppressEcho(line){const c=_echoSuppress.get(line)||0;if(c>0){if(c===1)_echoSuppress.delete(line);else _echoSuppress.set(line,c-1);return true;}return false;}

function startTtyStream(session) {
  if(_ttyStreamCtrl)_ttyStreamCtrl.abort();
  _ttyStreamCtrl=new AbortController();
  _ttyStreamSession=session||'';
  _hyperTermLineBuffer='';
  const url=`/api/tty/stream${session?`?session=${encodeURIComponent(session)}`:''}`;
  fetch(url,{signal:_ttyStreamCtrl.signal}).then(r=>{
    const reader=r.body.getReader(),decoder=new TextDecoder();
    let buf='';
    function read(){reader.read().then(({done,value})=>{
      if(done){if(_ttyStreamCtrl&&!_ttyStreamCtrl.signal.aborted)setTimeout(()=>startTtyStream(_ttyStreamSession),3000);return;}
      buf+=decoder.decode(value,{stream:true});
      const parts=buf.split('\n');buf=parts.pop()??'';
      for(const part of parts){const s=part.trim();if(!s)continue;try{const msg=JSON.parse(s);
        if(msg.type==='rx'&&msg.hex){const bytes=Uint8Array.from(msg.hex.match(/.{1,2}/g)||[],b=>parseInt(b,16));const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes);_hyperTermLineBuffer+=text;const lines=_hyperTermLineBuffer.split(/\r?\n/);_hyperTermLineBuffer=lines.pop()??'';lines.filter(l=>l.trim()).forEach(l=>{const s=l.replace(/^CMD>\s*/,'');if(!s.trim())return;if(!checkSuppressEcho(s.trim()))appendHyperTerm(s);});}
        else if(msg.type==='closed'){updateSerialUI(false,'disconnected');stopTtyStream();}
        else if(msg.type==='error'){appendHyperTerm(`[ERR] ${msg.message}`);}
      }catch{/*ignore*/}}
      read();
    }).catch(e=>{if(e?.name!=='AbortError'&&_ttyStreamCtrl&&!_ttyStreamCtrl.signal.aborted)setTimeout(()=>startTtyStream(_ttyStreamSession),3000);});}
    read();
  }).catch(e=>{if(e?.name!=='AbortError'&&_ttyStreamCtrl)setTimeout(()=>startTtyStream(_ttyStreamSession),3000);});
}

function stopTtyStream() { if(_ttyStreamCtrl){_ttyStreamCtrl.abort();_ttyStreamCtrl=null;} }

async function refreshSerialStatus() {
  try {
    const data=await api('/api/serial/status');
    const t=data.terminal||{};
    const ttys=data.ttys||data.ports||t.ports||[];
    const portSel=$('serialPort');
    if(portSel){
      const cur=portSel.value||t.selectedPort||data.session||'';
      portSel.innerHTML=ttys.map(p=>{const val=p.path||p.portName||p.PortName||p.name||String(p),label=p.manufacturer?`${val}  (${p.manufacturer})`:(p.displayName||p.DisplayName||p.usbProduct||val);return `<option value="${esc(val)}">${esc(label)}</option>`;}).join('');
      if(!portSel.innerHTML)portSel.innerHTML='<option value="">-- No ports --</option>';
      if(cur&&portSel.querySelector(`option[value="${cur}"]`))portSel.value=cur;
    }
    const baudSel=$('serialBaud');
    if(baudSel){
      const cur=baudSel.value||String(t.selectedBaudRate||115200);
      const rates=t.baudRates||[9600,19200,38400,57600,115200,230400,921600];
      if(!baudSel.options.length||(t.baudRates&&baudSel.options.length!==rates.length))baudSel.innerHTML=rates.map(b=>`<option value="${b}">${b}</option>`).join('');
      baudSel.value=t.selectedBaudRate?String(t.selectedBaudRate):cur;
    }
    const connected=!!(data.open||data.connected||t.isConnected);
    const statusTxt=t.connectionStatus||(connected?`connected (${data.session||''})`:' disconnected');
    updateSerialUI(connected,statusTxt);
    if(connected&&!_ttyStreamCtrl)startTtyStream(data.session||data.sessionId||'');
    const out=$('serialOutput');
    if(out&&t.terminalOutput!==undefined){out.textContent=t.terminalOutput||'No terminal output.';out.scrollTop=out.scrollHeight;}
  } catch { updateSerialUI(false,'offline'); }
}

async function toggleSerial(connect) {
  if(connect===false||state.serialConnected) {
    stopTtyStream();
    try{await api('/api/serial/disconnect',{method:'POST',body:'{}'});toast('Serial disconnected','ok');}catch(err){toast(`Disconnect failed: ${err.message}`,'bad');}
  } else {
    const port=$('serialPort')?.value,baud=Number($('serialBaud')?.value)||115200;
    if(!port){toast('Select a port first','warn');return;}
    try{const res=await api('/api/serial/connect',{method:'POST',body:JSON.stringify({port,baudRate:baud,path:port})});if(!res?.terminal)startTtyStream(res?.session||res?.sessionId||port);toast(`Connected: ${port} @ ${baud} bps`,'ok');}
    catch(err){toast(`Serial error: ${err.message}`,'bad');}
  }
  await refreshSerialStatus();
}

async function sendSerial() {
  const inp=$('serialInput');if(!inp?.value.trim())return;
  const text=inp.value+'\r\n';
  try{await api('/api/serial/send',{method:'POST',body:JSON.stringify({text})});appendHyperTerm(`> ${inp.value}`);inp.value='';}
  catch(err){toast(`Send failed: ${err.message}`,'bad');}
}

// ── Logs ──────────────────────────────────────────────────────────────────────
async function loadLogs() {
  try{
    const data=await api('/api/logs');const box=$('logsBox');if(!box)return;
    const fmtEntry=(e,kind)=>{if(e.error)return `[${kind}] parse error: ${e.file}\n`;const ts=e.startedAt||e.timestamp||e.createdAt||'',name=e.name||e.testName||e.macroName||e.id||'?',result=e.result||e.status||(e.passed!=null?(e.passed?'PASS':'FAIL'):'');return `${ts?new Date(ts).toLocaleString()+'  '  :''}[${kind}] ${name}  ${result}\n`;};
    const tests=(data.tests||[]).map(e=>fmtEntry(e,'TEST')),macros=(data.macros||[]).map(e=>fmtEntry(e,'MACRO'));
    const all=[...tests,...macros];box.textContent=all.length?all.join(''):  '(no logs yet)';
  }catch(err){if($('logsBox'))$('logsBox').textContent=`Log load failed: ${err.message}`;}
}

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar() {
  const pkts=state.captureRows.length;
  const serial=state.serialConnected?'● Serial':'○ Serial';
  const cap=state.captureTimer?`● Cap ${pkts}pkts`:`○ Cap ${pkts}pkts`;
  const sb=$('statusExtra');if(sb)sb.textContent=`${serial}   ${cap}`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function initWebSocket() {
  const ws=new WebSocket(`ws://${location.host}`);
  ws.onmessage=({data})=>{try{const msg=JSON.parse(data);if(msg.type==='workerEvent'){const p=msg.payload||{};if(p.type==='serialData'||p.type==='terminal'){appendSeqTerm(p.text||p.data||'');}}}catch{/*ignore*/}};
  ws.onclose=()=>setTimeout(initWebSocket,3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  initTabs();
  initWebSocket();
  initSplitter();
  initTocNav();
  initRegViewer();


  // Packet Generator
  $('refreshAll')?.addEventListener('click', refreshInterfaces);
  $('build')?.addEventListener('click', previewFrame);
  $('send')?.addEventListener('click', sendFrame);
  ['protocol','dstMac','srcMac','srcIp','dstIp','srcPort','dstPort','payload','vlanEnabled','vlanId','vlanPriority']
    .forEach(id=>$(id)?.addEventListener('change',previewFrame));

  // Capture
  $('captureRefresh')?.addEventListener('click', refreshCaptureStatus);
  $('captureStart')?.addEventListener('click', startCapture);
  $('captureStop')?.addEventListener('click', stopCapture);
  $('captureClear')?.addEventListener('click', clearCapture);
  $('captureExportCsv')?.addEventListener('click', downloadCaptureCsv);
  $('captureFilter')?.addEventListener('input', () => {
    const val = ($('captureFilter')?.value || '').trim();
    document.querySelectorAll('.proto-chip').forEach(b => b.classList.remove('active'));
    const exact = [...document.querySelectorAll('.proto-chip')].find(b => (b.dataset.proto||'').toLowerCase() === val.toLowerCase());
    if (exact) exact.classList.add('active');
    else if (!val) document.querySelector('.proto-chip[data-proto=""]')?.classList.add('active');
    renderCaptureRows();
  });

  document.querySelectorAll('.proto-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.proto-chip').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const f=$('captureFilter');if(f){f.value=btn.dataset.proto||'';renderCaptureRows();}
    });
  });
  document.querySelector('.proto-chip[data-proto=""]')?.classList.add('active');

  // Scenario Lab
  $('tcRefresh')?.addEventListener('click', loadTestCases);
  $('tcImportCsv')?.addEventListener('click', importCsvScenarios);
  $('tcAddGroup')?.addEventListener('click', addTcGroup);
  $('tcAdd')?.addEventListener('click', addTcFromCurrent);
  $('tcSaveCurrent')?.addEventListener('click', saveTcCurrent);
  // seqRun/seqStop/seqClear/seqLoad wired in initApp()
  $('seqLoad')?.addEventListener('click', loadSequence);
  $('seqTermSend')?.addEventListener('click', seqTermSend);
  $('seqTermInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')seqTermSend();});
  $('clearSeqTerminal')?.addEventListener('click', ()=>{if($('seqTerminal'))$('seqTerminal').textContent='';});

  // Event palette (inline editor)
  document.querySelectorAll('.palette-item[data-event]').forEach(el => {
    el.addEventListener('click', () => showEventEditor(el.dataset.event));
  });
  $('addToSequence')?.addEventListener('click', () => {
    const btn = $('addToSequence');
    if (btn?.dataset.editMode === 'update') updateRowFromEditor();
    else addEventFromEditor();
  });

  // Modal events (keep for compatibility)
  $('evModalOk')?.addEventListener('click', confirmEventModal);
  $('evModalCancel')?.addEventListener('click', closeEventModal);
  $('evModalClose')?.addEventListener('click', closeEventModal);
  $('eventModal')?.addEventListener('click', e=>{if(e.target===$('eventModal'))closeEventModal();});
  document.addEventListener('keydown', e=>{if(e.key==='Escape'&&$('eventModal')?.style.display!=='none')closeEventModal();});

  // Register / FDB (Scenario Lab)
  $('regStatusRefresh')?.addEventListener('click', refreshRegStatus);
  $('regRead')?.addEventListener('click', readRegister);
  $('regWrite')?.addEventListener('click', writeRegister);
  $('fdbRead')?.addEventListener('click', ()=>fdbCall('/api/fdb/read'));
  $('fdbWrite')?.addEventListener('click', ()=>fdbCall('/api/fdb/write'));
  $('fdbDelete')?.addEventListener('click', ()=>fdbCall('/api/fdb/delete'));
  $('fdbFlush')?.addEventListener('click', ()=>{if(confirm('Flush all FDB entries?'))fdbCall('/api/fdb/flush',{});});

  // HyperTerminal
  $('serialRefresh')?.addEventListener('click', refreshSerialStatus);
  $('serialToggle')?.addEventListener('click', ()=>toggleSerial());
  $('serialSend')?.addEventListener('click', sendSerial);
  $('serialInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')sendSerial();});
  $('serialClear')?.addEventListener('click', async ()=>{
    try{await api('/api/serial/clear',{method:'POST',body:'{}'});}catch{/*best effort*/}
    if($('serialOutput'))$('serialOutput').textContent='';
    _hyperTermLineBuffer='';
  });
  $('serialBrk')?.addEventListener('click', async ()=>{
    try{await api('/api/serial/brk',{method:'POST',body:'{}'});toast('BRK signal sent','ok');}
    catch(err){
      // fallback to /api/serial/break
      try{await api('/api/serial/break',{method:'POST',body:'{}'});toast('BRK signal sent','ok');}
      catch{toast(`BRK failed: ${err.message}`,'bad');}
    }
  });

  // Settings
  $('refreshLogs')?.addEventListener('click', loadLogs);

  // Port Map
  $('portmapReload')?.addEventListener('click', loadPortMap);
  $('portmapSave')?.addEventListener('click', savePortMap);
  $('portmapProbeB')?.addEventListener('click', probePortMapB);

  // 2-PC Experiment
  $('twoPcProbeA')?.addEventListener('click', () => twoPcProbe('A'));
  $('twoPcProbeB')?.addEventListener('click', () => twoPcProbe('B'));
  $('twoPcRun')?.addEventListener('click', run2pcTest);

  // Matrix Test
  $('matrixLoadPorts')?.addEventListener('click', loadMatrixFromPortmap);
  $('matrixRun')?.addEventListener('click', runMatrixTest);
  $('matrixStop')?.addEventListener('click', () => { _matrixAbort = true; });
  $('matrixExportCsv')?.addEventListener('click', exportMatrixCsv);

  // Benchmark
  $('benchLoadPorts')?.addEventListener('click', benchLoadPorts);
  $('benchRun')?.addEventListener('click', runBenchmark);
  $('benchStop')?.addEventListener('click', () => { _benchAbort = true; });
  $('benchExportReport')?.addEventListener('click', exportBenchmarkReport);

  // Matrix Benchmark
  $('benchMxRun')?.addEventListener('click', runMatrixBenchmark);
  $('benchMxStop')?.addEventListener('click', () => { _benchMxAbort = true; });
  $('benchMxExportReport')?.addEventListener('click', exportMatrixBenchReport);

  try {
    await api('/api/health');
    setStatus('Connected');
    await Promise.allSettled([
      refreshInterfaces(),
      _loadPortmapSilent(),
      loadLogs(),
      refreshSerialStatus(),
      refreshRegStatus(),
      loadTestCases(),
      loadSequence(),
    ]);
    startCapturePolling();
    // Serial polling every 1500ms when on HyperTerminal tab
    state.serialTimer = setInterval(() => {
      const activeView = document.querySelector('.view.active');
      if (activeView?.id === 'hyperTermView') refreshSerialStatus();
    }, 1500);
    // Interface auto-refresh every 1s (silent — only updates selects when list changes)
    setInterval(() => _silentRefreshInterfaces(), 1000);
  } catch (err) {
    setStatus(`Offline — ${err.message}`, false);
    toast(`Server not reachable: ${err.message}`, 'bad');
  }
}

// ── Proto block helpers (delegate to data model) ──────────────────────────────
function addProtoBlock(proto) { addProtoBlockToPacket(proto); }
function removeProtoBlock(proto) { const pkt=getActivePackets()[state.selectedPacketIdx]; if(!pkt)return; const bi=pkt.blocks.findIndex(b=>b.type===proto); if(bi>=0)removeBlockAt(bi); }
function selectProtoBlock(proto) { const pkt=getActivePackets()[state.selectedPacketIdx]; if(!pkt)return; const bi=pkt.blocks.findIndex(b=>b.type===proto); if(bi>=0)selectBlock(bi); }

// ── Panel toggles + drag-and-drop ─────────────────────────────────────────────
function initLayoutExtras() {
  $('ifaceToggle')?.addEventListener('click', () => { document.querySelector('.cap-iface-panel')?.classList.toggle('collapsed'); });
  $('regViewerToggle')?.addEventListener('click', () => { $('regViewerPanel')?.classList.toggle('collapsed'); });

  document.querySelectorAll('.palette-proto[draggable]').forEach(el => {
    el.addEventListener('dragstart', e => {
      _dragBlockIdx = -1;
      e.dataTransfer.setData('proto', el.dataset.proto);
    });
  });
  const blockList = $('blockList');
  if (blockList) {
    blockList.addEventListener('dragover', e => { e.preventDefault(); blockList.classList.add('drag-over'); });
    blockList.addEventListener('dragleave', e => { if (!blockList.contains(e.relatedTarget)) blockList.classList.remove('drag-over'); });
    blockList.addEventListener('drop', e => {
      e.preventDefault(); blockList.classList.remove('drag-over');
      if (_dragBlockIdx >= 0) { _dragBlockIdx = -1; return; } // handled by block chip
      const proto = e.dataTransfer.getData('proto'); if (proto) addProtoBlockToPacket(proto);
    });
  }
}

// ── initApp: wire new IDs not handled by preserved init() ─────────────────────
function initApp() {
  // Packet Generator
  $('pgAddPacket')?.addEventListener('click', addPacket);
  $('pgPeriod')?.addEventListener('input', updateEstimatedTime);
  $('pgDelPacket')?.addEventListener('click', deleteSelectedPackets);
  $('pgUpPacket')?.addEventListener('click', () => movePacket(-1));
  $('pgDownPacket')?.addEventListener('click', () => movePacket(1));
  $('pgDupPacket')?.addEventListener('click', duplicatePacket);
  $('pgSelectAll')?.addEventListener('change', e => {
    document.querySelectorAll('.pkt-chk').forEach(c => { c.checked = e.target.checked; const p = getActivePackets()[Number(c.dataset.idx)]; if (p) p.checked = e.target.checked; });
  });
  $('pgSendSelected')?.addEventListener('click', sendSelectedPackets);
  $('pgSendList')?.addEventListener('click', sendPacketList);
  // TC floating dropdown
  $('pgTcBtn')?.addEventListener('click', e => { e.stopPropagation(); toggleTcDropdown(); });
  $('pgTcClose')?.addEventListener('click', clearTcMode);
  // close dropdown on outside click
  document.addEventListener('click', e => {
    if (_tcDropOpen && !$('pgTcDropdown')?.contains(e.target) && e.target !== $('pgTcBtn')) {
      closeTcDropdown();
    }
  });

  // Palette clicks → add block
  document.querySelectorAll('.palette-proto[data-proto]').forEach(el => {
    el.addEventListener('click', () => addProtoBlockToPacket(el.dataset.proto));
  });

  // Scenario Lab — CSV tree + sequence
  $('tcReloadCsv')?.addEventListener('click', () => { _csvTreeHash = ''; loadCsvTree(); toast('Reloading CSV tree…', 'ok'); });
  initCsvUpload();
  initPaletteDnD();
  $('tcAddToSeq')?.addEventListener('click', tcAddToSeq);
  $('scRowAdd')?.addEventListener('click',  addPacket);
  $('scRowDel')?.addEventListener('click',  deletePacket);
  $('scRowDup')?.addEventListener('click', () => {
    if (state.activeList === 'tc') {
      // In TC mode: if selected row is a Packet type, duplicate both packet and seq row
      const rows = _getSeqRows();
      if (state.selectedSeqRowIdx >= 0 && state.selectedSeqRowIdx < rows.length) {
        const row = rows[state.selectedSeqRowIdx];
        const evType = (row['EventType'] || row['Event Type'] || '').toLowerCase();
        if (evType === 'packet') {
          const frameRef = (row['FrameRef'] || '').trim();
          const pktIdx = state.tcPackets.findIndex(p => p.name === frameRef);
          if (pktIdx >= 0) {
            state.selectedPacketIdx = pktIdx;
            duplicatePacket();
            return;
          }
        }
      }
      // Non-packet row or packet not found: just duplicate the sequence row
      scRowDup();
    } else {
      scRowDup();
    }
  });
  $('scRowUp')?.addEventListener('click',   () => movePacket(-1));
  $('scRowDown')?.addEventListener('click', () => movePacket(1));
  $('scSaveCsv')?.addEventListener('click', saveCsvTc);
  $('seqRun')?.addEventListener('click', () => { if (state.seqRunning) stopRunning(); else runSeqSequence(); });
  $('seqReset')?.addEventListener('click', () => {
    stopRunning();
    state.tcSeqList.forEach(tc => { tc.status = 'pending'; });
    renderTcSeqList();
    const tbody = $('sequenceRows');
    if (tbody) tbody.innerHTML = '';
    const titleEl = $('scDetailTitle'); if (titleEl) titleEl.textContent = 'TEST SEQUENCE — (select a TC)';
    state.selectedSeqTcIdx = -1;
    appendSeqTerm('↺ Sequence reset');
  });
  $('scSendSelected')?.addEventListener('click', () => { if (state.sendRunning) stopRunning(); else scenarioSendSelected(); });
  $('scSendList')?.addEventListener('click', () => { if (state.sendRunning) stopRunning(); else scenarioSendList(); });

  // Capture extras
  $('captureFilterApply')?.addEventListener('click', renderCaptureRows);
  $('captureFilterClear')?.addEventListener('click', () => {
    const f = $('captureFilter'); if (f) f.value = '';
    document.querySelectorAll('.proto-chip').forEach(b => b.classList.remove('active'));
    document.querySelector('.proto-chip[data-proto=""]')?.classList.add('active');
    renderCaptureRows();
  });
  $('copyPacketDetails')?.addEventListener('click', () => {
    const el = $('packetDetails');
    const text = el?.dataset.json || el?.textContent || '';
    navigator.clipboard?.writeText(text).then(() => toast('Copied!', 'ok'));
  });
  $('copyPacketHex')?.addEventListener('click', () => {
    navigator.clipboard?.writeText($('packetHex')?.textContent || '').then(() => toast('Copied!', 'ok'));
  });

  // Load CSV tree and start poller
  loadCsvTree();
  startCsvPoller();
}

initLayoutExtras();
init();
initApp();

// ── Port Mapping ──────────────────────────────────────────────────────────────
async function loadPortMap() {
  const st = $('portmapSt');
  try {
    const data = await api('/api/portmap');
    const portmap = data.portmap || [];
    state.portmap = portmap;  // keep in state for buildAllIfaces

    const remoteEntry = portmap.find(e => e.nodeUrl);
    if (remoteEntry) {
      const urlEl = $('portmapNodeBUrl');
      if (urlEl && !urlEl._userEdited) urlEl.value = remoteEntry.nodeUrl;
    }

    const tbody = $('portmapBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    for (let p = 0; p < 6; p++) {
      const saved    = portmap.find(e => e.port === p) || { port: p, iface: '' };
      const isRemote = !!saved.nodeUrl;
      const ifacePool = isRemote ? state.portmapRemoteIfaces : state.interfaces;

      const ifaceOpts = ifacePool.map(i => {
        const ip = i.ipv4?.[0]?.local ? ` (${i.ipv4[0].local})` : '';
        return `<option value="${i.name}" ${i.name === saved.iface ? 'selected' : ''}>${i.name}${ip}</option>`;
      }).join('');
      const savedOpt = (isRemote && saved.iface && !ifacePool.find(i => i.name === saved.iface))
        ? `<option value="${saved.iface}" selected>${saved.iface}</option>` : '';

      const nodeBadge = isRemote
        ? `<span class="pm-badge pm-remote">Node B</span>`
        : `<span class="pm-badge pm-local">Local</span>`;

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td style="text-align:center;font-weight:700;">P${p}</td>` +
        `<td style="text-align:center;">${nodeBadge}</td>` +
        `<td><select id="pmIface${p}" class="small-select" data-remote="${isRemote}" data-nodeurl="${saved.nodeUrl||''}">` +
          `<option value="">— none —</option>${savedOpt}${ifaceOpts}</select></td>` +
        `<td class="mono" id="pmMac${p}" style="font-size:10px;color:var(--muted);"></td>` +
        `<td class="mono" id="pmIp${p}"  style="font-size:10px;color:var(--muted);"></td>`;
      tbody.appendChild(tr);
      $(`pmIface${p}`)?.addEventListener('change', () => _updatePortMapRow(p));
      _updatePortMapRow(p);
    }
    // Auto-probe Node B silently so MAC/IP appear without manual click
    if (remoteEntry?.nodeUrl) _probePortMapBSilent(remoteEntry.nodeUrl);
  } catch (e) {
    if (st) { st.textContent = `Error: ${e.message}`; st.className = 'reg-status'; }
  }
}

function _updatePortMapRow(p) {
  const sel   = $(`pmIface${p}`);
  const macEl = $(`pmMac${p}`);
  const ipEl  = $(`pmIp${p}`);
  if (!sel) return;
  const isRemote = sel.dataset.remote === 'true';
  const pool  = isRemote ? state.portmapRemoteIfaces : state.interfaces;
  const iface = pool.find(i => i.name === sel.value);
  if (macEl) macEl.textContent = iface?.mac || '';
  if (ipEl)  ipEl.textContent  = iface?.ipv4?.[0]?.local || '';
}

async function _probePortMapBSilent(url) {
  try {
    const resp = await fetch(`${url}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const { interfaces = [] } = await resp.json();
    state.portmapRemoteIfaces = interfaces;
    buildAllIfaces();  // rebuild scenario selects with fresh remote ifaces
    for (let p = 0; p < 6; p++) {
      const sel = $(`pmIface${p}`);
      if (!sel || sel.dataset.remote !== 'true') continue;
      const current = sel.value;
      sel.innerHTML = `<option value="">— none —</option>` +
        interfaces.map(i => {
          const ip = i.ipv4?.[0]?.local ? ` (${i.ipv4[0].local})` : '';
          return `<option value="${i.name}" ${i.name === current ? 'selected' : ''}>${i.name}${ip}</option>`;
        }).join('');
      _updatePortMapRow(p);
    }
    const pst = $('portmapProbeSt');
    if (pst) { pst.textContent = `Node B: ${interfaces.length} ifaces`; setTimeout(() => { pst.textContent = ''; }, 3000); }
  } catch { /* silent */ }
}

async function probePortMapB() {
  const urlEl = $('portmapNodeBUrl');
  const pst   = $('portmapProbeSt');
  const url   = urlEl?.value?.trim();
  if (!url) return;
  if (pst) pst.textContent = 'Probing…';
  try {
    const resp = await fetch(`${url}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { interfaces = [] } = await resp.json();
    state.portmapRemoteIfaces = interfaces;
    for (let p = 0; p < 6; p++) {
      const sel = $(`pmIface${p}`);
      if (!sel || sel.dataset.remote !== 'true') continue;
      const current = sel.value;
      sel.innerHTML = `<option value="">— none —</option>` +
        interfaces.map(i => {
          const ip = i.ipv4?.[0]?.local ? ` (${i.ipv4[0].local})` : '';
          return `<option value="${i.name}" ${i.name === current ? 'selected' : ''}>${i.name}${ip}</option>`;
        }).join('');
      _updatePortMapRow(p);
    }
    if (pst) { pst.textContent = `${interfaces.length} ifaces`; setTimeout(() => { if (pst) pst.textContent = ''; }, 3000); }
    toast(`Node B: ${interfaces.length} interfaces`, 'ok');
  } catch (e) {
    if (pst) pst.textContent = `Failed: ${e.message}`;
    toast(`Probe B failed: ${e.message}`, 'bad');
  }
}

async function savePortMap() {
  const nodeBUrl = $('portmapNodeBUrl')?.value?.trim() || '';
  const portmap = [];
  for (let p = 0; p < 6; p++) {
    const sel = $(`pmIface${p}`);
    const isRemote = sel?.dataset.remote === 'true';
    const entry = { port: p, iface: sel?.value || '' };
    if (isRemote && nodeBUrl) entry.nodeUrl = nodeBUrl;
    portmap.push(entry);
  }
  const st = $('portmapSt');
  try {
    await api('/api/portmap', { method: 'POST', body: JSON.stringify({ portmap }) });
    if (st) { st.textContent = 'Saved'; st.className = 'reg-status ok'; }
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
  } catch (e) {
    if (st) { st.textContent = `Error: ${e.message}`; st.className = 'reg-status'; }
  }
}

// ── 2-PC Experiment ───────────────────────────────────────────────────────────
async function twoPcProbe(side) {
  const urlEl   = $(`twoPcUrl${side}`);
  const ifaceEl = $(`twoPcIface${side}`);
  if (!urlEl || !ifaceEl) return;
  const url = urlEl.value.trim();
  if (!url) return toast(`Node ${side} URL is empty`, 'bad');
  try {
    const resp = await fetch(`${url}/api/interfaces`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const ifaces = (data.interfaces || []).filter(i => i.name !== 'lo');
    ifaceEl.innerHTML = `<option value="">— select —</option>` +
      ifaces.map(i => {
        const ip = i.ipv4?.[0]?.local ? ` (${i.ipv4[0].local})` : '';
        return `<option value="${i.name}">${i.name}${ip}</option>`;
      }).join('');
    // Auto-select: for Node B prefer enp* (SW port interface), for Node A prefer enp* too
    const preferred = ifaces.find(i => /^enp/.test(i.name) && /^192\.168\./.test(i.ipv4?.[0]?.local || ''))
                   || ifaces.find(i => /^enp/.test(i.name))
                   || ifaces[0];
    if (preferred) ifaceEl.value = preferred.name;
    toast(`Node ${side}: ${ifaces.length} interfaces`, 'ok');
  } catch (e) {
    toast(`Node ${side} probe failed: ${e.message}`, 'bad');
  }
}

async function run2pcTest() {
  const nodeAUrl  = $('twoPcUrlA')?.value?.trim();
  const nodeBUrl  = $('twoPcUrlB')?.value?.trim();
  const nodeAIface = $('twoPcIfaceA')?.value;
  const nodeBIface = $('twoPcIfaceB')?.value;
  const direction  = $('twoPcDir')?.value || 'BOTH';
  const count      = Number($('twoPcCount')?.value || 10);
  const intervalMs = Number($('twoPcInterval')?.value || 100);
  const captureTimeoutMs = Number($('twoPcCapTimeout')?.value || 3000);
  const st = $('twoPcSt');
  const runBtn = $('twoPcRun');

  if (!nodeAUrl || !nodeBUrl) return toast('Both Node URLs required', 'bad');
  if (!nodeAIface || !nodeBIface) return toast('Select interfaces for both nodes', 'bad');

  if (st) { st.textContent = 'Running…'; st.className = 'reg-status ok'; }
  if (runBtn) runBtn.disabled = true;

  try {
    const data = await api('/api/simple-bidir-forward-test', {
      method: 'POST',
      body: JSON.stringify({ nodeAUrl, nodeBUrl, nodeAPrimaryInterface: nodeAIface, nodeBPrimaryInterface: nodeBIface, direction, count, intervalMs, captureTimeoutMs })
    });

    const tbody = $('twoPcBody');
    if (tbody) {
      tbody.innerHTML = (data.directions || []).map(r => {
        const passColor = r.result === 'PASS' ? '#44FF88' : '#FF6B6B';
        const shortA = (r.senderUrl || '').replace(/https?:\/\//, '');
        const shortB = (r.receiverUrl || '').replace(/https?:\/\//, '');
        const diagParts = [];
        if (r.totalCaptured != null) diagParts.push(`캡처: ${r.totalCaptured}pkts`);
        if (r.captureStartErr) diagParts.push(`캡처오류: ${r.captureStartErr}`);
        if (r.sendErr) diagParts.push(`전송오류: ${r.sendErr}`);
        if (r.error) diagParts.push(`오류: ${r.error}`);
        const diag = diagParts.length ? `<br><small style="color:var(--muted);font-size:10px;">${esc(diagParts.join(' | '))}</small>` : '';
        return `<tr>
          <td>${r.direction.replace('_', ' → ')}</td>
          <td class="mono">${shortA}</td>
          <td class="mono">${shortB}</td>
          <td style="text-align:center;">${r.sent ?? '—'}</td>
          <td style="text-align:center;">${r.matched ?? '—'}</td>
          <td style="text-align:center;font-weight:700;color:${passColor}">${r.result}${diag}</td>
        </tr>`;
      }).join('');
    }

    const overall = data.report?.overall || 'UNKNOWN';
    const overallEl = $('twoPcOverall');
    if (overallEl) {
      overallEl.textContent = `Overall: ${overall}`;
      overallEl.style.color = overall === 'PASS' ? '#44FF88' : '#FF6B6B';
    }
    $('twoPcResults').style.display = '';
    if (st) { st.textContent = overall === 'PASS' ? '✔ PASS' : '✘ FAIL'; st.className = `reg-status${overall === 'PASS' ? ' ok' : ''}`; }
  } catch (e) {
    if (st) { st.textContent = `Error: ${e.message}`; st.className = 'reg-status'; }
    toast(`Test failed: ${e.message}`, 'bad');
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

// ── 2-PC Matrix Test ──────────────────────────────────────────────────────────
let _matrixAbort = false;
const _mx = { nodeAIfaces: [], nodeBIfaces: [], results: [] };

async function loadMatrixFromPortmap() {
  try {
    const data = await api('/api/portmap');
    const portmap = data.portmap || [];
    _mx.nodeAIfaces = portmap.filter(e => !e.nodeUrl && e.iface).map(e => ({ port: e.port, iface: e.iface }));
    _mx.nodeBIfaces = portmap.filter(e =>  e.nodeUrl && e.iface).map(e => ({ port: e.port, iface: e.iface, nodeUrl: e.nodeUrl }));
    _renderMxIfaceList('A', _mx.nodeAIfaces);
    _renderMxIfaceList('B', _mx.nodeBIfaces);
    const total = _mx.nodeAIfaces.length * _mx.nodeBIfaces.length;
    const hintA = $('twoPcUrlA')?.value || '';
    const hintB = $('twoPcUrlB')?.value || '';
    const hint = $('matrixUrlHint');
    if (hint) hint.textContent = `A: ${hintA}  ↔  B: ${hintB}`;
    const st = $('matrixSt');
    if (st) { st.textContent = `${_mx.nodeAIfaces.length}×${_mx.nodeBIfaces.length} = ${total}조합`; st.className = 'reg-status ok'; setTimeout(() => { st.textContent = ''; }, 3000); }
  } catch (e) { toast(`Portmap load: ${e.message}`, 'bad'); }
}

function _renderMxIfaceList(side, ifaces) {
  const el = $(`matrixIfaces${side}`);
  if (!el) return;
  if (!ifaces.length) { el.innerHTML = '<span style="color:var(--muted);font-size:10px;">없음 (포트맵에 인터페이스 미설정)</span>'; return; }
  el.innerHTML = ifaces.map((f, i) =>
    `<label class="rv-chk"><input type="checkbox" id="mxChk${side}${i}" value="${f.iface}" data-port="${f.port}" checked>` +
    `<span>P${f.port} <span class="mono" style="font-size:10px;">${f.iface}</span></span></label>`
  ).join('');
}

function _getMxChecked(side) {
  const list = side === 'A' ? _mx.nodeAIfaces : _mx.nodeBIfaces;
  return list.reduce((acc, f, i) => {
    const chk = $(`mxChk${side}${i}`);
    if (chk?.checked) acc.push({ port: f.port, iface: f.iface, listIdx: i });
    return acc;
  }, []);
}

function _renderMxMatrix(aList, bList) {
  const wrap = $('matrixTableWrap');
  if (!wrap) return;
  let h = '<table class="matrix-grid"><thead><tr><th></th>';
  for (const b of bList) h += `<th>P${b.port}<br><span class="mono" style="font-size:9px;">${b.iface}</span></th>`;
  h += '</tr></thead><tbody>';
  for (const a of aList) {
    h += `<tr><td class="matrix-grid-row-head">P${a.port}<br><span class="mono" style="font-size:9px;">${a.iface}</span></td>`;
    for (const b of bList) h += `<td id="mxCell_${a.listIdx}_${b.listIdx}" class="matrix-grid-cell"><span class="mc-pend">—</span></td>`;
    h += '</tr>';
  }
  h += '</tbody></table>';
  wrap.innerHTML = h;
}

function _setMxCell(a, b, status, atob, btoa) {
  const el = $(`mxCell_${a.listIdx}_${b.listIdx}`);
  if (!el) return;
  if (status === 'running') {
    el.innerHTML = '<span class="mc-pend matrix-anim">⏳</span>';
    el.className = 'matrix-grid-cell matrix-run-bg';
  } else if (status === 'error') {
    el.innerHTML = '<span class="mc-fail">⚠ ERR</span>';
    el.className = 'matrix-grid-cell matrix-fail-bg';
  } else {
    const lines = [];
    if (atob) lines.push(`<span class="${atob.result==='PASS'?'mc-pass':'mc-fail'}">A→B ${atob.result==='PASS'?'✔':'✗'} (${atob.matched??0}/${atob.sent??0})</span>`);
    if (btoa) lines.push(`<span class="${btoa.result==='PASS'?'mc-pass':'mc-fail'}">B→A ${btoa.result==='PASS'?'✔':'✗'} (${btoa.matched??0}/${btoa.sent??0})</span>`);
    const allPass = (!atob || atob.result==='PASS') && (!btoa || btoa.result==='PASS');
    el.innerHTML = lines.join('') || '—';
    el.className = `matrix-grid-cell ${allPass?'matrix-pass-bg':'matrix-fail-bg'}`;
  }
}

function _setMxDetailRow(i, a, b, atob, btoa, overall, err) {
  const tbody = $('matrixDetailBody');
  if (!tbody) return;
  let tr = document.getElementById(`mxRow${i}`);
  if (!tr) { tr = document.createElement('tr'); tr.id = `mxRow${i}`; tbody.appendChild(tr); }
  if (overall === 'running') {
    tr.innerHTML = `<td style="text-align:center;">${i+1}</td><td>P${a.port}</td><td class="mono">${a.iface}</td>` +
      `<td>P${b.port}</td><td class="mono">${b.iface}</td><td colspan="7" style="color:var(--accent);">실행 중…</td>`;
    return;
  }
  if (overall === 'error') {
    tr.innerHTML = `<td style="text-align:center;">${i+1}</td><td>P${a.port}</td><td class="mono">${a.iface}</td>` +
      `<td>P${b.port}</td><td class="mono">${b.iface}</td><td colspan="7" style="color:#FF6B6B;">${err||'Error'}</td>`;
    return;
  }
  const rc = (r) => {
    if (!r) return '<td>—</td><td>—</td><td>—</td>';
    const diagParts = [];
    if (r.totalCaptured != null) diagParts.push(`캡처:${r.totalCaptured}`);
    if (r.captureStartErr) diagParts.push(`캡처오류`);
    if (r.sendErr) diagParts.push(`전송오류`);
    const diag = diagParts.length ? `<br><small style="font-size:9px;color:var(--muted)">${diagParts.join(' ')}</small>` : '';
    return `<td style="text-align:center;">${r.sent??'—'}</td><td style="text-align:center;">${r.matched??'—'}</td>` +
      `<td style="text-align:center;font-weight:700;color:${r.result==='PASS'?'#44FF88':'#FF6B6B'}">${r.result}${diag}</td>`;
  };
  const oc = overall==='PASS'?'#44FF88':'#FF6B6B';
  tr.innerHTML = `<td style="text-align:center;">${i+1}</td><td style="text-align:center;">P${a.port}</td><td class="mono">${a.iface}</td>` +
    `<td style="text-align:center;">P${b.port}</td><td class="mono">${b.iface}</td>` +
    `${rc(atob)}${rc(btoa)}<td style="text-align:center;font-weight:700;color:${oc}">${overall}</td>`;
}

async function runMatrixTest() {
  const nodeAUrl = $('twoPcUrlA')?.value?.trim() || 'http://169.254.88.222:8080';
  const nodeBUrl = $('twoPcUrlB')?.value?.trim() || 'http://169.254.1.168:8080';
  const direction = $('matrixDir')?.value || 'BOTH';
  const count = Number($('matrixCount')?.value || 10);
  const intervalMs = Number($('matrixInterval')?.value || 100);
  const captureTimeoutMs = Number($('matrixCapTimeout')?.value || 3000);

  const aList = _getMxChecked('A');
  const bList = _getMxChecked('B');
  if (!aList.length || !bList.length) return toast('인터페이스를 먼저 선택하세요 (포트맵 로드)', 'bad');

  // Build pairs: A × B
  const pairs = [];
  for (const a of aList) for (const b of bList) pairs.push({ a, b });

  $('matrixRun').disabled = true;
  $('matrixStop').style.display = '';
  $('matrixProgressBarWrap').style.display = '';
  $('matrixResults').style.display = '';
  $('matrixDetailBody').innerHTML = '';
  _renderMxMatrix(aList, bList);
  _mx.results = pairs.map(p => ({ ...p, status: 'pending' }));
  _matrixAbort = false;

  for (let i = 0; i < pairs.length; i++) {
    if (_matrixAbort) break;
    const { a, b } = pairs[i];
    // progress
    const pct = Math.round(i / pairs.length * 100);
    const fill = $('matrixProgressFill'); if (fill) fill.style.width = pct + '%';
    const prog = $('matrixProgress'); if (prog) prog.textContent = `${i + 1} / ${pairs.length} 실행 중…`;
    const st = $('matrixSt'); if (st) { st.textContent = `${i+1}/${pairs.length}`; st.className = 'reg-status ok'; }

    _setMxCell(a, b, 'running');
    _setMxDetailRow(i, a, b, null, null, 'running');

    try {
      const data = await api('/api/simple-bidir-forward-test', {
        method: 'POST',
        body: JSON.stringify({ nodeAUrl, nodeBUrl, nodeAPrimaryInterface: a.iface, nodeBPrimaryInterface: b.iface, direction, count, intervalMs, captureTimeoutMs })
      });
      const dirs = data.directions || [];
      const atob = dirs.find(d => d.direction === 'A_TO_B') || null;
      const btoa = dirs.find(d => d.direction === 'B_TO_A') || null;
      const overall = data.report?.overall || 'FAIL';
      _mx.results[i] = { a, b, atob, btoa, overall, status: 'done' };
      _setMxCell(a, b, 'done', atob, btoa);
      _setMxDetailRow(i, a, b, atob, btoa, overall);
    } catch (e) {
      _mx.results[i] = { a, b, error: e.message, status: 'error' };
      _setMxCell(a, b, 'error');
      _setMxDetailRow(i, a, b, null, null, 'error', e.message);
    }
  }

  // Final progress
  const done = _mx.results.filter(r => r.status === 'done');
  const pass = done.filter(r => r.overall === 'PASS').length;
  const fail = done.length - pass;
  const aborted = _matrixAbort && done.length < pairs.length;
  const fill = $('matrixProgressFill'); if (fill) fill.style.width = '100%';
  const prog = $('matrixProgress'); if (prog) prog.textContent = aborted ? `중단 (${done.length}/${pairs.length})` : `완료 ${pairs.length}/${pairs.length}`;
  const summary = $('matrixSummary');
  if (summary) {
    summary.textContent = aborted
      ? `중단됨 — ${done.length}쌍 완료 · PASS: ${pass} / FAIL: ${fail}`
      : `전체 ${pairs.length}쌍 완료 · PASS: ${pass} / FAIL: ${fail}`;
    summary.style.color = (fail === 0 && !aborted) ? '#44FF88' : '#FF6B6B';
  }
  const st = $('matrixSt');
  if (st) { st.textContent = aborted ? '중단됨' : `PASS ${pass} / FAIL ${fail}`; st.className = `reg-status${fail===0&&!aborted?' ok':''}`; }
  $('matrixRun').disabled = false;
  $('matrixStop').style.display = 'none';
  setTimeout(() => { const b = $('matrixProgressBarWrap'); if (b) b.style.display = 'none'; }, 1500);
}

function exportMatrixCsv() {
  const results = _mx.results.filter(r => r.status === 'done');
  if (!results.length) return toast('결과 없음', 'bad');
  const header = '#,A Port,A Interface,B Port,B Interface,A→B Sent,A→B Rcvd,A→B Result,B→A Sent,B→A Rcvd,B→A Result,Overall';
  const rows = results.map((r, i) => {
    const rc = (d) => d ? `${d.sent??''},${d.matched??''},${d.result}` : ',,';
    return `${i+1},P${r.a.port},${r.a.iface},P${r.b.port},${r.b.iface},${rc(r.atob)},${rc(r.btoa)},${r.overall}`;
  });
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `matrix_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Benchmark ─────────────────────────────────────────────────────────────────
let _benchAbort = false;
let _benchResult = null;
let _benchParams = null;

// Benchmark uses fixed UDP dst port so BPF filter is exact
const BENCH_DST_PORT = 50002;
const BENCH_BPF = `udp and dst port ${BENCH_DST_PORT}`;

function _strHex(str) {
  return Array.from(str).map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
}
function _pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(Math.floor(sorted.length * p / 100), sorted.length - 1)];
}
function _hdr() { return { 'Content-Type': 'application/json' }; }
function _to(ms)  { return { signal: AbortSignal.timeout(ms) }; }

async function _benchFetch(url, method = 'GET', body = null) {
  try {
    const opts = { method, headers: _hdr(), ..._to(30000) };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}

// Look up MAC of a specific interface from portmap (for unicast sending)
function _benchGetMac(iface, isRemote) {
  const entry = (state.portmap || []).find(e =>
    e.iface === iface && (isRemote ? !!e.nodeUrl : !e.nodeUrl)
  );
  return entry?.mac || 'FF:FF:FF:FF:FF:FF';
}

function _benchIsRemote(url) {
  const origin = window.location.origin;
  return url && url !== origin && !url.includes('localhost') && !url.includes('127.0.0.1');
}

async function _benchSend(url, iface, count, intervalMs, payloadSize, marker, dstMac = 'FF:FF:FF:FF:FF:FF') {
  const pad  = Math.max(0, payloadSize - marker.length);
  const data = marker + 'A'.repeat(pad);
  return _benchFetch(`${url}/api/send`, 'POST', {
    interface: iface, protocol: 'udp',
    dstMac,
    srcIp: '169.254.0.1', dstIp: '169.254.0.2',
    srcPort: 40002, dstPort: BENCH_DST_PORT,
    count, intervalMs,
    payload: { mode: 'text', data }
  });
}

function _matchMarker(rows, marker) {
  const mHex = _strHex(marker);
  return rows.filter(r =>
    JSON.stringify(r.decoded || {}).includes(marker) ||
    (r.frameHex || '').includes(mHex)
  );
}

// Deduplicate captured rows by timestamp (1 ms resolution).
// Fixes switch-level broadcast duplication where the same physical frame
// arrives at multiple ports and is captured multiple times.
// Works correctly when intervalMs >= 1 (each packet has a unique ms timestamp).
function _dedupByTimestamp(matched) {
  const seen = new Set();
  let count = 0;
  for (const row of matched) {
    const ts1ms = Math.round((row.timestamp || 0) * 1000);
    if (!seen.has(ts1ms)) { seen.add(ts1ms); count++; }
  }
  return count;
}

async function runBenchPDR(sUrl, sIface, rUrl, rIface, count, intervalMs, payloadSize, capMs) {
  const rIsRemote = _benchIsRemote(rUrl);
  const dstMac    = _benchGetMac(rIface, rIsRemote);

  const marker = `BMPDR${Date.now()}${Math.random().toString(36).slice(2,5)}`;
  await _benchFetch(`${rUrl}/api/capture/clear`, 'POST', {});
  await _benchFetch(`${rUrl}/api/capture/start`, 'POST', {
    interfaces: [rIface], bpfFilter: BENCH_BPF
  });
  await new Promise(r => setTimeout(r, 500));

  const t0 = Date.now();
  await _benchSend(sUrl, sIface, count, intervalMs, payloadSize, marker, dstMac);
  const sendMs = Date.now() - t0;

  await new Promise(r => setTimeout(r, Math.min(capMs, 8000)));
  await _benchFetch(`${rUrl}/api/capture/stop`, 'POST', {});

  const capData  = await _benchFetch(`${rUrl}/api/capture/packets?limit=5000`);
  const rows     = capData.rows || [];
  const matched  = _matchMarker(rows, marker);

  // Use timestamp dedup when interval >= 1ms; raw count otherwise
  const received = intervalMs >= 1 ? _dedupByTimestamp(matched) : matched.length;

  const pdr     = count > 0 ? Math.min(100, (received / count) * 100) : 0;
  const sendSec = Math.max(sendMs / 1000, 0.001);
  const frameB  = payloadSize + 42;
  const pps     = received / sendSec;
  const mbps    = pps * frameB * 8 / 1e6;

  return {
    sent: count, received, lost: Math.max(0, count - received),
    pdr:  Math.round(pdr * 10) / 10,
    pps:  Math.round(pps),
    mbps: Math.round(mbps * 100) / 100,
    sendMs, dstMac,
  };
}

async function runBenchLatency(sUrl, sIface, rUrl, rIface, iterations, capMs) {
  const rIsRemote = _benchIsRemote(rUrl);
  const dstMac    = _benchGetMac(rIface, rIsRemote);
  const samples   = [];

  await _benchFetch(`${rUrl}/api/capture/clear`, 'POST', {});
  await _benchFetch(`${rUrl}/api/capture/start`, 'POST', {
    interfaces: [rIface], bpfFilter: BENCH_BPF
  });
  await new Promise(r => setTimeout(r, 500));

  for (let i = 0; i < iterations; i++) {
    if (_benchAbort) break;
    const marker = `BMLAT${Date.now()}${i}`;
    const t0 = Date.now();
    await _benchSend(sUrl, sIface, 1, 0, 64, marker, dstMac);

    let found = false;
    for (let p = 0; p < 40 && !found; p++) {
      await new Promise(r => setTimeout(r, 30));
      const d = await _benchFetch(`${rUrl}/api/capture/packets?limit=1000`);
      if (_matchMarker(d.rows || [], marker).length) {
        samples.push(Date.now() - t0);
        found = true;
      }
    }
    if (!found) samples.push(null);
  }

  await _benchFetch(`${rUrl}/api/capture/stop`, 'POST', {});

  const valid = samples.filter(s => s !== null).sort((a, b) => a - b);
  if (!valid.length) return { error: 'no packets received', iterations, valid: 0, samples: [] };

  const avg    = valid.reduce((a, b) => a + b, 0) / valid.length;
  const jitter = valid.reduce((s, v) => s + Math.abs(v - avg), 0) / valid.length;

  return {
    iterations, valid: valid.length, lost: iterations - valid.length,
    min: valid[0], max: valid[valid.length - 1],
    avg:    Math.round(avg    * 10) / 10,
    jitter: Math.round(jitter * 10) / 10,
    p50: _pct(valid, 50), p95: _pct(valid, 95), p99: _pct(valid, 99),
    samples: valid,
  };
}

function _benchLog(msg, cls = '') {
  const el = $('benchLog');
  if (!el) return;
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

function _benchScore(results) {
  const pdr = results.pdr || {};
  const lat = (results.latency?.atob) || {};
  const sw  = results.frameSweep?.sizes || [];

  let pts = 0, max = 0;

  // PDR score (40 pts)
  if (pdr.atob != null) {
    max += 20;
    pts += pdr.atob.pdr >= 99.9 ? 20 : pdr.atob.pdr >= 99 ? 18 : pdr.atob.pdr >= 95 ? 14 : pdr.atob.pdr >= 90 ? 10 : 5;
  }
  if (pdr.btoa != null) {
    max += 20;
    pts += pdr.btoa.pdr >= 99.9 ? 20 : pdr.btoa.pdr >= 99 ? 18 : pdr.btoa.pdr >= 95 ? 14 : pdr.btoa.pdr >= 90 ? 10 : 5;
  }

  // Latency score (30 pts) — software RTT so thresholds are generous
  if (lat.avg != null) {
    max += 15;
    pts += lat.avg <= 50 ? 15 : lat.avg <= 100 ? 12 : lat.avg <= 200 ? 8 : lat.avg <= 500 ? 4 : 1;
    max += 15;
    const j = lat.jitter ?? lat.avg;
    pts += j <= 5 ? 15 : j <= 15 ? 12 : j <= 30 ? 8 : j <= 60 ? 4 : 1;
  }

  // Frame sweep score (30 pts) — all sizes PDR
  if (sw.length) {
    max += 30;
    const avgPdr = sw.reduce((s, v) => s + v.pdr, 0) / sw.length;
    pts += avgPdr >= 99.9 ? 30 : avgPdr >= 99 ? 26 : avgPdr >= 95 ? 20 : avgPdr >= 90 ? 14 : 7;
  }

  const total = max > 0 ? Math.round(pts / max * 100) : 0;
  const grade = total >= 90 ? 'EXCELLENT' : total >= 75 ? 'GOOD' : total >= 55 ? 'FAIR' : 'POOR';
  const color = total >= 90 ? '#22c55e' : total >= 75 ? '#3b82f6' : total >= 55 ? '#f59e0b' : '#ef4444';
  return { total, grade, color };
}

function _benchProgress(pct, label) {
  const fill = $('benchProgressFill');
  const lbl  = $('benchProgressLabel');
  const pctEl = $('benchProgressPct');
  if (fill) fill.style.width = pct + '%';
  if (lbl)  lbl.textContent  = label;
  if (pctEl) pctEl.textContent = pct + '%';
}

async function benchLoadPorts() {
  await _loadPortmapSilent();
  const urlEl = $('benchUrlA'); if (urlEl) urlEl.value = window.location.origin;
  const bUrl  = state.portmap.find(e => e.nodeUrl)?.nodeUrl || '';
  const bEl   = $('benchUrlB'); if (bEl && bUrl) bEl.value = bUrl;

  // A interfaces
  const selA  = $('benchIfaceA');
  const selB  = $('benchIfaceB');
  if (selA) {
    selA.innerHTML = '<option value="">— 선택 —</option>' +
      state.interfaces.map(i => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join('');
  }
  if (selB) {
    const remotes = state.portmapRemoteIfaces.length ? state.portmapRemoteIfaces : [];
    selB.innerHTML = '<option value="">— 선택 —</option>' +
      remotes.map(i => `<option value="${esc(i.name)}">${esc(i.name)}</option>`).join('');
  }
  // Auto-select first mapped interface from portmap
  const aEntry = state.portmap.find(e => !e.nodeUrl && e.iface);
  const bEntry = state.portmap.find(e =>  e.nodeUrl && e.iface);
  if (aEntry && selA) selA.value = aEntry.iface;
  if (bEntry && selB) selB.value = bEntry.iface;
  toast('포트맵 로드 완료', 'ok');
}

async function runBenchmark() {
  const nodeAUrl  = ($('benchUrlA')?.value || '').trim() || window.location.origin;
  const nodeBUrl  = ($('benchUrlB')?.value || '').trim();
  const nodeAIface = $('benchIfaceA')?.value || '';
  const nodeBIface = $('benchIfaceB')?.value || '';
  if (!nodeBUrl || !nodeAIface || !nodeBIface) {
    return toast('Node B URL과 인터페이스(A,B)를 설정하세요', 'bad');
  }

  const tests = {
    pdr:       $('benchTestPdr')?.checked     ?? true,
    latency:   $('benchTestLatency')?.checked ?? true,
    frameSweep:$('benchTestSweep')?.checked   ?? true,
  };
  const count    = parseInt($('benchCount')?.value)      || 100;
  const iMs      = parseInt($('benchInterval')?.value)   || 1;
  const latIters = parseInt($('benchLatIters')?.value)   || 30;
  const capMs    = parseInt($('benchCapTimeout')?.value) || 5000;

  _benchAbort  = false;
  _benchResult = null;
  _benchParams = { nodeAUrl, nodeBUrl, nodeAIface, nodeBIface };

  $('benchRun').style.display         = 'none';
  $('benchStop').style.display        = 'inline';
  $('benchProgressWrap').style.display = 'block';
  $('benchLog').style.display          = 'block';
  $('benchLog').innerHTML              = '';
  $('benchResultsWrap').style.display  = 'none';
  $('benchExportReport').style.display = 'none';

  const sizes     = [64, 256, 512, 1024, 1400];
  const totalSteps = (tests.pdr ? 2 : 0) + (tests.latency ? 1 : 0) + (tests.frameSweep ? sizes.length : 0);
  let step = 0;

  function nextStep(label) {
    step++;
    _benchProgress(Math.round(step / totalSteps * 100), label);
    _benchLog('▶ ' + label, 'dim');
  }

  const res = { startedAt: new Date().toISOString(), results: {} };

  try {
    // ── PDR ───────────────────────────────────────────────────────────────────
    if (tests.pdr && !_benchAbort) {
      nextStep('PDR/Throughput: A → B ...');
      const atob = await runBenchPDR(nodeAUrl, nodeAIface, nodeBUrl, nodeBIface, count, iMs, 64, capMs);
      _benchLog(`  A→B: PDR ${atob.pdr}%  (sent ${atob.sent}, rcvd ${atob.received}, loss ${atob.lost})  ${atob.mbps} Mbps`,
                atob.pdr >= 99 ? 'ok' : atob.pdr >= 80 ? 'warn' : 'err');

      if (!_benchAbort) {
        nextStep('PDR/Throughput: B → A ...');
        const btoa = await runBenchPDR(nodeBUrl, nodeBIface, nodeAUrl, nodeAIface, count, iMs, 64, capMs);
        _benchLog(`  B→A: PDR ${btoa.pdr}%  (sent ${btoa.sent}, rcvd ${btoa.received}, loss ${btoa.lost})  ${btoa.mbps} Mbps`,
                  btoa.pdr >= 99 ? 'ok' : btoa.pdr >= 80 ? 'warn' : 'err');
        res.results.pdr = { atob, btoa };
      }
    }

    // ── Latency ───────────────────────────────────────────────────────────────
    if (tests.latency && !_benchAbort) {
      nextStep(`Latency: A→B (${latIters}회) ...`);
      const lat = await runBenchLatency(nodeAUrl, nodeAIface, nodeBUrl, nodeBIface, latIters, capMs);
      if (lat.error) {
        _benchLog('  Latency: ' + lat.error, 'err');
      } else {
        _benchLog(`  min ${lat.min}ms  avg ${lat.avg}ms  p95 ${lat.p95}ms  max ${lat.max}ms  (valid ${lat.valid}/${lat.iterations})`);
      }
      res.results.latency = { atob: lat };
    }

    // ── Frame Sweep ───────────────────────────────────────────────────────────
    if (tests.frameSweep && !_benchAbort) {
      res.results.frameSweep = { sizes: [] };
      for (const sz of sizes) {
        if (_benchAbort) break;
        nextStep(`Frame Sweep: ${sz}B 페이로드 ...`);
        const r = await runBenchPDR(nodeAUrl, nodeAIface, nodeBUrl, nodeBIface, 50, 2, sz, capMs);
        _benchLog(`  ${sz}B: PDR ${r.pdr}%  PPS ${r.pps}  ${r.mbps} Mbps`,
                  r.pdr >= 99 ? 'ok' : r.pdr >= 80 ? 'warn' : 'err');
        res.results.frameSweep.sizes.push({ payloadBytes: sz, ...r });
      }
    }

    res.finishedAt = new Date().toISOString();
    res.score = _benchScore(res.results);
    _benchLog(_benchAbort ? '⊘ 중단됨' : `✓ 완료 — 종합 점수: ${res.score.grade} (${res.score.total}/100)`,
              _benchAbort ? 'warn' : 'ok');
    _benchResult = res;
    _renderBenchResults(res);
    $('benchResultsWrap').style.display  = 'block';
    $('benchExportReport').style.display = 'inline';

  } catch (e) {
    _benchLog('✗ Error: ' + e.message, 'err');
  }

  $('benchRun').style.display  = 'inline';
  $('benchStop').style.display = 'none';
  _benchProgress(100, _benchAbort ? '중단됨' : '완료');
}

function _renderBenchResults(res) {
  const r     = res.results || {};
  const pdr   = r.pdr      || {};
  const lat   = (r.latency?.atob) || {};
  const sw    = r.frameSweep?.sizes || [];
  const score = res.score  || _benchScore(r);

  // ── Score banner ─────────────────────────────────────────────────────────
  const statEl = $('benchStatCards');
  if (statEl) {
    function card(label, val, unit, cls) {
      return `<div class="bench-stat ${cls}"><div class="bs-label">${label}</div><div class="bs-val">${val}</div><div class="bs-unit">${unit}</div></div>`;
    }
    const pdrA   = pdr.atob?.pdr  ?? null;
    const pdrB   = pdr.btoa?.pdr  ?? null;
    const lossA  = pdr.atob?.lost ?? null;
    const mbpsA  = pdr.atob?.mbps ?? null;
    const latAvg = lat.avg    ?? null;
    const latP95 = lat.p95    ?? null;
    const jitter = lat.jitter ?? null;

    const scoreBanner = `<div class="bench-stat" style="border-color:${score.color}44;background:${score.color}10;grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:10px 16px;">
      <div>
        <div class="bs-label">종합 점수</div>
        <div style="font-size:28px;font-weight:800;color:${score.color};">${score.total}<span style="font-size:14px;font-weight:500;color:var(--muted);">/100</span></div>
      </div>
      <div style="font-size:22px;font-weight:800;color:${score.color};">${score.grade}</div>
    </div>`;

    statEl.innerHTML = scoreBanner +
      (pdrA  !== null ? card('PDR A→B',      pdrA,  '%',   pdrA >=99?'ok':pdrA >=80?'warn':'bad') : '') +
      (pdrB  !== null ? card('PDR B→A',      pdrB,  '%',   pdrB >=99?'ok':pdrB >=80?'warn':'bad') : '') +
      (lossA !== null ? card('Loss A→B',     lossA, 'pkts',lossA===0?'ok':lossA<5?'warn':'bad')   : '') +
      (mbpsA !== null ? card('Throughput A→B',mbpsA,'Mbps','')                                     : '') +
      (latAvg!== null ? card('Latency avg',  latAvg,'ms',  '')                                     : '') +
      (latP95!== null ? card('Latency p95',  latP95,'ms',  '')                                     : '') +
      (jitter!== null ? card('Jitter',       jitter,'ms',  jitter<=10?'ok':jitter<=30?'warn':'bad'): '');
  }

  // ── Bar charts (CSS) ──────────────────────────────────────────────────────
  const chartEl = $('benchChartWrap');
  if (!chartEl) return;
  let html = '';

  if (pdr.atob || pdr.btoa) {
    html += '<div style="font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.05em;margin-bottom:6px;">PDR (%)</div><div class="bench-bar-wrap">';
    [['A → B', pdr.atob], ['B → A', pdr.btoa]].filter(x => x[1]).forEach(([lbl, v]) => {
      const col = v.pdr >= 99 ? '#22c55e' : v.pdr >= 80 ? '#f59e0b' : '#ef4444';
      html += `<div class="bench-bar-row">
        <div class="bench-bar-label">${lbl}</div>
        <div class="bench-bar-track"><div class="bench-bar-fill" style="width:${v.pdr}%;background:${col};"></div></div>
        <div class="bench-bar-val">${v.pdr}%&nbsp;<span style="font-size:9px;color:var(--muted);">(${v.pps} pps · ${v.mbps} Mbps)</span></div>
      </div>`;
    });
    html += '</div>';
  }

  if (lat.avg != null) {
    html += '<div style="font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.05em;margin:10px 0 6px;">Latency A→B (ms) — 소프트웨어 RTT</div><div class="bench-bar-wrap">';
    [['min', lat.min,'#22c55e'], ['avg', lat.avg,'#3b82f6'], ['p50', lat.p50,'#3b82f6'],
     ['p95', lat.p95,'#f59e0b'], ['p99', lat.p99,'#f59e0b'], ['max', lat.max,'#ef4444'],
     ['jitter', lat.jitter,'#a855f7']].filter(x => x[1] != null).forEach(([lbl, val, col]) => {
      const pct = Math.min(100, (val / (lat.max || 1)) * 100);
      html += `<div class="bench-bar-row">
        <div class="bench-bar-label">${lbl}</div>
        <div class="bench-bar-track"><div class="bench-bar-fill" style="width:${pct}%;background:${col};"></div></div>
        <div class="bench-bar-val">${val} ms</div>
      </div>`;
    });
    html += '</div>';
  }

  if (sw.length) {
    html += '<div style="font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.05em;margin:10px 0 6px;">Frame Size Sweep</div>';
    html += '<div style="overflow-x:auto;"><table class="fdb-table" style="width:100%;min-width:500px;">';
    html += '<thead><tr><th>Payload</th><th>Frame</th><th>Sent</th><th>Rcvd</th><th>PDR %</th><th>PPS</th><th>Mbps</th></tr></thead><tbody>';
    sw.forEach(s => {
      const col = s.pdr >= 99 ? '#22c55e' : s.pdr >= 80 ? '#f59e0b' : '#ef4444';
      html += `<tr><td>${s.payloadBytes}B</td><td>${s.payloadBytes+42}B</td><td>${s.sent}</td><td>${s.received}</td>
        <td style="color:${col};font-weight:600;">${s.pdr}%</td><td>${s.pps}</td><td>${s.mbps}</td></tr>`;
    });
    html += '</tbody></table></div>';
  }

  chartEl.innerHTML = html;
}

function exportBenchmarkReport() {
  if (!_benchResult || !_benchParams) return toast('먼저 벤치마크를 실행하세요', 'bad');
  const html = _buildBenchReport(_benchParams, _benchResult);
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `benchmark_${new Date().toISOString().slice(0,16).replace(/[T:]/g,'-')}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Matrix Benchmark ──────────────────────────────────────────────────────────
let _benchMxAbort   = false;
let _benchMxResults = null;

function _benchMxLog(msg, cls = '') {
  const el = $('benchMxLog');
  if (!el) return;
  const d = document.createElement('div');
  d.className = cls; d.textContent = msg;
  el.appendChild(d); el.scrollTop = el.scrollHeight;
}

function _benchMxProgress(pct, label) {
  const fill = $('benchMxProgressFill'); if (fill) fill.style.width = pct + '%';
  const lbl  = $('benchMxProgressLabel'); if (lbl) lbl.textContent = label;
  const pctEl= $('benchMxProgressPct');  if (pctEl) pctEl.textContent = pct + '%';
}

async function runMatrixBenchmark() {
  const nodeAUrl = ($('benchUrlA')?.value || '').trim() || window.location.origin;
  const nodeBUrl = ($('benchUrlB')?.value || '').trim();

  // Load pairs from portmap
  await _loadPortmapSilent();
  const aEntries = (state.portmap || []).filter(e => !e.nodeUrl && e.iface);
  const bEntries = (state.portmap || []).filter(e =>  e.nodeUrl && e.iface);

  if (!nodeBUrl)          return toast('Node B URL을 설정하세요', 'bad');
  if (!aEntries.length)   return toast('Node A 인터페이스가 없습니다 — 포트맵 로드 먼저', 'bad');
  if (!bEntries.length)   return toast('Node B 인터페이스가 없습니다 — 포트맵 로드 먼저', 'bad');

  const withLatency = $('benchMxTestLatency')?.checked ?? false;
  const latIters    = Math.min(parseInt($('benchMxLatIters')?.value) || 15, 50);
  const count       = parseInt($('benchCount')?.value)      || 100;
  const iMs         = parseInt($('benchInterval')?.value)   || 1;
  const capMs       = parseInt($('benchCapTimeout')?.value) || 5000;

  const pairs = [];
  for (const a of aEntries) for (const b of bEntries) pairs.push({ a, b });

  _benchMxAbort   = false;
  _benchMxResults = { pairs: [], nodeAUrl, nodeBUrl, startedAt: new Date().toISOString() };

  $('benchMxRun').style.display          = 'none';
  $('benchMxStop').style.display         = 'inline';
  $('benchMxProgressWrap').style.display = 'block';
  $('benchMxLog').style.display          = 'block';
  $('benchMxLog').innerHTML              = '';
  $('benchMxResultsWrap').style.display  = 'none';
  $('benchMxExportReport').style.display = 'none';

  const total = pairs.length;
  let done = 0;

  _benchMxLog(`총 ${total}개 포트 조합 (A×${aEntries.length} × B×${bEntries.length})${withLatency ? ' + Latency' : ''}`, 'dim');

  for (const { a, b } of pairs) {
    if (_benchMxAbort) break;

    const label = `P${a.port}(${a.iface}) ↔ P${b.port}(${b.iface})`;
    _benchMxProgress(Math.round(done / total * 100), label);
    _benchMxLog(`▶ ${label}`, 'dim');

    const pairResult = { a, b, atob: null, btoa: null, latency: null, error: null };

    try {
      pairResult.atob = await runBenchPDR(nodeAUrl, a.iface, nodeBUrl, b.iface, count, iMs, 64, capMs);
      _benchMxLog(`  A→B PDR ${pairResult.atob.pdr}%  ${pairResult.atob.mbps} Mbps  (loss ${pairResult.atob.lost})`,
                  pairResult.atob.pdr >= 99 ? 'ok' : pairResult.atob.pdr >= 80 ? 'warn' : 'err');

      if (!_benchMxAbort) {
        pairResult.btoa = await runBenchPDR(nodeBUrl, b.iface, nodeAUrl, a.iface, count, iMs, 64, capMs);
        _benchMxLog(`  B→A PDR ${pairResult.btoa.pdr}%  ${pairResult.btoa.mbps} Mbps  (loss ${pairResult.btoa.lost})`,
                    pairResult.btoa.pdr >= 99 ? 'ok' : pairResult.btoa.pdr >= 80 ? 'warn' : 'err');
      }

      if (withLatency && !_benchMxAbort) {
        pairResult.latency = await runBenchLatency(nodeAUrl, a.iface, nodeBUrl, b.iface, latIters, capMs);
        if (pairResult.latency.error) {
          _benchMxLog(`  Latency: ${pairResult.latency.error}`, 'err');
        } else {
          _benchMxLog(`  Latency avg ${pairResult.latency.avg}ms  p95 ${pairResult.latency.p95}ms  jitter ${pairResult.latency.jitter}ms`);
        }
      }
    } catch (e) {
      pairResult.error = e.message;
      _benchMxLog(`  ✗ ${e.message}`, 'err');
    }

    _benchMxResults.pairs.push(pairResult);
    done++;
    _renderMatrixBenchGrid(_benchMxResults, aEntries, bEntries);
    $('benchMxResultsWrap').style.display = 'block';
  }

  _benchMxResults.finishedAt = new Date().toISOString();
  _benchMxLog(_benchMxAbort ? '⊘ 중단됨' : '✓ 완료', _benchMxAbort ? 'warn' : 'ok');
  _benchMxProgress(100, _benchMxAbort ? '중단됨' : '완료');

  $('benchMxRun').style.display          = 'inline';
  $('benchMxStop').style.display         = 'none';
  $('benchMxExportReport').style.display = 'inline';
}

function _cellClass(pdr) {
  if (pdr == null) return '';
  return pdr >= 99 ? 'ok' : pdr >= 80 ? 'warn' : 'bad';
}
function _cellColor(pdr) {
  if (pdr == null) return 'var(--muted)';
  return pdr >= 99 ? '#22c55e' : pdr >= 80 ? '#f59e0b' : '#ef4444';
}

function _renderMatrixBenchGrid(results, aEntries, bEntries) {
  const gridEl   = $('benchMxGrid');
  const detailEl = $('benchMxDetailWrap');
  if (!gridEl) return;

  // ── Matrix grid ───────────────────────────────────────────────────────────
  let th = '<th style="min-width:110px;"></th>';
  bEntries.forEach(b => { th += `<th>P${b.port}<br>${esc(b.iface)}</th>`; });

  let rows = '';
  aEntries.forEach(a => {
    let cells = `<th style="text-align:left;">P${a.port}<br><span style="font-weight:400;">${esc(a.iface)}</span></th>`;
    bEntries.forEach(b => {
      const pr = results.pairs.find(p => p.a.port === a.port && p.b.port === b.port);
      if (!pr) {
        cells += '<td><div class="bmx-cell" style="color:var(--muted);font-size:10px;">—</div></td>';
        return;
      }
      if (pr.error) {
        cells += `<td><div class="bmx-cell bad"><div class="bmx-pdr" style="color:#ef4444;">ERR</div><div class="bmx-sub">${esc(pr.error.slice(0,20))}</div></div></td>`;
        return;
      }
      const worstPdr = Math.min(pr.atob?.pdr ?? 100, pr.btoa?.pdr ?? 100);
      const cls      = _cellClass(worstPdr);
      const col      = _cellColor(worstPdr);
      const latLine  = pr.latency?.avg != null ? `<div class="bmx-sub">${pr.latency.avg}ms avg</div>` : '';
      cells += `<td><div class="bmx-cell ${cls}">
        <div class="bmx-pdr" style="color:${col};">${pr.atob?.pdr ?? '—'}%</div>
        <div class="bmx-sub">A→B &nbsp; ${pr.atob?.mbps ?? '—'} Mbps</div>
        <div class="bmx-pdr" style="color:${_cellColor(pr.btoa?.pdr)};margin-top:3px;">${pr.btoa?.pdr ?? '—'}%</div>
        <div class="bmx-sub">B→A &nbsp; ${pr.btoa?.mbps ?? '—'} Mbps</div>
        ${latLine}
      </div></td>`;
    });
    rows += `<tr>${cells}</tr>`;
  });

  gridEl.innerHTML = `<table class="bmx-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;

  // ── Detail table ─────────────────────────────────────────────────────────
  if (!detailEl) return;
  const dRows = results.pairs.map((pr, i) => {
    const atob = pr.atob, btoa = pr.btoa, lat = pr.latency;
    return `<tr>
      <td style="font-size:10px;">${i+1}</td>
      <td>P${pr.a.port}</td><td>${esc(pr.a.iface)}</td>
      <td>P${pr.b.port}</td><td>${esc(pr.b.iface)}</td>
      <td style="color:${_cellColor(atob?.pdr)};font-weight:600;">${atob?.pdr ?? '—'}%</td>
      <td>${atob?.mbps ?? '—'}</td>
      <td>${atob?.lost ?? '—'}</td>
      <td style="color:${_cellColor(btoa?.pdr)};font-weight:600;">${btoa?.pdr ?? '—'}%</td>
      <td>${btoa?.mbps ?? '—'}</td>
      <td>${btoa?.lost ?? '—'}</td>
      ${lat ? `<td>${lat.avg ?? '—'}</td><td>${lat.p95 ?? '—'}</td><td>${lat.jitter ?? '—'}</td>` : '<td colspan="3" style="color:var(--muted);">—</td>'}
    </tr>`;
  }).join('');

  const hasLat = results.pairs.some(p => p.latency);
  const latHead = hasLat ? '<th>Lat avg</th><th>Lat p95</th><th>Jitter</th>' : '<th colspan="3">Latency</th>';

  detailEl.innerHTML = `<div style="font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.05em;margin-bottom:5px;">DETAIL</div>
  <table class="fdb-table" style="width:100%;min-width:720px;font-size:11px;">
    <thead><tr>
      <th>#</th><th>A Port</th><th>A Interface</th><th>B Port</th><th>B Interface</th>
      <th>A→B PDR</th><th>A→B Mbps</th><th>A→B Loss</th>
      <th>B→A PDR</th><th>B→A Mbps</th><th>B→A Loss</th>
      ${latHead}
    </tr></thead>
    <tbody>${dRows}</tbody>
  </table>`;
}

function exportMatrixBenchReport() {
  if (!_benchMxResults?.pairs?.length) return toast('먼저 Matrix Benchmark를 실행하세요', 'bad');
  const html = _buildMatrixBenchReport(_benchMxResults);
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `matrix_benchmark_${new Date().toISOString().slice(0,16).replace(/[T:]/g,'-')}.html`;
  a.click(); URL.revokeObjectURL(url);
}

function _buildMatrixBenchReport(results) {
  const H   = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const pairs = results.pairs || [];
  const aSet  = [...new Map(pairs.map(p => [p.a.port, p.a])).values()].sort((a,b) => a.port - b.port);
  const bSet  = [...new Map(pairs.map(p => [p.b.port, p.b])).values()].sort((a,b) => a.port - b.port);
  const hasLat = pairs.some(p => p.latency?.avg != null);

  const ts    = new Date(results.startedAt).toLocaleString('ko-KR');
  const tsEnd = new Date(results.finishedAt || results.startedAt).toLocaleString('ko-KR');
  const durSec = results.finishedAt
    ? Math.round((new Date(results.finishedAt) - new Date(results.startedAt)) / 1000) : '?';

  // Summary stats
  const validPairs = pairs.filter(p => !p.error && p.atob);
  const avgPdrAtob = validPairs.length ? (validPairs.reduce((s,p) => s + (p.atob?.pdr||0), 0) / validPairs.length).toFixed(1) : '—';
  const avgPdrBtoa = validPairs.filter(p=>p.btoa).length
    ? (validPairs.filter(p=>p.btoa).reduce((s,p) => s + (p.btoa?.pdr||0), 0) / validPairs.filter(p=>p.btoa).length).toFixed(1) : '—';
  const maxMbps    = Math.max(...validPairs.map(p => p.atob?.mbps || 0));
  const minPdr     = validPairs.length ? Math.min(...validPairs.map(p => Math.min(p.atob?.pdr||100, p.btoa?.pdr||100))) : 0;
  const passCount  = validPairs.filter(p => (p.atob?.pdr||0) >= 99 && (p.btoa?.pdr||100) >= 99).length;
  const totalCount = pairs.length;

  // Chart datasets
  const pairLabels = pairs.map(p => `P${p.a.port}→P${p.b.port}`);
  const atobPdrs   = pairs.map(p => p.atob?.pdr ?? 0);
  const btoaPdrs   = pairs.map(p => p.btoa?.pdr ?? 0);
  const atobMbps   = pairs.map(p => p.atob?.mbps ?? 0);
  const btoaMbps   = pairs.map(p => p.btoa?.mbps ?? 0);
  const latAvgs    = pairs.map(p => p.latency?.avg ?? null);
  const latP95s    = pairs.map(p => p.latency?.p95 ?? null);

  // Matrix table html
  let matrixTh = '<th></th>' + bSet.map(b => `<th>P${b.port}<br>${H(b.iface)}</th>`).join('');
  let matrixRows = aSet.map(a => {
    const cells = bSet.map(b => {
      const pr = pairs.find(p => p.a.port === a.port && p.b.port === b.port);
      if (!pr || pr.error) return `<td style="text-align:center;color:#ef4444;">${pr?.error ? 'ERR' : '—'}</td>`;
      const worstPdr = Math.min(pr.atob?.pdr ?? 100, pr.btoa?.pdr ?? 100);
      const col = worstPdr >= 99 ? '#22c55e' : worstPdr >= 80 ? '#f59e0b' : '#ef4444';
      const bg  = worstPdr >= 99 ? '#22c55e12' : worstPdr >= 80 ? '#f59e0b12' : '#ef444412';
      const lat = pr.latency?.avg != null ? `<br><span style="font-size:10px;color:#94a3b8;">${pr.latency.avg}ms</span>` : '';
      return `<td style="text-align:center;background:${bg};">
        <span style="font-weight:700;color:${col};font-size:13px;">${pr.atob?.pdr ?? '—'}%</span>
        <br><span style="font-size:10px;color:#94a3b8;">↔ ${pr.btoa?.pdr ?? '—'}%</span>${lat}
      </td>`;
    }).join('');
    return `<tr><th style="text-align:left;">P${a.port} ${H(a.iface)}</th>${cells}</tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Matrix Benchmark Report — ${H(ts)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:28px 32px;min-width:800px}
h1{font-size:22px;font-weight:700;margin-bottom:4px;color:#f1f5f9}
.meta{font-size:11px;color:#64748b;margin-bottom:22px;line-height:1.8}
.section{font-size:10px;font-weight:700;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin:20px 0 10px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:20px}
.card{background:#1e293b;border-radius:8px;padding:16px;border:1px solid #334155}
.card-title{font-size:10px;font-weight:600;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px}
.stat{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;text-align:center}
.stat.ok{border-color:#22c55e66;background:#22c55e0a}
.stat.warn{border-color:#f59e0b66;background:#f59e0b0a}
.stat.bad{border-color:#ef444466;background:#ef44440a}
.sl{font-size:9px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
.sv{font-size:22px;font-weight:700}
.su{font-size:10px;color:#94a3b8;margin-top:2px}
.ok{color:#22c55e}.warn{color:#f59e0b}.bad{color:#ef4444}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#0f172a;color:#64748b;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
   padding:8px 10px;border:1px solid #334155;text-align:left}
td{padding:8px 10px;border:1px solid #334155}
.footer{margin-top:36px;font-size:10px;color:#334155;text-align:center;border-top:1px solid #1e293b;padding-top:14px}
canvas{max-height:260px}
</style></head>
<body>
<h1>PacketLabManager — Matrix Benchmark Report</h1>
<div class="meta">
  Node A: <strong>${H(results.nodeAUrl)}</strong> &nbsp;|&nbsp;
  Node B: <strong>${H(results.nodeBUrl)}</strong><br>
  시작: ${H(ts)} &nbsp;|&nbsp; 완료: ${H(tsEnd)} &nbsp;|&nbsp; 소요: ${durSec}초
</div>

<div class="section">Summary</div>
<div class="grid-stats">
  <div class="stat ${passCount === totalCount ? 'ok' : passCount > totalCount/2 ? 'warn' : 'bad'}">
    <div class="sl">PASS (PDR≥99%)</div>
    <div class="sv">${passCount} / ${totalCount}</div>
    <div class="su">조합</div>
  </div>
  <div class="stat ${Number(avgPdrAtob)>=99?'ok':Number(avgPdrAtob)>=80?'warn':'bad'}">
    <div class="sl">평균 PDR A→B</div><div class="sv">${avgPdrAtob}</div><div class="su">%</div>
  </div>
  <div class="stat ${Number(avgPdrBtoa)>=99?'ok':Number(avgPdrBtoa)>=80?'warn':'bad'}">
    <div class="sl">평균 PDR B→A</div><div class="sv">${avgPdrBtoa}</div><div class="su">%</div>
  </div>
  <div class="stat ${minPdr>=99?'ok':minPdr>=80?'warn':'bad'}">
    <div class="sl">최소 PDR (worst)</div><div class="sv">${minPdr}</div><div class="su">%</div>
  </div>
  <div class="stat">
    <div class="sl">최대 Throughput</div><div class="sv">${maxMbps}</div><div class="su">Mbps</div>
  </div>
</div>

<div class="section">Matrix (A→B % / B→A %${hasLat?' / avg latency':''})</div>
<div class="card" style="margin-bottom:14px;overflow-x:auto;">
  <table style="min-width:400px;"><thead><tr>${matrixTh}</tr></thead><tbody>${matrixRows}</tbody></table>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-title">PDR A→B per Port Pair (%)</div>
    <canvas id="cAtob"></canvas>
  </div>
  <div class="card">
    <div class="card-title">PDR B→A per Port Pair (%)</div>
    <canvas id="cBtoa"></canvas>
  </div>
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-title">Throughput A→B per Port Pair (Mbps)</div>
    <canvas id="cMbpsA"></canvas>
  </div>
  <div class="card">
    <div class="card-title">${hasLat ? 'Latency avg / p95 per Port Pair (ms)' : 'Throughput B→A per Port Pair (Mbps)'}</div>
    <canvas id="cMbpsB"></canvas>
  </div>
</div>

<div class="section">Detail</div>
<div class="card" style="margin-bottom:14px;overflow-x:auto;">
<table style="min-width:700px;"><thead><tr>
  <th>#</th><th>A Port</th><th>A Interface</th><th>B Port</th><th>B Interface</th>
  <th>A→B PDR</th><th>A→B Mbps</th><th>A→B Loss</th>
  <th>B→A PDR</th><th>B→A Mbps</th><th>B→A Loss</th>
  ${hasLat ? '<th>Lat avg</th><th>Lat p95</th><th>Jitter</th>' : ''}
</tr></thead><tbody>
${pairs.map((pr, i) => `<tr>
  <td>${i+1}</td>
  <td>P${pr.a.port}</td><td>${H(pr.a.iface)}</td>
  <td>P${pr.b.port}</td><td>${H(pr.b.iface)}</td>
  <td class="${(pr.atob?.pdr??0)>=99?'ok':(pr.atob?.pdr??0)>=80?'warn':'bad'}">${pr.atob?.pdr ?? '—'}%</td>
  <td>${pr.atob?.mbps ?? '—'}</td>
  <td>${pr.atob?.lost ?? '—'}</td>
  <td class="${(pr.btoa?.pdr??0)>=99?'ok':(pr.btoa?.pdr??0)>=80?'warn':'bad'}">${pr.btoa?.pdr ?? '—'}%</td>
  <td>${pr.btoa?.mbps ?? '—'}</td>
  <td>${pr.btoa?.lost ?? '—'}</td>
  ${hasLat ? `<td>${pr.latency?.avg ?? '—'}</td><td>${pr.latency?.p95 ?? '—'}</td><td>${pr.latency?.jitter ?? '—'}</td>` : ''}
</tr>`).join('')}
</tbody></table></div>

<div class="footer">
  PacketLabManager Matrix Benchmark &nbsp;|&nbsp; ${H(ts)}<br>
  Node A: ${H(results.nodeAUrl)} &nbsp;|&nbsp; Node B: ${H(results.nodeBUrl)}
</div>

<script>
Chart.defaults.color='#94a3b8'; Chart.defaults.borderColor='#334155';
const pairLabels=${JSON.stringify(pairLabels)};
const atobPdrs=${JSON.stringify(atobPdrs)};
const btoaPdrs=${JSON.stringify(btoaPdrs)};
const pdrColors=v=>v>=99?'#22c55e':v>=80?'#f59e0b':'#ef4444';

new Chart(document.getElementById('cAtob'),{type:'bar',
  data:{labels:pairLabels,datasets:[{data:atobPdrs,backgroundColor:atobPdrs.map(pdrColors),borderRadius:4}]},
  options:{responsive:true,scales:{y:{min:0,max:100,grid:{color:'#1e293b'},ticks:{callback:v=>v+'%'}}},plugins:{legend:{display:false}}}});

new Chart(document.getElementById('cBtoa'),{type:'bar',
  data:{labels:pairLabels,datasets:[{data:btoaPdrs,backgroundColor:btoaPdrs.map(pdrColors),borderRadius:4}]},
  options:{responsive:true,scales:{y:{min:0,max:100,grid:{color:'#1e293b'},ticks:{callback:v=>v+'%'}}},plugins:{legend:{display:false}}}});

new Chart(document.getElementById('cMbpsA'),{type:'bar',
  data:{labels:pairLabels,datasets:[{label:'Mbps',data:${JSON.stringify(atobMbps)},backgroundColor:'rgba(59,130,246,0.7)',borderRadius:4}]},
  options:{responsive:true,scales:{y:{grid:{color:'#1e293b'}}},plugins:{legend:{display:false}}}});

${hasLat ? `
new Chart(document.getElementById('cMbpsB'),{type:'bar',
  data:{labels:pairLabels,datasets:[
    {label:'avg(ms)',data:${JSON.stringify(latAvgs)},backgroundColor:'rgba(168,85,247,0.7)',borderRadius:4},
    {label:'p95(ms)',data:${JSON.stringify(latP95s)},backgroundColor:'rgba(249,115,22,0.5)',borderRadius:4}
  ]},
  options:{responsive:true,scales:{y:{grid:{color:'#1e293b'},ticks:{callback:v=>v+'ms'}}},plugins:{legend:{position:'top'}}}});
` : `
new Chart(document.getElementById('cMbpsB'),{type:'bar',
  data:{labels:pairLabels,datasets:[{label:'Mbps',data:${JSON.stringify(btoaMbps)},backgroundColor:'rgba(16,185,129,0.7)',borderRadius:4}]},
  options:{responsive:true,scales:{y:{grid:{color:'#1e293b'}}},plugins:{legend:{display:false}}}});
`}
</script>
</body></html>`;
}

function _buildBenchReport(params, res) {
  const r     = res.results || {};
  const pdr   = r.pdr       || {};
  const lat   = (r.latency?.atob) || {};
  const sw    = r.frameSweep?.sizes || [];
  const score = res.score || _benchScore(r);
  const H     = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const pdrLabels = JSON.stringify(['A → B','B → A']);
  const pdrData   = JSON.stringify([pdr.atob?.pdr??0, pdr.btoa?.pdr??0]);
  const pdrColors = JSON.stringify([(pdr.atob?.pdr??0)>=99?'#22c55e':(pdr.atob?.pdr??0)>=80?'#f59e0b':'#ef4444',
                                     (pdr.btoa?.pdr??0)>=99?'#22c55e':(pdr.btoa?.pdr??0)>=80?'#f59e0b':'#ef4444']);
  const latSamples = JSON.stringify(lat.samples || []);
  const swLabels  = JSON.stringify(sw.map(s => s.payloadBytes+'B'));
  const swPdr     = JSON.stringify(sw.map(s => s.pdr));
  const swMbps    = JSON.stringify(sw.map(s => s.mbps));

  const ts    = new Date(res.startedAt).toLocaleString('ko-KR');
  const tsEnd = new Date(res.finishedAt || res.startedAt).toLocaleString('ko-KR');
  const durSec = res.finishedAt
    ? Math.round((new Date(res.finishedAt) - new Date(res.startedAt)) / 1000)
    : '?';

  // Build latency histogram buckets
  const latHistBuckets = [];
  if (lat.samples?.length) {
    const step = Math.max(5, Math.ceil((lat.max - lat.min) / 10));
    for (let v = lat.min; v <= lat.max + step; v += step) {
      latHistBuckets.push({ label: `${v}ms`, count: 0, start: v, end: v + step });
    }
    lat.samples.forEach(s => {
      const b = latHistBuckets.find(b => s >= b.start && s < b.end);
      if (b) b.count++;
    });
  }

  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Benchmark Report — ${H(ts)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:28px 32px;min-width:720px}
h1{font-size:22px;font-weight:700;margin-bottom:4px;color:#f1f5f9}
.meta{font-size:11px;color:#64748b;margin-bottom:24px;line-height:1.8}
.section{font-size:10px;font-weight:700;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin:20px 0 10px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}
.grid-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:20px}
.card{background:#1e293b;border-radius:8px;padding:16px;border:1px solid #334155}
.card-title{font-size:10px;font-weight:600;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px}
.stat{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;text-align:center}
.stat.ok{border-color:#22c55e66;background:#22c55e0a}
.stat.warn{border-color:#f59e0b66;background:#f59e0b0a}
.stat.bad{border-color:#ef444466;background:#ef44440a}
.sl{font-size:9px;color:#64748b;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
.sv{font-size:22px;font-weight:700}
.su{font-size:10px;color:#94a3b8;margin-top:2px}
.ok{color:#22c55e}.warn{color:#f59e0b}.bad{color:#ef4444}
table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#0f172a;color:#64748b;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid #334155;text-align:left}
td{padding:8px 10px;border-bottom:1px solid #1e293b}
tr:last-child td{border-bottom:none}
.footer{margin-top:36px;font-size:10px;color:#334155;text-align:center;border-top:1px solid #1e293b;padding-top:14px}
canvas{max-height:260px}
</style></head>
<body>
<h1>PacketLabManager — Benchmark Report</h1>
<div class="meta">
  Node A: <strong>${H(params.nodeAUrl)}</strong> &nbsp;(${H(params.nodeAIface)}) &nbsp;|&nbsp;
  Node B: <strong>${H(params.nodeBUrl)}</strong> &nbsp;(${H(params.nodeBIface)})<br>
  시작: ${H(ts)} &nbsp;|&nbsp; 완료: ${H(tsEnd)} &nbsp;|&nbsp; 소요: ${durSec}초
</div>

<!-- Score banner -->
<div style="display:flex;align-items:center;gap:20px;background:#1e293b;border:2px solid ${score.color}44;border-radius:10px;padding:16px 24px;margin-bottom:20px;">
  <div style="font-size:52px;font-weight:800;color:${score.color};line-height:1;">${score.total}</div>
  <div>
    <div style="font-size:10px;color:#64748b;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px;">종합 점수</div>
    <div style="font-size:24px;font-weight:800;color:${score.color};">${score.grade}</div>
    <div style="font-size:11px;color:#64748b;">PDR·Latency·FrameSweep 기반 100점 만점</div>
  </div>
</div>

<div class="section">Summary</div>
<div class="grid-stats">
  ${[
    ['PDR A→B','%', pdr.atob?.pdr??'—', (pdr.atob?.pdr??0)>=99?'ok':(pdr.atob?.pdr??0)>=80?'warn':'bad'],
    ['PDR B→A','%', pdr.btoa?.pdr??'—', (pdr.btoa?.pdr??0)>=99?'ok':(pdr.btoa?.pdr??0)>=80?'warn':'bad'],
    ['Loss A→B','pkts', pdr.atob?.lost??'—', (pdr.atob?.lost||0)===0?'ok':(pdr.atob?.lost||0)<5?'warn':'bad'],
    ['Throughput A→B','Mbps', pdr.atob?.mbps??'—',''],
    ['PPS A→B','pps', pdr.atob?.pps??'—',''],
    ['Latency avg','ms', lat.avg??'—',''],
    ['Latency p50','ms', lat.p50??'—',''],
    ['Latency p95','ms', lat.p95??'—',''],
    ['Jitter','ms', lat.jitter??'—', (lat.jitter??99)<=10?'ok':(lat.jitter??99)<=30?'warn':'bad'],
  ].map(([l,u,v,c])=>`<div class="stat ${c}"><div class="sl">${H(l)}</div><div class="sv">${H(String(v))}</div><div class="su">${H(u)}</div></div>`).join('')}
</div>

<div class="grid-2">
  <div class="card">
    <div class="card-title">Packet Delivery Rate (%)</div>
    <canvas id="cPdr"></canvas>
  </div>
  <div class="card">
    <div class="card-title">Latency A→B — RTT Trend (ms)</div>
    <canvas id="cLat"></canvas>
  </div>
</div>
${latHistBuckets.length ? `
<div class="grid-2" style="margin-bottom:14px;">
  <div class="card">
    <div class="card-title">Latency Distribution (Histogram)</div>
    <canvas id="cLatHist"></canvas>
  </div>
  <div class="card">
    <div class="card-title">Latency Percentiles (ms)</div>
    <canvas id="cLatPct"></canvas>
  </div>
</div>` : ''}

${sw.length ? `
<div class="grid-2">
  <div class="card">
    <div class="card-title">Frame Size Sweep — PDR (%)</div>
    <canvas id="cSwPdr"></canvas>
  </div>
  <div class="card">
    <div class="card-title">Frame Size Sweep — Throughput (Mbps)</div>
    <canvas id="cSwMbps"></canvas>
  </div>
</div>` : ''}

<div class="section">PDR Detail</div>
<div class="card" style="margin-bottom:14px;">
<table><thead><tr><th>Direction</th><th>Sent</th><th>Received</th><th>Lost</th><th>PDR %</th><th>PPS</th><th>Throughput</th></tr></thead><tbody>
${[['A → B', pdr.atob], ['B → A', pdr.btoa]].filter(x=>x[1]).map(([d,v])=>`
<tr><td>${d}</td><td>${v.sent}</td><td>${v.received}</td><td class="${v.lost===0?'ok':v.lost<5?'warn':'bad'}">${v.lost}</td>
<td class="${v.pdr>=99?'ok':v.pdr>=80?'warn':'bad'}">${v.pdr}%</td><td>${v.pps}</td><td>${v.mbps} Mbps</td></tr>`).join('')}
</tbody></table></div>

${lat.avg != null ? `
<div class="section">Latency Statistics (A→B)</div>
<div class="card" style="margin-bottom:14px;">
<table><thead><tr><th>지표</th><th>값 (ms)</th></tr></thead><tbody>
${[['Min',lat.min],['Max',lat.max],['Avg',lat.avg],['P50 (Median)',lat.p50],['P95',lat.p95],['P99',lat.p99],['Valid / Total', lat.valid+' / '+lat.iterations]]
  .map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
</tbody></table>
<div style="font-size:10px;color:#475569;margin-top:8px;">* 소프트웨어 RTT: 패킷 전송 API 호출 → 수신 캡처 버퍼에서 확인까지의 시간 (네트워크 지연 + 캡처/폴링 오버헤드 포함)</div>
</div>` : ''}

${sw.length ? `
<div class="section">Frame Size Sweep Detail</div>
<div class="card" style="margin-bottom:14px;">
<table><thead><tr><th>Payload</th><th>Frame</th><th>Sent</th><th>Rcvd</th><th>PDR %</th><th>PPS</th><th>Mbps</th></tr></thead><tbody>
${sw.map(s=>`<tr><td>${s.payloadBytes}B</td><td>${s.payloadBytes+42}B</td><td>${s.sent}</td><td>${s.received}</td>
<td class="${s.pdr>=99?'ok':s.pdr>=80?'warn':'bad'}">${s.pdr}%</td><td>${s.pps}</td><td>${s.mbps}</td></tr>`).join('')}
</tbody></table></div>` : ''}

<div class="footer">
  PacketLabManager Benchmark &nbsp;|&nbsp; ${H(ts)} &nbsp;|&nbsp;
  Node A: ${H(params.nodeAUrl)} (${H(params.nodeAIface)}) → Node B: ${H(params.nodeBUrl)} (${H(params.nodeBIface)})
</div>

<script>
Chart.defaults.color='#94a3b8';
Chart.defaults.borderColor='#334155';
const accent='#3b82f6';

// PDR Bar
new Chart(document.getElementById('cPdr'),{
  type:'bar',
  data:{labels:${pdrLabels},datasets:[{label:'PDR %',data:${pdrData},backgroundColor:${pdrColors},borderRadius:5}]},
  options:{responsive:true,scales:{y:{min:0,max:100,grid:{color:'#1e293b'},ticks:{callback:v=>v+'%'}}},plugins:{legend:{display:false}}}
});

// Latency trend line
${lat.samples?.length ? `
new Chart(document.getElementById('cLat'),{
  type:'line',
  data:{labels:${JSON.stringify((lat.samples||[]).map((_,i)=>i+1))},
    datasets:[{label:'RTT(ms)',data:${latSamples},borderColor:accent,backgroundColor:'rgba(59,130,246,0.1)',fill:true,pointRadius:2,tension:.2}]},
  options:{responsive:true,scales:{y:{grid:{color:'#1e293b'},ticks:{callback:v=>v+'ms'}}},plugins:{legend:{display:false}}}
});
// Latency histogram
if(document.getElementById('cLatHist')){
  const hData=${JSON.stringify(latHistBuckets)};
  new Chart(document.getElementById('cLatHist'),{
    type:'bar',
    data:{labels:hData.map(b=>b.label),datasets:[{data:hData.map(b=>b.count),backgroundColor:'rgba(168,85,247,0.7)',borderRadius:3}]},
    options:{responsive:true,scales:{y:{grid:{color:'#1e293b'},title:{display:true,text:'count'}}},plugins:{legend:{display:false}}}
  });
}
// Latency percentile bar
if(document.getElementById('cLatPct')){
  const pctLabels=['min','p50','p95','p99','max'];
  const pctData=[${[lat.min,lat.p50,lat.p95,lat.p99,lat.max].join(',')}];
  const pctColors=['#22c55e','#3b82f6','#f59e0b','#f97316','#ef4444'];
  new Chart(document.getElementById('cLatPct'),{
    type:'bar',
    data:{labels:pctLabels,datasets:[{data:pctData,backgroundColor:pctColors,borderRadius:4}]},
    options:{responsive:true,scales:{y:{grid:{color:'#1e293b'},ticks:{callback:v=>v+'ms'}}},plugins:{legend:{display:false}}}
  });
}` : `if(document.getElementById('cLat'))document.getElementById('cLat').closest('.card').innerHTML+='<div style="color:#475569;font-size:12px;margin-top:8px;">레이턴시 데이터 없음</div>';`}

// Frame sweep
${sw.length ? `
new Chart(document.getElementById('cSwPdr'),{
  type:'bar',
  data:{labels:${swLabels},datasets:[{label:'PDR%',data:${swPdr},
    backgroundColor:${JSON.stringify(sw.map(s=>s.pdr>=99?'#22c55e':s.pdr>=80?'#f59e0b':'#ef4444'))},borderRadius:4}]},
  options:{responsive:true,scales:{y:{min:0,max:100,grid:{color:'#1e293b'}}},plugins:{legend:{display:false}}}
});
new Chart(document.getElementById('cSwMbps'),{
  type:'line',
  data:{labels:${swLabels},datasets:[{label:'Mbps',data:${swMbps},
    borderColor:'#a855f7',backgroundColor:'rgba(168,85,247,0.1)',fill:true,pointRadius:5,tension:.3}]},
  options:{responsive:true,scales:{y:{grid:{color:'#1e293b'}}},plugins:{legend:{display:false}}}
});` : ''}
</script>
</body></html>`;
}

// ── PCP Mapper ────────────────────────────────────────────────────────────────
(function pcpMapper() {
  // State: ingressMap[i] = InterPriority index (0-7), or -1 if unconnected
  //        egressMap[i]  = Egress PCP index (0-8), or -1 if unconnected
  // Both indexed by source: ingressMap[0..8] = Ingress PCP 0..8 → Inter
  //                         egressMap[0..7]  = Inter 0..7 → Egress PCP
  let currentPort = 0;
  // portData[port] = { ingress: int[9], egress: int[8] }
  const portData = {};
  function defaultMap() {
    return {
      ingress: [-1,-1,-1,-1,-1,-1,-1,-1,-1], // [0..7]=PCP#0~7, [8]=Untagged → inter idx
      egress:  [-1,-1,-1,-1,-1,-1,-1,-1,-1], // [0..7]=Inter0~7, [8]=InterUntag → egress idx
    };
  }
  function getData(port) {
    if (!portData[port]) portData[port] = defaultMap();
    return portData[port];
  }

  const mapper   = document.getElementById('pcpMapper');
  if (!mapper) return;

  const svg  = document.getElementById('pcpSvg');
  const stEl = document.getElementById('rv-st-pcp');

  // ── Drag state ──────────────────────────────────────────────────────────────
  let drag = null; // { fromCol, fromIdx, ghostPath, startX, startY }

  function dotCenter(dotEl) {
    const mr  = mapper.getBoundingClientRect();
    const dr  = dotEl.getBoundingClientRect();
    return {
      x: dr.left + dr.width / 2 - mr.left,
      y: dr.top  + dr.height / 2 - mr.top,
    };
  }

  function getDot(col, idx, side) {
    if (col === 'inter') {
      return mapper.querySelector(
        `.pcp-dot[data-col="inter"][data-idx="${idx}"][data-side="${side}"]`
      );
    }
    return mapper.querySelector(`.pcp-dot[data-col="${col}"][data-idx="${idx}"]`);
  }

  function cubicPath(x1, y1, x2, y2) {
    const cx = (x1 + x2) / 2;
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
  }

  // ── Render lines ─────────────────────────────────────────────────────────────
  function renderLines() {
    const d = getData(currentPort);
    // Remove all lines but keep ghost if dragging
    svg.querySelectorAll('.pcp-line').forEach(el => el.remove());

    // Ingress → Inter
    d.ingress.forEach((inter, inIdx) => {
      if (inter < 0) return;
      const fromDot = getDot('ingress', inIdx, null);
      const toDot   = getDot('inter',   inter, 'left');
      if (!fromDot || !toDot) return;
      const f = dotCenter(fromDot);
      const t = dotCenter(toDot);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', cubicPath(f.x, f.y, t.x, t.y));
      path.classList.add('pcp-line');
      path.addEventListener('click', () => {
        getData(currentPort).ingress[inIdx] = -1;
        renderLines();
        updateDotStates();
      });
      svg.appendChild(path);
    });

    // Inter → Egress
    d.egress.forEach((egIdx, interIdx) => {
      if (egIdx < 0) return;
      const fromDot = getDot('inter',  interIdx, 'right');
      const toDot   = getDot('egress', egIdx,    null);
      if (!fromDot || !toDot) return;
      const f = dotCenter(fromDot);
      const t = dotCenter(toDot);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', cubicPath(f.x, f.y, t.x, t.y));
      path.classList.add('pcp-line');
      path.addEventListener('click', () => {
        getData(currentPort).egress[interIdx] = -1;
        renderLines();
        updateDotStates();
      });
      svg.appendChild(path);
    });
  }

  function updateDotStates() {
    const d = getData(currentPort);
    // ingress out-dots
    mapper.querySelectorAll('.pcp-dot[data-col="ingress"]').forEach(dot => {
      const idx = Number(dot.dataset.idx);
      dot.classList.toggle('connected', d.ingress[idx] >= 0);
    });
    // inter left-dots
    mapper.querySelectorAll('.pcp-dot[data-col="inter"][data-side="left"]').forEach(dot => {
      const idx = Number(dot.dataset.idx);
      const connected = d.ingress.some(v => v === idx);
      dot.classList.toggle('connected', connected);
    });
    // inter right-dots (0~8 including Untagged)
    mapper.querySelectorAll('.pcp-dot[data-col="inter"][data-side="right"]').forEach(dot => {
      const idx = Number(dot.dataset.idx);
      dot.classList.toggle('connected', (d.egress[idx] ?? -1) >= 0);
    });
    // egress in-dots
    mapper.querySelectorAll('.pcp-dot[data-col="egress"]').forEach(dot => {
      const idx = Number(dot.dataset.idx);
      const connected = d.egress.some(v => v === idx);
      dot.classList.toggle('connected', connected);
    });
  }

  function redraw() { renderLines(); updateDotStates(); if (typeof syncRegFromWiring === 'function') syncRegFromWiring(); }

  // ── Drag handlers ─────────────────────────────────────────────────────────
  mapper.addEventListener('mousedown', e => {
    const dot = e.target.closest('.pcp-dot');
    if (!dot) return;
    e.preventDefault();

    const col  = dot.dataset.col;
    const idx  = Number(dot.dataset.idx);
    const side = dot.dataset.side || null;
    const start = dotCenter(dot);

    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    ghost.classList.add('pcp-ghost');
    svg.appendChild(ghost);

    drag = { fromCol: col, fromIdx: idx, side, ghost, startX: start.x, startY: start.y };
    dot.classList.add('drag-active');
  });

  document.addEventListener('mousemove', e => {
    if (!drag) return;
    const mr = mapper.getBoundingClientRect();
    const mx = e.clientX - mr.left;
    const my = e.clientY - mr.top;
    drag.ghost.setAttribute('d', cubicPath(drag.startX, drag.startY, mx, my));
  });

  document.addEventListener('mouseup', e => {
    if (!drag) return;
    drag.ghost.remove();
    const { fromCol, fromIdx, side } = drag;
    drag = null;
    mapper.querySelectorAll('.pcp-dot.drag-active').forEach(d => d.classList.remove('drag-active'));

    const el   = document.elementFromPoint(e.clientX, e.clientY);
    const tDot = el && el.closest('.pcp-dot');
    if (!tDot) return;

    const tCol  = tDot.dataset.col;
    const tIdx  = Number(tDot.dataset.idx);
    const tSide = tDot.dataset.side || null;
    const d = getData(currentPort);

    // Normalize: always store as (outCol/outIdx) → (inCol/inIdx)
    // Ingress out → Inter left-in
    if (fromCol === 'ingress' && tCol === 'inter') {
      d.ingress[fromIdx] = tIdx;
      redraw();
    // Inter left-in ← Ingress out  (reversed drag)
    } else if (fromCol === 'inter' && tCol === 'ingress' && side === 'left') {
      d.ingress[tIdx] = fromIdx;
      redraw();
    // Inter right-out → Egress in
    } else if (fromCol === 'inter' && tCol === 'egress' && (side === 'right' || side === null)) {
      d.egress[fromIdx] = tIdx;
      redraw();
    // Egress in ← Inter right-out  (reversed drag)
    } else if (fromCol === 'egress' && tCol === 'inter') {
      d.egress[tIdx] = fromIdx;
      redraw();
    }
  });

  // ── Port buttons ────────────────────────────────────────────────────────────
  document.getElementById('pcpPortBtns').addEventListener('click', e => {
    const btn = e.target.closest('.pcp-port-btn');
    if (!btn) return;
    document.querySelectorAll('.pcp-port-btn').forEach(b => b.classList.remove('pcp-port-active'));
    btn.classList.add('pcp-port-active');
    currentPort = Number(btn.dataset.port);
    redraw();
  });

  // ── Status helper ────────────────────────────────────────────────────────────
  function setStatus(msg, ok) {
    stEl.textContent = msg;
    stEl.className = 'reg-status' + (ok ? ' ok' : '');
  }

  // ── Read ──────────────────────────────────────────────────────────────────────
  async function readPort(port) {
    const ri = await fetch('/api/table/pcp/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, dir: 0 }),
    }).then(r => r.json());
    if (!ri.ok) throw new Error(ri.error);

    const re = await fetch('/api/table/pcp/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port, dir: 1 }),
    }).then(r => r.json());
    if (!re.ok) throw new Error(re.error);

    portData[port] = {
      ingress: ri.map,
      egress:  re.map.slice(0, 8),
    };
  }

  document.getElementById('pcpRead').addEventListener('click', async () => {
    setStatus('Reading...', false);
    try {
      await readPort(currentPort);
      redraw();
      setStatus('P' + currentPort + ' read OK', true);
    } catch (e) { setStatus(e.message, false); }
  });

  document.getElementById('pcpReadAll').addEventListener('click', async () => {
    setStatus('Reading all ports...', false);
    try {
      for (let p = 0; p < 9; p++) await readPort(p);
      redraw();
      setStatus('All ports read OK', true);
    } catch (e) { setStatus(e.message, false); }
  });

  // ── Write ─────────────────────────────────────────────────────────────────────
  document.getElementById('pcpWrite').addEventListener('click', async () => {
    setStatus('Writing...', false);
    try {
      const d = getData(currentPort);
      const inMap = d.ingress.map(v => v < 0 ? 0 : v);
      const egMap = [...d.egress.map(v => v < 0 ? 0 : v), 0];

      const wi = await fetch('/api/table/pcp/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: currentPort, dir: 0, map: inMap }),
      }).then(r => r.json());
      if (!wi.ok) throw new Error(wi.error);

      const we = await fetch('/api/table/pcp/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: currentPort, dir: 1, map: egMap }),
      }).then(r => r.json());
      if (!we.ok) throw new Error(we.error);

      setStatus('P' + currentPort + ' write OK', true);
    } catch (e) { setStatus(e.message, false); }
  });

  // ── Reset ─────────────────────────────────────────────────────────────────────
  document.getElementById('pcpReset').addEventListener('click', () => {
    portData[currentPort] = defaultMap();
    redraw();
    setStatus('Reset to default', true);
  });

  // ── Register View ─────────────────────────────────────────────────────────────
  let regViewDir = 0; // 0=ingress, 1=egress

  // Field labels per direction
  const FIELD_LABELS_INGRESS = ['PCP#7','PCP#6','PCP#5','PCP#4','PCP#3','PCP#2','PCP#1','PCP#0'];
  const FIELD_LABELS_EGRESS  = ['Inter7','Inter6','Inter5','Inter4','Inter3','Inter2','Inter1','Inter0'];

  // Build the 8 input fields for WR_DATA[0]
  function buildRegFields() {
    const container = document.getElementById('pcpRegFields0');
    container.innerHTML = '';
    const labels = regViewDir === 0 ? FIELD_LABELS_INGRESS : FIELD_LABELS_EGRESS;
    // fields array: index 0 = highest bits (PCP#7/Inter7) displayed leftmost
    for (let i = 0; i < 8; i++) {
      const bitHi = 31 - i * 4;
      const bitLo = bitHi - 3;
      const srcIdx = 7 - i; // PCP#7 is at array position 7
      const cell = document.createElement('div');
      cell.className = 'pcp-reg-field';
      cell.innerHTML = `
        <div class="pcp-reg-field-bits">[${bitHi}:${bitLo}]</div>
        <div class="pcp-reg-field-name">${labels[i]}</div>
        <input class="pcp-reg-input" type="number" min="0" max="8"
               data-reg-src="${srcIdx}" value="0">`;
      container.appendChild(cell);
    }

    // Attach input handlers
    container.querySelectorAll('.pcp-reg-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const srcIdx = Number(inp.dataset.regSrc);
        let val = Math.min(8, Math.max(0, Number(inp.value) || 0));
        inp.value = val;
        const d = getData(currentPort);
        if (regViewDir === 0) d.ingress[srcIdx] = val;
        else                  d.egress[srcIdx]  = val;
        updateRegHex();
        renderLines();
        updateDotStates();
        flashInput(inp);
      });
    });
  }

  function flashInput(inp) {
    inp.classList.add('synced');
    setTimeout(() => inp.classList.remove('synced'), 600);
  }

  function updateRegHex() {
    const d = getData(currentPort);
    const arr = regViewDir === 0 ? d.ingress : d.egress;

    // Pack WR_DATA[0]: arr[0]=PCP#0 at bits[3:0] .. arr[7]=PCP#7 at bits[31:28]
    let word0 = 0;
    for (let i = 0; i < 8; i++) {
      const v = arr[i] < 0 ? 0 : arr[i];
      word0 |= (v & 0xF) << (i * 4);
    }
    word0 = word0 >>> 0;

    // Untagged
    const untag = regViewDir === 0 ? (arr[8] < 0 ? 0 : arr[8]) : 0;
    const word1 = untag & 0xF;

    document.getElementById('pcpRegHex0').textContent =
      '0x' + word0.toString(16).toUpperCase().padStart(8, '0');
    document.getElementById('pcpRegHex1').textContent =
      '0x' + word1.toString(16).toUpperCase().padStart(8, '0');

    // Update index labels
    const idx0 = (currentPort << 2) | (regViewDir << 1) | 0;
    const idx1 = (currentPort << 2) | (regViewDir << 1) | 1;
    document.getElementById('pcpRegIdx0Label').textContent = `idx = 0x${idx0.toString(16).toUpperCase()}`;
    document.getElementById('pcpRegIdx1Label').textContent = `idx = 0x${idx1.toString(16).toUpperCase()}`;
  }

  // Sync register inputs FROM wiring state
  function syncRegFromWiring() {
    const d = getData(currentPort);
    const arr = regViewDir === 0 ? d.ingress : d.egress;
    const inputs = document.querySelectorAll('#pcpRegFields0 .pcp-reg-input');
    inputs.forEach(inp => {
      const srcIdx = Number(inp.dataset.regSrc);
      inp.value = arr[srcIdx] < 0 ? 0 : arr[srcIdx];
    });
    const untagVal = regViewDir === 0 ? (d.ingress[8] < 0 ? 0 : d.ingress[8]) : 0;
    document.getElementById('pcpRegUntag').value = untagVal;
    updateRegHex();
  }

  // Untagged input handler
  document.getElementById('pcpRegUntag').addEventListener('input', e => {
    let val = Math.min(8, Math.max(0, Number(e.target.value) || 0));
    e.target.value = val;
    if (regViewDir === 0) {
      getData(currentPort).ingress[8] = val;
      renderLines();
      updateDotStates();
    }
    updateRegHex();
    flashInput(e.target);
  });

  // Direction toggle
  document.querySelectorAll('input[name="pcpRegDir"]').forEach(radio => {
    radio.addEventListener('change', () => {
      regViewDir = Number(radio.value);
      buildRegFields();
      syncRegFromWiring();
    });
  });

  // ── Initial render ────────────────────────────────────────────────────────────
  setTimeout(() => {
    getData(currentPort);
    buildRegFields();
    redraw();
  }, 200);
  window.addEventListener('resize', () => redraw());
})();





// ── Traffic Policer Manager ───────────────────────────────────────────────────
(function tpManager() {
  let currentPort = 0;
  const slots = {};

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  // ── Conversions ──────────────────────────────────────────────────────────────
  function gbpsToBytes(gbps) { return Math.round(Number(gbps) * 125000000); }
  function bytesToGbps(bps)  { return (Number(bps) / 125000000).toFixed(6); }
  function kbToBytes(kb)     { return Math.round(Number(kb) * 1024); }
  function bytesToKb(b)      { return (Number(b) / 1024).toFixed(2); }

  function fmtBytes(n) {
    n = Number(n);
    if (n >= 1e9)  return (n / 1e9).toFixed(3)  + ' GB/s';
    if (n >= 1e6)  return (n / 1e6).toFixed(3)  + ' MB/s';
    if (n >= 1e3)  return (n / 1e3).toFixed(1)  + ' KB/s';
    return n + ' Byte/s';
  }
  function fmtByteSize(n) {
    n = Number(n);
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024)    return (n / 1024).toFixed(2)    + ' KB';
    return n + ' Byte';
  }

  // ── Live conversion hints ────────────────────────────────────────────────────
  function updateHints() {
    const cir = gbpsToBytes(document.getElementById('tpEditCir').value);
    const pir = gbpsToBytes(document.getElementById('tpEditPir').value);
    const cbs = kbToBytes(document.getElementById('tpEditCbs').value);
    const pbs = kbToBytes(document.getElementById('tpEditPbs').value);
    document.getElementById('tpConvCir').textContent = '= ' + cir.toLocaleString() + ' Byte/s  (' + fmtBytes(cir) + ')';
    document.getElementById('tpConvPir').textContent = '= ' + pir.toLocaleString() + ' Byte/s  (' + fmtBytes(pir) + ')';
    document.getElementById('tpConvCbs').textContent = '= ' + cbs.toLocaleString() + ' Byte  ('  + fmtByteSize(cbs) + ')';
    document.getElementById('tpConvPbs').textContent = '= ' + pbs.toLocaleString() + ' Byte  ('  + fmtByteSize(pbs) + ')';
  }

  ['tpEditCir','tpEditPir','tpEditCbs','tpEditPbs'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', updateHints);
  });

  // ── Port buttons ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.tp-port-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tp-port-btn').forEach(function(b) { b.classList.remove('tp-port-active'); });
      btn.classList.add('tp-port-active');
      currentPort = Number(btn.dataset.port);
      renderTable();
    });
  });

  // ── Table render ─────────────────────────────────────────────────────────────
  function renderTable() {
    const tbody   = document.getElementById('tpEntryRows');
    const countEl = document.getElementById('tpSlotCount');
    const data    = slots[currentPort];
    if (!data) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">Load port to view entries.</td></tr>';
      if (countEl) countEl.textContent = '';
      return;
    }
    const active = data.filter(function(s) { return s.valid; });
    if (countEl) countEl.textContent = active.length + ' active / 64 slots';
    if (!active.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No active slots.</td></tr>';
      return;
    }
    tbody.innerHTML = active.map(function(s) {
      return '<tr class="tp-entry-row" data-idx="' + s.idx + '">' +
        '<td>' + s.idx + '</td>' +
        '<td>' + s.vlanId + '</td>' +
        '<td>' + bytesToGbps(s.cir) + '</td>' +
        '<td>' + bytesToGbps(s.pir) + '</td>' +
        '<td>' + bytesToKb(s.cbs) + '</td>' +
        '<td>' + bytesToKb(s.pbs) + '</td>' +
        '<td style="text-align:center;"><button class="small tp-select-btn" data-idx="' + s.idx + '" title="Edit">&#9998;</button></td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('.tp-select-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) { e.stopPropagation(); loadEditPanel(Number(btn.dataset.idx)); });
    });
    tbody.querySelectorAll('.tp-entry-row').forEach(function(row) {
      row.addEventListener('click', function() { loadEditPanel(Number(row.dataset.idx)); });
    });
  }

  // ── Load into edit panel ─────────────────────────────────────────────────────
  function loadEditPanel(idx) {
    const data = slots[currentPort];
    if (!data) return;
    const s = data[idx];
    document.getElementById('tpEditIdx').value = idx;
    document.getElementById('tpEditSlotLabel').textContent = '#' + idx;
    if (s && s.valid) {
      document.getElementById('tpEditVlanId').value = s.vlanId;
      document.getElementById('tpEditCir').value    = bytesToGbps(s.cir);
      document.getElementById('tpEditPir').value    = bytesToGbps(s.pir);
      document.getElementById('tpEditCbs').value    = bytesToKb(s.cbs);
      document.getElementById('tpEditPbs').value    = bytesToKb(s.pbs);
    }
    updateHints();
    document.querySelectorAll('.tp-entry-row').forEach(function(r) { r.classList.remove('tp-row-selected'); });
    document.querySelectorAll('.tp-entry-row[data-idx="' + idx + '"]').forEach(function(r) { r.classList.add('tp-row-selected'); });
    const statusRow = document.getElementById('tpStatusRow');
    if (statusRow) statusRow.style.display = (s && s.valid) ? '' : 'none';
    document.getElementById('tpEditVlanId').focus();
  }

  // ── Load Port ────────────────────────────────────────────────────────────────
  document.getElementById('tpLoadPort').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-tp');
    st.textContent = 'Loading...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/table/tp/read-port', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), port: currentPort })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      slots[currentPort] = res.slots;
      renderTable();
      st.textContent = 'Loaded port ' + currentPort; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Clear All ────────────────────────────────────────────────────────────────
  document.getElementById('tpClearAll').addEventListener('click', async function() {
    const st   = document.getElementById('rv-st-tp');
    const data = slots[currentPort];
    if (!data) { st.textContent = 'Load port first'; st.style.color = 'var(--muted)'; return; }
    const active = data.filter(function(s) { return s.valid; });
    if (!active.length) { st.textContent = 'No active slots'; st.style.color = 'var(--muted)'; return; }
    st.textContent = 'Clearing ' + active.length + ' slots...'; st.style.color = 'var(--muted)';
    try {
      for (const s of active) {
        await api('/api/table/tp/delete', {
          method: 'POST',
          body: JSON.stringify({ session: getSession(), port: currentPort, idx: s.idx })
        });
        data[s.idx].valid = false;
      }
      renderTable();
      st.textContent = 'Cleared'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Read (single slot) ───────────────────────────────────────────────────────
  document.getElementById('tpEditRead').addEventListener('click', async function() {
    const st  = document.getElementById('rv-st-tp-edit');
    const idx = Number(document.getElementById('tpEditIdx').value);
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/table/tp/read-port', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), port: currentPort })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      slots[currentPort] = res.slots;
      renderTable();
      const s = res.slots[idx];
      if (s && s.valid) {
        loadEditPanel(idx);
        st.textContent = 'Slot ' + idx + ' read'; st.style.color = 'var(--green)';
      } else {
        st.textContent = 'Slot ' + idx + ' is empty (Valid=0)'; st.style.color = 'var(--muted)';
      }
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Write ────────────────────────────────────────────────────────────────────
  document.getElementById('tpEditWrite').addEventListener('click', async function() {
    const st     = document.getElementById('rv-st-tp-edit');
    const idx    = Number(document.getElementById('tpEditIdx').value);
    const vlanId = Number(document.getElementById('tpEditVlanId').value);
    const cir    = gbpsToBytes(document.getElementById('tpEditCir').value);
    const pir    = gbpsToBytes(document.getElementById('tpEditPir').value);
    const cbs    = kbToBytes(document.getElementById('tpEditCbs').value);
    const pbs    = kbToBytes(document.getElementById('tpEditPbs').value);
    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/table/tp/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), port: currentPort, idx, vlanId, cir, pir, cbs, pbs })
      });
      if (!res.ok) throw new Error(res.error || 'write failed');
      if (!slots[currentPort]) {
        slots[currentPort] = Array.from({length: 64}, function(_, i) { return { idx: i, valid: false }; });
      }
      slots[currentPort][idx] = { idx: idx, valid: true, vlanId: vlanId, cir: cir, pir: pir, cbs: cbs, pbs: pbs };
      renderTable();
      loadEditPanel(idx);
      st.textContent = 'Slot ' + idx + ' written'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Delete ───────────────────────────────────────────────────────────────────
  document.getElementById('tpEditDelete').addEventListener('click', async function() {
    const st  = document.getElementById('rv-st-tp-edit');
    const idx = Number(document.getElementById('tpEditIdx').value);
    st.textContent = 'Deleting...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/table/tp/delete', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), port: currentPort, idx: idx })
      });
      if (!res.ok) throw new Error(res.error || 'delete failed');
      if (slots[currentPort]) slots[currentPort][idx] = { idx: idx, valid: false };
      renderTable();
      const statusRow = document.getElementById('tpStatusRow');
      if (statusRow) statusRow.style.display = 'none';
      st.textContent = 'Slot ' + idx + ' deleted'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Bucket Status Refresh ────────────────────────────────────────────────────
  document.getElementById('tpStatusRefresh').addEventListener('click', async function() {
    const st  = document.getElementById('rv-st-tp-edit');
    const idx = Number(document.getElementById('tpEditIdx').value);
    try {
      const res = await api('/api/table/tp/read-status', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), port: currentPort, idx: idx })
      });
      if (!res.ok) throw new Error(res.error || 'status read failed');
      document.getElementById('tpStatusCbk').value = res.cbk;
      document.getElementById('tpStatusPbk').value = res.pbk;
      st.textContent = 'Status refreshed'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // Initial hint update
  updateHints();
})();



// ── Credit Based Shaper Manager ──────────────────────────────────────────────
(function cbsManager() {
  let currentPort = 0;
  // cache[port][pcp] = { idleSlope, idleSlopeTick, sendSlopeTick, hiCredit, loCredit }
  const cache = {};

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  function getPortParams() {
    const speed = Number(document.getElementById('cbsPortSpeed').value);
    const clk   = speed >= 10000000000 ? 156250000 : 125000000;
    const mtu   = Number(document.getElementById('cbsMtu').value) || 1522;
    return { speed, clk, mtu };
  }

  function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a; }

  function calcCbs(idleSlope) {
    const { speed, clk, mtu } = getPortParams();
    idleSlope = Number(idleSlope) || 0;
    const sendSlope     = speed - idleSlope;
    const bitPerTick    = speed / clk;
    const mtuTick       = Math.ceil((mtu * 8) / bitPerTick);
    const g             = gcd(idleSlope, sendSlope) || 1;
    const idleSlopeTick = Math.ceil(idleSlope / g);
    const sendSlopeTick = Math.ceil(sendSlope / g);
    const hiCredit      = mtuTick * idleSlopeTick;
    const loCredit      = mtuTick * sendSlopeTick;
    return { idleSlope, sendSlope, bitPerTick, mtuTick, g, idleSlopeTick, sendSlopeTick, hiCredit, loCredit };
  }

  function updateRowCalc(tr, d) {
    tr.querySelector('.cbs-idle-tick').textContent = d.idleSlopeTick.toLocaleString();
    tr.querySelector('.cbs-send-tick').textContent = d.sendSlopeTick.toLocaleString();
    tr.querySelector('.cbs-hi').textContent        = d.hiCredit.toLocaleString();
    tr.querySelector('.cbs-lo').textContent        = d.loCredit.toLocaleString();
  }

  function initTable() {
    const tbody = document.getElementById('cbsPcpRows');
    tbody.innerHTML = '';
    for (let pcp = 0; pcp < 8; pcp++) {
      const tr = document.createElement('tr');
      tr.dataset.pcp = pcp;
      tr.innerHTML =
        '<td>PCP ' + pcp + '</td>' +
        '<td><input class="cbs-idle-input" type="number" min="0" step="1000000" value="0" style="width:100%;"></td>' +
        '<td class="cbs-idle-tick">0</td>' +
        '<td class="cbs-send-tick">0</td>' +
        '<td class="cbs-hi">0</td>' +
        '<td class="cbs-lo">0</td>';
      tbody.appendChild(tr);

      tr.querySelector('.cbs-idle-input').addEventListener('input', function() {
        const calc = calcCbs(this.value);
        updateRowCalc(tr, calc);
        if (!cache[currentPort]) cache[currentPort] = {};
        cache[currentPort][pcp] = {
          idleSlope: Number(this.value),
          idleSlopeTick: calc.idleSlopeTick,
          sendSlopeTick: calc.sendSlopeTick,
          hiCredit: calc.hiCredit,
          loCredit: calc.loCredit
        };
      });
    }
  }

  // ── Port buttons ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.cbs-port-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.cbs-port-btn').forEach(function(b) { b.classList.remove('cbs-port-active'); });
      btn.classList.add('cbs-port-active');
      currentPort = Number(btn.dataset.port);
      loadCacheToTable();
    });
  });

  function loadCacheToTable() {
    document.querySelectorAll('#cbsPcpRows tr').forEach(function(tr) {
      const pcp  = Number(tr.dataset.pcp);
      const data = cache[currentPort] && cache[currentPort][pcp];
      const inp  = tr.querySelector('.cbs-idle-input');
      if (data) {
        inp.value = data.idleSlope || 0;
        updateRowCalc(tr, data);
      } else {
        inp.value = 0;
        updateRowCalc(tr, { idleSlopeTick: 0, sendSlopeTick: 0, hiCredit: 0, loCredit: 0 });
      }
    });
  }

  // ── Read Port ────────────────────────────────────────────────────────────────
  document.getElementById('cbsReadPort').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-cbs');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/table/cbs/read-port', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), port: currentPort })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      if (!cache[currentPort]) cache[currentPort] = {};
      res.pcps.forEach(function(p) {
        cache[currentPort][p.pcp] = {
          idleSlope: 0,
          idleSlopeTick: p.idleSlopeTick,
          sendSlopeTick: p.sendSlopeTick,
          hiCredit: p.hiCredit,
          loCredit: p.loCredit
        };
      });
      document.querySelectorAll('#cbsPcpRows tr').forEach(function(tr) {
        const pcp  = Number(tr.dataset.pcp);
        const data = cache[currentPort][pcp];
        if (data) updateRowCalc(tr, data);
      });
      st.textContent = 'Port ' + currentPort + ' read'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Write All ────────────────────────────────────────────────────────────────
  document.getElementById('cbsWriteAll').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-cbs');
    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      for (let pcp = 0; pcp < 8; pcp++) {
        const data = cache[currentPort] && cache[currentPort][pcp];
        if (!data) continue;
        const res = await api('/api/table/cbs/write', {
          method: 'POST',
          body: JSON.stringify({
            session: getSession(), port: currentPort, pcp,
            idleSlopeTick: data.idleSlopeTick,
            sendSlopeTick: data.sendSlopeTick,
            loCredit: data.loCredit,
            hiCredit: data.hiCredit
          })
        });
        if (!res.ok) throw new Error('PCP ' + pcp + ': ' + (res.error || 'write failed'));
      }
      st.textContent = 'All PCPs written'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Port speed / MTU change → recalculate all rows ───────────────────────────
  ['cbsPortSpeed', 'cbsMtu'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', function() {
      document.querySelectorAll('#cbsPcpRows tr').forEach(function(tr) {
        const pcp  = Number(tr.dataset.pcp);
        const inp  = tr.querySelector('.cbs-idle-input');
        const calc = calcCbs(inp.value);
        updateRowCalc(tr, calc);
        if (!cache[currentPort]) cache[currentPort] = {};
        cache[currentPort][pcp] = {
          idleSlope: Number(inp.value),
          idleSlopeTick: calc.idleSlopeTick,
          sendSlopeTick: calc.sendSlopeTick,
          hiCredit: calc.hiCredit,
          loCredit: calc.loCredit
        };
      });
    });
  });

  initTable();
})();


// ── TGSW Switch Control Manager ──────────────────────────────────────────────
(function swCtrlManager() {
  // SWITCH_CONTROL_0 = BASE + 0x2C0, SWITCH_CONTROL_1 = BASE + 0x2C4
  const OFF_CTRL0 = 0x2C0;
  const OFF_CTRL1 = 0x2C4;

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  function getCheckedBits(cls) {
    let val = 0;
    document.querySelectorAll('.' + cls).forEach(function(chk) {
      if (chk.checked) val |= (1 << Number(chk.dataset.port));
    });
    return val >>> 0;
  }

  function setCheckedBits(cls, val) {
    document.querySelectorAll('.' + cls).forEach(function(chk) {
      chk.checked = !!(val & (1 << Number(chk.dataset.port)));
    });
  }

  // ── Read functions ───────────────────────────────────────────────────────────
  async function readSwCtrl() {
    const st = document.getElementById('rv-st-sw-ctrl');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const r0 = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_CTRL0 })
      });
      const r1 = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_CTRL1 })
      });
      if (!r0.ok) throw new Error(r0.error || 'CTRL_0 read failed');
      if (!r1.ok) throw new Error(r1.error || 'CTRL_1 read failed');

      const ctrl0 = r0.value >>> 0;
      const ctrl1 = r1.value >>> 0;

      setCheckedBits('sw-promisc', (ctrl0 >> 0)  & 0xFF);
      setCheckedBits('sw-tp',      (ctrl0 >> 8)  & 0x1FF);
      setCheckedBits('sw-cbs',     (ctrl0 >> 20) & 0x1FF);
      setCheckedBits('sw-tas',     (ctrl1 >> 0)  & 0x1FF);
      setCheckedBits('sw-ats',     (ctrl1 >> 16) & 0x1FF);

      st.textContent = 'CTRL_0=0x' + ctrl0.toString(16).toUpperCase().padStart(8,'0') +
                       '  CTRL_1=0x' + ctrl1.toString(16).toUpperCase().padStart(8,'0');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Write ───────────────────────────────────────────────────────────────────
  document.getElementById('swCtrlWrite').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-sw-ctrl');
    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      const promisc = getCheckedBits('sw-promisc') & 0xFF;
      const tp      = getCheckedBits('sw-tp')      & 0x1FF;
      const cbs     = getCheckedBits('sw-cbs')     & 0x1FF;
      const tas     = getCheckedBits('sw-tas')     & 0x1FF;
      const ats     = getCheckedBits('sw-ats')     & 0x1FF;

      const ctrl0 = (promisc << 0) | (tp << 8) | (cbs << 20);
      const ctrl1 = (tas << 0) | (ats << 16);

      const w0 = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_CTRL0, value: ctrl0 >>> 0 })
      });
      const w1 = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_CTRL1, value: ctrl1 >>> 0 })
      });
      if (!w0.ok) throw new Error(w0.error || 'CTRL_0 write failed');
      if (!w1.ok) throw new Error(w1.error || 'CTRL_1 write failed');

      st.textContent = 'Written — CTRL_0=0x' + (ctrl0>>>0).toString(16).toUpperCase().padStart(8,'0') +
                       '  CTRL_1=0x' + (ctrl1>>>0).toString(16).toUpperCase().padStart(8,'0');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── READ ALL ─────────────────────────────────────────────────────────────────
  document.getElementById('swReadAll').addEventListener('click', async function() {
    await readSwCtrl();
    await readTermCtrl();
    await readLenCtrl();
    await readMyMac();
  });
})();


// ── Terminal Control Manager ──────────────────────────────────────────────────
(function termCtrlManager() {
  const OFF_TERM = 0x2C8;
  const CLK_1G   = 125;      // MHz
  const CLK_10G  = 156.25;   // MHz

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  // ns → clocks (rounded)
  function nsToClk(ns, mhz) { return Math.round(Number(ns) * mhz / 1000); }
  // clocks → ns
  function clkToNs(clk, mhz) { return (Number(clk) * 1000 / mhz).toFixed(2); }

  // live update: ns 입력 → 클럭 수 자동계산
  document.getElementById('termIfs1gNs').addEventListener('input', function() {
    document.getElementById('termIfs1gClk').value = nsToClk(this.value, CLK_1G);
  });
  document.getElementById('termIfs10gNs').addEventListener('input', function() {
    document.getElementById('termIfs10gClk').value = nsToClk(this.value, CLK_10G);
  });

  async function readTermCtrl() {
    const st = document.getElementById('rv-st-term-ctrl');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_TERM })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      const val = res.value >>> 0;
      const clk1g  = (val >> 0) & 0x1F;
      const clk10g = (val >> 8) & 0x1F;
      document.getElementById('termIfs1gClk').value  = clk1g;
      document.getElementById('termIfs10gClk').value = clk10g;
      document.getElementById('termIfs1gNs').value   = clkToNs(clk1g,  CLK_1G);
      document.getElementById('termIfs10gNs').value  = clkToNs(clk10g, CLK_10G);
      st.textContent = '0x' + val.toString(16).toUpperCase().padStart(8, '0') +
                       '  (1G=' + clk1g + 'clk/' + clkToNs(clk1g, CLK_1G) + 'ns' +
                       ', 10G=' + clk10g + 'clk/' + clkToNs(clk10g, CLK_10G) + 'ns)';
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Write ───────────────────────────────────────────────────────────────────
  document.getElementById('termCtrlWrite').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-term-ctrl');
    const clk1g  = nsToClk(document.getElementById('termIfs1gNs').value,  CLK_1G)  & 0x1F;
    const clk10g = nsToClk(document.getElementById('termIfs10gNs').value, CLK_10G) & 0x1F;
    const val = (clk1g << 0) | (clk10g << 8);

    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_TERM, value: val >>> 0 })
      });
      if (!res.ok) throw new Error(res.error || 'write failed');
      document.getElementById('termIfs1gClk').value  = clk1g;
      document.getElementById('termIfs10gClk').value = clk10g;
      st.textContent = '0x' + (val>>>0).toString(16).toUpperCase().padStart(8,'0') +
                       '  (1G=' + clk1g + 'clk, 10G=' + clk10g + 'clk)';
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();


// ── Length Control Manager ────────────────────────────────────────────────────
(function lenCtrlManager() {
  const OFF_LEN = 0x2CC;

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  async function readLenCtrl() {
    const st = document.getElementById('rv-st-len-ctrl');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_LEN })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      const val = res.value >>> 0;
      const minLen = (val >> 0)  & 0x7FF;
      const maxLen = (val >> 16) & 0x7FF;
      document.getElementById('lenMin').value = minLen;
      document.getElementById('lenMax').value = maxLen;
      st.textContent = '0x' + val.toString(16).toUpperCase().padStart(8,'0') +
                       '  (MAX=' + maxLen + ', MIN=' + minLen + ')';
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Write ───────────────────────────────────────────────────────────────────
  document.getElementById('lenCtrlWrite').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-len-ctrl');
    const minLen = Number(document.getElementById('lenMin').value) & 0x7FF;
    const maxLen = Number(document.getElementById('lenMax').value) & 0x7FF;
    const val = (minLen << 0) | (maxLen << 16);
    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_LEN, value: val >>> 0 })
      });
      if (!res.ok) throw new Error(res.error || 'write failed');
      st.textContent = '0x' + (val>>>0).toString(16).toUpperCase().padStart(8,'0') +
                       '  (MAX=' + maxLen + ', MIN=' + minLen + ')';
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();


// ── My MAC Address Manager ────────────────────────────────────────────────────
(function myMacManager() {
  const OFF_MAC0 = 0x2D0;  // MY_MAC_ADDR_0: MAC [31:0]
  const OFF_MAC1 = 0x2D4;  // MY_MAC_ADDR_1: MAC [47:32]

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  // MAC string -> { mac0, mac1 }
  // "B4:2E:99:DE:74:16" -> mac1=0xB42E, mac0=0x99DE7416
  function parseMac(str) {
    const bytes = str.split(':').map(function(h) { return parseInt(h, 16); });
    if (bytes.length !== 6 || bytes.some(isNaN)) throw new Error('올바른 MAC 형식이 아닙니다 (XX:XX:XX:XX:XX:XX)');
    const mac1 = ((bytes[0] << 8) | bytes[1]) & 0xFFFF;
    const mac0 = ((bytes[2] << 24) | (bytes[3] << 16) | (bytes[4] << 8) | bytes[5]) >>> 0;
    return { mac0, mac1 };
  }

  // { mac0, mac1 } -> MAC string
  function formatMac(mac0, mac1) {
    const b = [
      (mac1 >> 8) & 0xFF, mac1 & 0xFF,
      (mac0 >> 24) & 0xFF, (mac0 >> 16) & 0xFF,
      (mac0 >> 8)  & 0xFF,  mac0 & 0xFF
    ];
    return b.map(function(x) { return x.toString(16).toUpperCase().padStart(2,'0'); }).join(':');
  }

  async function readMyMac() {
    const st = document.getElementById('rv-st-my-mac');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const r0 = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_MAC0 })
      });
      const r1 = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_MAC1 })
      });
      if (!r0.ok) throw new Error(r0.error || 'MAC_0 read failed');
      if (!r1.ok) throw new Error(r1.error || 'MAC_1 read failed');
      const mac0 = r0.value >>> 0;
      const mac1 = r1.value & 0xFFFF;
      const macStr = formatMac(mac0, mac1);
      document.getElementById('myMacInput').value = macStr;
      st.textContent = macStr; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Write ───────────────────────────────────────────────────────────────────
  document.getElementById('myMacWrite').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-my-mac');
    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      const { mac0, mac1 } = parseMac(document.getElementById('myMacInput').value);
      const w0 = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_MAC0, value: mac0 })
      });
      const w1 = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF_MAC1, value: mac1 })
      });
      if (!w0.ok) throw new Error(w0.error || 'MAC_0 write failed');
      if (!w1.ok) throw new Error(w1.error || 'MAC_1 write failed');
      st.textContent = formatMac(mac0, mac1) + ' written'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();



// ── PORT RX Frame Info Manager ────────────────────────────────────────────────
(function rxFrameManager() {
  const SW_REGION = 0x2C0;
  const RX_BASE   = SW_REGION + 0x040;
  const PORT_STEP = 0x040;
  const NUM_PORTS = 8;

  let pollTimer = null;

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  function rxOffset(port) { return RX_BASE + port * PORT_STEP; }

  function parseRxVal(val) {
    val = val >>> 0;
    const length    = (val >> 0)  & 0x7FF;
    const queueFull = (val >> 11) & 0x1;
    const fcsError  = (val >> 12) & 0x1;
    const memFail   = (val >> 13) & 0x1;
    const poResult  = (val >> 14) & 0x3;
    const vid       = (val >> 16) & 0xFFF;
    const pcp       = (val >> 28) & 0xF;
    return { length, queueFull, fcsError, memFail, poResult, vid, pcp };
  }

  function policerHtml(po) {
    if (po === 0x0) return '<span class="rx-policer-green">Green</span>';
    if (po === 0x1) return '<span class="rx-policer-yellow">Yellow</span>';
    if (po === 0x3) return '<span class="rx-policer-red">Red</span>';
    return '—';
  }

  function flagHtml(v) {
    return v ? '<span class="rx-flag-dot active" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--red);"></span>'
             : '<span style="color:var(--muted);">—</span>';
  }

  function pcpText(pcp) { return pcp === 8 ? 'Untag' : 'PCP ' + pcp; }

  // ── Read all ports ────────────────────────────────────────────────────────────
  async function doReadAll() {
    const st   = document.getElementById('rv-st-rx-frame');
    const tbody = document.getElementById('rxTableBody');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const rows = [];
      for (let p = 0; p < NUM_PORTS; p++) {
        const res = await api('/api/register/read', {
          method: 'POST',
          body: JSON.stringify({ session: getSession(), offset: rxOffset(p) })
        });
        if (!res.ok) throw new Error('P' + p + ': ' + (res.error || 'read failed'));
        const d = parseRxVal(res.value);
        rows.push(
          '<tr>' +
          '<td><b>P' + p + '</b></td>' +
          '<td>' + d.length + '</td>' +
          '<td>' + d.vid + '</td>' +
          '<td>' + pcpText(d.pcp) + '</td>' +
          '<td>' + policerHtml(d.poResult) + '</td>' +
          '<td style="text-align:center;">' + flagHtml(d.queueFull) + '</td>' +
          '<td style="text-align:center;">' + flagHtml(d.fcsError)  + '</td>' +
          '<td style="text-align:center;">' + flagHtml(d.memFail)   + '</td>' +
          '</tr>'
        );
      }
      tbody.innerHTML = rows.join('');
      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  document.getElementById('rxRead').addEventListener('click', doReadAll);

  // ── Auto Poll ────────────────────────────────────────────────────────────────
  function startPoll() {
    const ms = Number(document.getElementById('rxPollInterval').value) || 500;
    pollTimer = setInterval(doReadAll, ms);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  document.getElementById('rxAutoPoll').addEventListener('change', function() {
    if (this.checked) startPoll(); else stopPoll();
  });
  document.getElementById('rxPollInterval').addEventListener('change', function() {
    if (document.getElementById('rxAutoPoll').checked) { stopPoll(); startPoll(); }
  });
})();


// ── PORT RX Counters Manager ──────────────────────────────────────────────────
(function rxCntManager() {
  const SW_REGION = 0x2C0;
  const RX_BASE   = SW_REGION + 0x040;
  const PORT_STEP = 0x040;
  const NUM_PORTS = 8;

  const COUNTERS = [
    { name: 'CNT_RX_TRY',      offset: 0x004, desc: 'Total Received'   },
    { name: 'CNT_RX_FCS_ERR',  offset: 0x008, desc: 'FCS Error'        },
    { name: 'CNT_RX_LEN_FAIL', offset: 0x00C, desc: 'Length Fail'      },
    { name: 'CNT_RX_PO_DROP',  offset: 0x010, desc: 'Policer Drop'     },
    { name: 'CNT_RX_QUE_FULL', offset: 0x014, desc: 'Queue Full Drop'  },
    { name: 'CNT_RX_MEM_FULL', offset: 0x018, desc: 'Memory Full Drop' },
    { name: 'CNT_RX_LK_DROP',  offset: 0x01C, desc: 'Lookup Drop'      },
    { name: 'CNT_RX_LK_BLK',   offset: 0x020, desc: 'Lookup Block'     },
    { name: 'CNT_RX_SUCC',     offset: 0x024, desc: 'Success'          },
  ];

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  function portBase(port) { return RX_BASE + port * PORT_STEP; }

  document.getElementById('rxCntReadAll').addEventListener('click', async function() {
    const st    = document.getElementById('rv-st-rx-cnt');
    const tbody = document.getElementById('rxCntBody');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      // Read all: counters × ports
      // Build 2D array: values[counterIdx][portIdx]
      const values = COUNTERS.map(function() { return new Array(NUM_PORTS).fill(0); });

      for (let p = 0; p < NUM_PORTS; p++) {
        for (let c = 0; c < COUNTERS.length; c++) {
          const res = await api('/api/register/read', {
            method: 'POST',
            body: JSON.stringify({ session: getSession(), offset: portBase(p) + COUNTERS[c].offset })
          });
          if (!res.ok) throw new Error('P' + p + ' ' + COUNTERS[c].name + ': ' + (res.error || 'failed'));
          values[c][p] = res.value >>> 0;
        }
      }

      // Render rows
      tbody.innerHTML = COUNTERS.map(function(cnt, ci) {
        const cells = values[ci].map(function(v, pi) {
          const color = (cnt.name !== 'CNT_RX_TRY' && cnt.name !== 'CNT_RX_SUCC' && v > 0)
            ? 'color:var(--red);font-weight:700;'
            : '';
          return '<td style="text-align:right;' + color + '">' + v.toLocaleString() + '</td>';
        }).join('');
        return '<tr>' +
          '<td><span style="font-size:11px;">' + cnt.desc + '</span><br><small style="color:var(--muted);">' + cnt.name + '</small></td>' +
          '<td style="color:var(--muted);font-size:10px;">+0x' + cnt.offset.toString(16).toUpperCase().padStart(3,'0') + '</td>' +
          cells + '</tr>';
      }).join('');

      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();


// ── TGSW FABRIC Manager ───────────────────────────────────────────────────────
(function fabricManager() {
  const FBR_BASE = 0x540;  // TGSW_FBR_REGION = TGSW_SW_REGION(0x2C0) + 0x280

  const OFF = {
    SMEM_CTRL:     FBR_BASE + 0x000,
    AREA_MAP_0:    FBR_BASE + 0x004,  // AREA #0~31
    AREA_MAP_1:    FBR_BASE + 0x008,  // AREA #32~63
    AREA_MAP_2:    FBR_BASE + 0x00C,  // AREA #64~95
    AREA_MAP_3:    FBR_BASE + 0x010,  // AREA #96~127
    CNT_TRY:       FBR_BASE + 0x040,
    CNT_FULL:      FBR_BASE + 0x044,
    CNT_AGE_CLR:   FBR_BASE + 0x048,
  };

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  // ── Init AREA grid (128 cells) ───────────────────────────────────────────────
  function initAreaGrid() {
    const grid = document.getElementById('smemAreaGrid');
    grid.innerHTML = '';
    for (let i = 0; i < 128; i++) {
      const cell = document.createElement('div');
      cell.className = 'smem-area-cell smem-area-empty';
      cell.id = 'smem-area-' + i;
      cell.title = 'AREA #' + i + ': Empty';
      grid.appendChild(cell);
    }
  }

  // ── Update AREA grid from 4 map registers ────────────────────────────────────
  function updateAreaGrid(maps) {
    let dirtyCount = 0;
    for (let reg = 0; reg < 4; reg++) {
      const val = maps[reg] >>> 0;
      for (let bit = 0; bit < 32; bit++) {
        const areaIdx = reg * 32 + bit;
        const isDirty = !!(val & (1 << bit));
        const cell = document.getElementById('smem-area-' + areaIdx);
        if (!cell) continue;
        if (isDirty) {
          cell.className = 'smem-area-cell smem-area-dirty';
          cell.title = 'AREA #' + areaIdx + ': Dirty (in use)';
          dirtyCount++;
        } else {
          cell.className = 'smem-area-cell smem-area-empty';
          cell.title = 'AREA #' + areaIdx + ': Empty';
        }
      }
    }
    const pct = ((dirtyCount / 128) * 100).toFixed(1);
    document.getElementById('smemMapStat').textContent =
      'Dirty: ' + dirtyCount + ' / 128  (' + pct + '% 사용 중)';
    document.getElementById('smemMapStat').style.color =
      dirtyCount > 100 ? 'var(--red)' : dirtyCount > 64 ? '#F59E0B' : 'var(--green)';
  }

  // ── Read SMEM CONTROL ────────────────────────────────────────────────────────
  async function readSmemCtrl() {
    const st = document.getElementById('rv-st-smem-ctrl');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/register/read', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF.SMEM_CTRL })
      });
      if (!res.ok) throw new Error(res.error || 'read failed');
      const val = res.value >>> 0;
      document.getElementById('smemAgeLimit').value  = (val >> 0) & 0xFF;
      document.getElementById('smemAgeEnable').checked = !!((val >> 8) & 0x1);
      st.textContent = '0x' + val.toString(16).toUpperCase().padStart(8,'0');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Read AREA MAP ────────────────────────────────────────────────────────────
  async function readAreaMap() {
    const st = document.getElementById('rv-st-smem-map');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const maps = [];
      for (const off of [OFF.AREA_MAP_0, OFF.AREA_MAP_1, OFF.AREA_MAP_2, OFF.AREA_MAP_3]) {
        const res = await api('/api/register/read', {
          method: 'POST',
          body: JSON.stringify({ session: getSession(), offset: off })
        });
        if (!res.ok) throw new Error(res.error || 'read failed');
        maps.push(res.value >>> 0);
      }
      updateAreaGrid(maps);
      st.textContent = maps.map(function(v) { return '0x' + v.toString(16).toUpperCase().padStart(8,'0'); }).join('  ');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Read COUNTERS ────────────────────────────────────────────────────────────
  async function readCounters() {
    const st = document.getElementById('rv-st-smem-cnt');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const tryRes  = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ session: getSession(), offset: OFF.CNT_TRY     }) });
      const fullRes = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ session: getSession(), offset: OFF.CNT_FULL    }) });
      const ageRes  = await api('/api/register/read', { method: 'POST', body: JSON.stringify({ session: getSession(), offset: OFF.CNT_AGE_CLR }) });
      if (!tryRes.ok)  throw new Error(tryRes.error  || 'CNT_TRY read failed');
      if (!fullRes.ok) throw new Error(fullRes.error || 'CNT_FULL read failed');
      if (!ageRes.ok)  throw new Error(ageRes.error  || 'CNT_AGE_CLR read failed');

      const tryVal  = tryRes.value  >>> 0;
      const fullVal = fullRes.value >>> 0;
      const ageVal  = ageRes.value  >>> 0;

      const tryEl  = document.getElementById('smemCntTry');
      const fullEl = document.getElementById('smemCntFull');
      const ageEl  = document.getElementById('smemCntAge');

      tryEl.textContent  = tryVal.toLocaleString();
      tryEl.style.color  = 'var(--fg)';

      fullEl.textContent = fullVal.toLocaleString();
      fullEl.style.color = fullVal > 0 ? 'var(--red)' : 'var(--fg)';

      ageEl.textContent  = ageVal.toLocaleString();
      ageEl.style.color  = 'var(--fg)';

      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── Apply SMEM CONTROL ───────────────────────────────────────────────────────
  document.getElementById('smemCtrlApply').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-smem-ctrl');
    const ageLimit  = Number(document.getElementById('smemAgeLimit').value)  & 0xFF;
    const ageEnable = document.getElementById('smemAgeEnable').checked ? 1 : 0;
    const val = (ageLimit << 0) | (ageEnable << 8);
    st.textContent = 'Writing...'; st.style.color = 'var(--muted)';
    try {
      const res = await api('/api/register/write', {
        method: 'POST',
        body: JSON.stringify({ session: getSession(), offset: OFF.SMEM_CTRL, value: val >>> 0 })
      });
      if (!res.ok) throw new Error(res.error || 'write failed');
      st.textContent = '0x' + (val>>>0).toString(16).toUpperCase().padStart(8,'0') + ' written';
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── READ ALL ─────────────────────────────────────────────────────────────────
  document.getElementById('fabricReadAll').addEventListener('click', async function() {
    await readSmemCtrl();
    await readAreaMap();
    await readCounters();
    if (window._fabricReadWrRd) await window._fabricReadWrRd();
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  initAreaGrid();
})();



// ── TGSW FABRIC WR / RD Port Counters ────────────────────────────────────────
(function fabricWrManager() {
  const FBR_BASE = 0x540;
  const WR_BASE  = FBR_BASE + 0x080;  // CNT_WR_PORT_0 ~ 8
  const RD_BASE  = FBR_BASE + 0x0C0;  // CNT_RD_PORT_0 ~ 8

  const PORTS = [
    { label: 'P0',  offset: 0x00 },
    { label: 'P1',  offset: 0x04 },
    { label: 'P2',  offset: 0x08 },
    { label: 'P3',  offset: 0x0C },
    { label: 'P4',  offset: 0x10 },
    { label: 'P5',  offset: 0x14 },
    { label: 'P6',  offset: 0x18 },
    { label: 'P7',  offset: 0x1C },
    { label: 'CPU', offset: 0x20 },
  ];

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  async function readReg(offset) {
    const res = await api('/api/register/read', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: offset })
    });
    if (!res.ok) throw new Error('0x' + offset.toString(16) + ': ' + (res.error || 'failed'));
    return res.value >>> 0;
  }

  function bar(pct, color) {
    return '<div style="flex:1;background:var(--surfAlt);border-radius:3px;height:14px;overflow:hidden;">' +
      '<div style="width:' + pct.toFixed(1) + '%;height:100%;background:' + color + ';border-radius:3px;transition:width .3s;"></div>' +
      '</div>';
  }

  async function readWrRd() {
    const st   = document.getElementById('rv-st-fabric-wr');
    const body = document.getElementById('fabricWrBody');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const wrVals = [], rdVals = [];
      for (const p of PORTS) {
        wrVals.push(await readReg(WR_BASE + p.offset));
        rdVals.push(await readReg(RD_BASE + p.offset));
      }

      const maxWr = Math.max(...wrVals, 1);
      const maxRd = Math.max(...rdVals, 1);

      body.innerHTML = PORTS.map(function(p, i) {
        const wrPct = wrVals[i] / maxWr * 100;
        const rdPct = rdVals[i] / maxRd * 100;
        return '<div style="display:flex;align-items:center;gap:8px;">' +
          '<span style="font-size:11px;font-weight:600;width:32px;flex-shrink:0;">' + p.label + '</span>' +
          '<div style="flex:1;display:flex;flex-direction:column;gap:2px;">' +
            bar(wrPct, 'var(--accent)') +
            bar(rdPct, '#44CC77') +
          '</div>' +
          '<div style="width:180px;flex-shrink:0;font-size:10px;font-family:var(--mono);display:flex;gap:8px;">' +
            '<span style="color:var(--accent);width:85px;text-align:right;">W: ' + wrVals[i].toLocaleString() + '</span>' +
            '<span style="color:#44CC77;width:85px;text-align:right;">R: ' + rdVals[i].toLocaleString() + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  window._fabricReadWrRd = readWrRd;
})();



// ── PORT TX Counters Manager ──────────────────────────────────────────────────
(function txCntManager() {
  const SW_REGION = 0x2C0;
  const TX_BASE   = SW_REGION + 0x400;
  const PORT_STEP = 0x040;

  const COUNTERS = [
    { label: 'TRY',      offset: 0x000 },
    { label: 'PCP 0',    offset: 0x004 },
    { label: 'PCP 1',    offset: 0x008 },
    { label: 'PCP 2',    offset: 0x00C },
    { label: 'PCP 3',    offset: 0x010 },
    { label: 'PCP 4',    offset: 0x014 },
    { label: 'PCP 5',    offset: 0x018 },
    { label: 'PCP 6',    offset: 0x01C },
    { label: 'PCP 7',    offset: 0x020 },
    { label: 'Untagged', offset: 0x024 },
  ];

  const PORT_LABELS = ['P0','P1','P2','P3','P4','P5','P6','P7','CPU'];

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  function portBase(port) { return TX_BASE + port * PORT_STEP; }

  function renderPortCard(label, values) {
    const tryVal = values[0];
    const pcpVals = values.slice(1);
    const maxPcp = Math.max(...pcpVals, 1);

    const bars = pcpVals.map(function(v, i) {
      const pct    = (v / maxPcp * 100).toFixed(1);
      const pctTry = tryVal > 0 ? (v / tryVal * 100).toFixed(0) : '0';
      const lbl    = COUNTERS[i + 1].label;
      return '<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;">' +
        '<span style="font-size:9px;width:46px;flex-shrink:0;color:var(--muted);">' + lbl + '</span>' +
        '<div style="flex:1;background:var(--surf);border-radius:2px;height:10px;overflow:hidden;">' +
          '<div style="width:' + pct + '%;height:100%;background:var(--accent);opacity:.75;border-radius:2px;"></div>' +
        '</div>' +
        '<span class="mono" style="font-size:9px;width:54px;text-align:right;flex-shrink:0;">' + v.toLocaleString() + '</span>' +
        '<span style="font-size:9px;width:26px;text-align:right;flex-shrink:0;color:var(--muted);">' + pctTry + '%</span>' +
      '</div>';
    }).join('');

    return '<div style="background:var(--surfAlt);border:1px solid var(--border);border-radius:6px;padding:8px 10px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">' +
        '<span style="font-size:12px;font-weight:700;">' + label + '</span>' +
        '<span class="mono" style="font-size:11px;color:var(--accent);">' + tryVal.toLocaleString() + '</span>' +
      '</div>' +
      bars +
    '</div>';
  }

  document.getElementById('txCntRead').addEventListener('click', async function() {
    const st   = document.getElementById('rv-st-tx-cnt');
    const body = document.getElementById('txCntBody');
    st.textContent = 'Reading all ports...'; st.style.color = 'var(--muted)';
    try {
      const portCards = [];
      for (let p = 0; p < 9; p++) {
        const values = [];
        for (const cnt of COUNTERS) {
          const res = await api('/api/register/read', {
            method: 'POST',
            body: JSON.stringify({ session: getSession(), offset: portBase(p) + cnt.offset })
          });
          if (!res.ok) throw new Error(PORT_LABELS[p] + ' ' + cnt.label + ': ' + (res.error || 'failed'));
          values.push(res.value >>> 0);
        }
        portCards.push(renderPortCard(PORT_LABELS[p], values));
      }
      body.innerHTML = portCards.join('');
      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();


// ── TAS Control Manager ───────────────────────────────────────────────────────
(function tasManager() {
  const SW_REGION = 0x2C0;
  const TX_BASE   = SW_REGION + 0x400;
  const PORT_STEP = 0x040;
  const NUM_PORTS = 9;

  const OFF = {
    START:    0x030,
    BASE_US:  0x034,
    BASE_SEC: 0x038,
    LIST_LEN: 0x03C,
  };

  let currentPort = 0;

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  function portBase(port) { return TX_BASE + port * PORT_STEP; }

  async function regRead(offset) {
    const res = await api('/api/register/read', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset })
    });
    if (!res.ok) throw new Error('0x' + offset.toString(16) + ': ' + (res.error || 'failed'));
    return res.value >>> 0;
  }

  async function regWrite(offset, value) {
    const res = await api('/api/register/write', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset, value: value >>> 0 })
    });
    if (!res.ok) throw new Error('0x' + offset.toString(16) + ': ' + (res.error || 'failed'));
  }

  // ── BASE TIME hint ────────────────────────────────────────────────────────────
  function updateHint() {
    const sec = Number(document.getElementById('tasBaseSec').value) || 0;
    const us  = Number(document.getElementById('tasBaseUs').value)  || 0;
    const ms  = sec * 1000 + Math.floor(us / 1000);
    const dt  = new Date(ms);
    document.getElementById('tasBaseTimeHint').textContent =
      isNaN(dt.getTime()) ? '—' : dt.toLocaleString('ko-KR') + '.' + String(us % 1000).padStart(3,'0') + ' ms';
  }

  document.getElementById('tasBaseSec').addEventListener('input', updateHint);
  document.getElementById('tasBaseUs').addEventListener('input',  updateHint);

  // ── Now +5s button ────────────────────────────────────────────────────────────
  document.getElementById('tasFillNow').addEventListener('click', function() {
    const now = Date.now() + 5000;  // 5초 여유
    const sec = Math.floor(now / 1000);
    const us  = (now % 1000) * 1000;
    document.getElementById('tasBaseSec').value = sec;
    document.getElementById('tasBaseUs').value  = us;
    updateHint();
  });

  // ── Port buttons ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.tas-port-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tas-port-btn').forEach(function(b) { b.classList.remove('tas-port-active'); });
      btn.classList.add('tas-port-active');
      currentPort = Number(btn.dataset.port);
    });
  });

  // ── Read (현재 선택 포트) ──────────────────────────────────────────────────────
  document.getElementById('tasRead').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-tas');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const base   = portBase(currentPort);
      const start  = await regRead(base + OFF.START);
      const baseUs = await regRead(base + OFF.BASE_US);
      const baseSec= await regRead(base + OFF.BASE_SEC);
      const listLen= await regRead(base + OFF.LIST_LEN);

      document.getElementById('tasListLen').value  = listLen & 0x3F;
      document.getElementById('tasBaseSec').value  = baseSec;
      document.getElementById('tasBaseUs').value   = baseUs & 0xFFFFF;
      updateHint();
      updateToggleBtn(start & 0x1);

      st.textContent = 'P' + currentPort + '  START=' + (start & 1) + '  LEN=' + (listLen & 0x3F);
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Apply (현재 선택 포트에 설정값 write) ─────────────────────────────────────
  document.getElementById('tasApply').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-tas');
    st.textContent = 'Applying...'; st.style.color = 'var(--muted)';
    try {
      const base    = portBase(currentPort);
      const listLen = Number(document.getElementById('tasListLen').value) & 0x3F;
      const baseSec = Number(document.getElementById('tasBaseSec').value) >>> 0;
      const baseUs  = Number(document.getElementById('tasBaseUs').value)  & 0xFFFFF;

      await regWrite(base + OFF.LIST_LEN, listLen);
      await regWrite(base + OFF.BASE_US,  baseUs);
      await regWrite(base + OFF.BASE_SEC, baseSec);

      st.textContent = 'P' + currentPort + ' applied'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── Toggle Start / Stop ALL ports ─────────────────────────────────────────────
  function updateToggleBtn(isRunning) {
    const btn = document.getElementById('tasToggle');
    if (isRunning) {
      btn.textContent = '■ Stop All';
      btn.classList.add('tas-running');
      btn.classList.remove('primary');
    } else {
      btn.textContent = '▶ Start All';
      btn.classList.remove('tas-running');
      btn.classList.remove('primary');
    }
  }

  document.getElementById('tasToggle').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-tas');
    const btn = document.getElementById('tasToggle');
    // 현재 상태 읽기 (P0 기준)
    st.textContent = 'Reading state...'; st.style.color = 'var(--muted)';
    try {
      const cur = await regRead(portBase(0) + OFF.START);
      const newVal = (cur & 0x1) ? 0 : 1;
      const action = newVal ? 'Starting' : 'Stopping';
      st.textContent = action + ' all ports...'; st.style.color = 'var(--muted)';

      for (let p = 0; p < NUM_PORTS; p++) {
        await regWrite(portBase(p) + OFF.START, newVal);
      }

      updateToggleBtn(newVal);
      st.textContent = (newVal ? '▶ Started' : '■ Stopped') + ' all ports';
      st.style.color = newVal ? 'var(--green)' : 'var(--muted)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // init
  updateHint();
})();



// ── NIC Manager ───────────────────────────────────────────────────────────────
(function nicManager() {
  const NIC_BASE = 0xAC0;

  const OFF = {
    VERSION: 0x000,
    ENABLE:  0x004,
    CTRL:    0x010,
    RAW:     0x014,
    MASK:    0x018,
    SW:      0x01C,
  };

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  async function regRead(offset) {
    const res = await api('/api/register/read', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: NIC_BASE + offset })
    });
    if (!res.ok) throw new Error('+0x' + offset.toString(16) + ': ' + (res.error || 'failed'));
    return res.value >>> 0;
  }

  async function regWrite(offset, value) {
    const res = await api('/api/register/write', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: NIC_BASE + offset, value: value >>> 0 })
    });
    if (!res.ok) throw new Error('+0x' + offset.toString(16) + ': ' + (res.error || 'failed'));
  }

  // ── VERSION ──────────────────────────────────────────────────────────────────
  async function readVersion() {
    const st = document.getElementById('rv-st-nic-ver');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const val   = await regRead(OFF.VERSION);
      const minor = (val >> 0)  & 0xF;
      const day   = (val >> 4)  & 0xFF;
      const month = (val >> 12) & 0xF;
      const year  = (val >> 16) & 0xFF;
      const major = (val >> 24) & 0xFF;
      const monthStr = month <= 9 ? String(month) : month === 0xA ? '10' : month === 0xB ? '11' : '12';
      document.getElementById('nicVerMajor').textContent = '0x' + major.toString(16).toUpperCase().padStart(2,'0');
      document.getElementById('nicVerDate').textContent  = '20' + year.toString(16).padStart(2,'0') + '년 ' + monthStr + '월 ' + day.toString(16).padStart(2,'0') + '일';
      document.getElementById('nicVerMinor').textContent = minor + 'st Edition';
      document.getElementById('nicVerRaw').textContent   = '0x' + val.toString(16).toUpperCase().padStart(8,'0');
      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  // ── ENABLE ───────────────────────────────────────────────────────────────────
  async function readEnable() {
    const st = document.getElementById('rv-st-nic-en');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const val = await regRead(OFF.ENABLE);
      document.getElementById('nicEnable').checked  = !!(val & 0x1);
      document.getElementById('nicTsAdded').checked = !!(val & 0x2);
      st.textContent = '0x' + val.toString(16).toUpperCase().padStart(8,'0');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  document.getElementById('nicEnableApply').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-en');
    st.textContent = 'Applying...'; st.style.color = 'var(--muted)';
    try {
      const val = (document.getElementById('nicEnable').checked  ? 0x1 : 0) |
                  (document.getElementById('nicTsAdded').checked ? 0x2 : 0);
      await regWrite(OFF.ENABLE, val);
      st.textContent = 'Applied'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── INTERRUPT POLARITY ───────────────────────────────────────────────────────
  async function readCtrl() {
    try {
      const val = await regRead(OFF.CTRL);
      document.getElementById('nicIntrLow').checked  = !!(val & 0x1);
      document.getElementById('nicIntrHigh').checked = !(val & 0x1);
    } catch(e) {}
  }

  document.getElementById('nicIntrApply').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-intr');
    st.textContent = 'Applying...'; st.style.color = 'var(--muted)';
    try {
      const pol = document.getElementById('nicIntrLow').checked ? 1 : 0;
      await regWrite(OFF.CTRL, pol);
      st.textContent = 'Applied — ' + (pol ? 'Active Low' : 'Active High');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── RAW INTERRUPT ─────────────────────────────────────────────────────────────
  function updateRawDots(val) {
    const bits = {
      nicRawTx0: 0, nicRawTx1: 1, nicRawTx2: 2, nicRawTx3: 3,
      nicRawRx8: 8, nicRawRx9: 9, nicRawSw: 31
    };
    Object.entries(bits).forEach(function(entry) {
      const el = document.getElementById(entry[0]);
      if (!el) return;
      if (val & (1 << entry[1])) el.classList.add('active');
      else el.classList.remove('active');
    });
  }

  async function readRaw() {
    const st = document.getElementById('rv-st-nic-raw');
    try {
      const val = await regRead(OFF.RAW);
      updateRawDots(val);
      st.textContent = '0x' + val.toString(16).toUpperCase().padStart(8,'0');
      st.style.color = val ? 'var(--green)' : 'var(--muted)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  document.getElementById('nicIntrPoll').addEventListener('click', readRaw);

  document.getElementById('nicIntrClearAll').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-raw');
    st.textContent = 'Clearing...'; st.style.color = 'var(--muted)';
    try {
      await regWrite(OFF.RAW, (0xF) | (0x3 << 8) | (1 << 31));
      await readRaw();
      st.textContent = 'Cleared'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── INTERRUPT MASK ────────────────────────────────────────────────────────────
  async function readMask() {
    const st = document.getElementById('rv-st-nic-mask');
    try {
      const val = await regRead(OFF.MASK);
      document.querySelectorAll('.nic-mask').forEach(function(chk) {
        chk.checked = !!(val & (1 << Number(chk.dataset.bit)));
      });
      st.textContent = '0x' + val.toString(16).toUpperCase().padStart(8,'0');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  document.getElementById('nicIntrMaskApply').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-mask');
    st.textContent = 'Applying...'; st.style.color = 'var(--muted)';
    try {
      let mask = 0;
      document.querySelectorAll('.nic-mask').forEach(function(chk) {
        if (chk.checked) mask |= (1 << Number(chk.dataset.bit));
      });
      await regWrite(OFF.MASK, mask);
      st.textContent = 'Applied  0x' + mask.toString(16).toUpperCase().padStart(8,'0');
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── SW TRIGGER ────────────────────────────────────────────────────────────────
  document.getElementById('nicSwTrigger').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-sw');
    st.textContent = 'Triggering...'; st.style.color = 'var(--muted)';
    try {
      await regWrite(OFF.SW, 0x1);
      st.textContent = 'SW Trigger sent'; st.style.color = 'var(--green)';
      setTimeout(readRaw, 100);
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });

  // ── READ ALL ─────────────────────────────────────────────────────────────────
  document.getElementById('nicReadAll').addEventListener('click', async function() {
    await readVersion();
    await readEnable();
    await readCtrl();
    await readMask();
    await readRaw();
  });
})();



// ── NIC TX Manager ────────────────────────────────────────────────────────────
(function nicTxManager() {
  const NIC_BASE  = 0xAC0;
  const TX_MEM    = 0x1000;  // TX FIFO 메모리 (BASE + 0x1000)
  const TX_MAX    = 2048;

  const OFF = {
    TX_READY:   0x040,
    TX_AVAIL:   0x044,
    TX_TRY:     0x050,
    TX_PKT_ERR: 0x054,
    TX_MAX_ERR: 0x058,
    TX_MIN_ERR: 0x05C,
    TX_SUCC:    0x060,
  };

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  async function regRead(offset) {
    const res = await api('/api/register/read', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: NIC_BASE + offset })
    });
    if (!res.ok) throw new Error(res.error || 'read failed');
    return res.value >>> 0;
  }

  async function regWrite(offset, value) {
    const res = await api('/api/register/write', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: NIC_BASE + offset, value: value >>> 0 })
    });
    if (!res.ok) throw new Error(res.error || 'write failed');
  }

  async function memWrite(relOffset, value) {
    const res = await api('/api/register/write', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: TX_MEM + relOffset, value: value >>> 0 })
    });
    if (!res.ok) throw new Error(res.error || 'mem write failed');
  }

  function setCounter(id, val, isErr) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val.toLocaleString();
    el.style.color = (isErr && val > 0) ? 'var(--red)' : '';
  }

  // ── 프레임 길이 실시간 표시 ───────────────────────────────────────────────────
  document.getElementById('nicTxFrameData').addEventListener('input', function() {
    const bytes = this.value.trim().split(/\s+/).filter(function(h) { return h.length > 0; });
    const lenEl = document.getElementById('nicTxFrameLen');
    if (lenEl) lenEl.textContent = bytes.length + ' bytes';
  });

  // ── Read (AVAIL + 카운터) ─────────────────────────────────────────────────────
  async function readAll() {
    const st = document.getElementById('rv-st-nic-tx');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      const avail = (await regRead(OFF.TX_AVAIL)) & 0xFFF;
      const pct   = (avail / TX_MAX * 100).toFixed(1);
      document.getElementById('nicTxAvailVal').textContent = avail + ' / ' + TX_MAX + ' bytes  (' + pct + '%)';
      const bar = document.getElementById('nicTxAvailBar');
      bar.style.width = pct + '%';
      bar.style.background = avail < 256 ? 'var(--red)' : avail < 512 ? '#F59E0B' : 'var(--green)';

      const tryVal  = await regRead(OFF.TX_TRY);
      const pktErr  = await regRead(OFF.TX_PKT_ERR);
      const maxErr  = await regRead(OFF.TX_MAX_ERR);
      const minErr  = await regRead(OFF.TX_MIN_ERR);
      const succVal = await regRead(OFF.TX_SUCC);

      setCounter('nicTxTry',    tryVal,  false);
      setCounter('nicTxSucc',   succVal, false);
      setCounter('nicTxPktErr', pktErr,  true);
      setCounter('nicTxMaxErr', maxErr,  true);
      setCounter('nicTxMinErr', minErr,  true);

      const sumEl = document.getElementById('nicTxSummary');
      if (sumEl) {
        const succPct  = tryVal > 0 ? (succVal / tryVal * 100).toFixed(1) : '—';
        const errTotal = pktErr + maxErr + minErr;
        sumEl.textContent = 'TRY ' + tryVal.toLocaleString() +
          '  →  SUCCESS ' + succVal.toLocaleString() + ' (' + succPct + '%)' +
          (errTotal > 0 ? '  |  에러: PKT ' + pktErr + '  MAX ' + maxErr + '  MIN ' + minErr : '  |  에러 없음');
        sumEl.style.color = errTotal > 0 ? 'var(--red)' : 'var(--green)';
      }
      st.textContent = 'OK'; st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  document.getElementById('nicTxAvailRead').addEventListener('click', readAll);

  // ── Send ──────────────────────────────────────────────────────────────────────
  document.getElementById('nicTxSend').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-tx');
    const hexStr = document.getElementById('nicTxFrameData').value.trim();
    const hexArr = hexStr.split(/\s+/).filter(function(h) { return h.length > 0; });

    if (hexArr.length === 0) { st.textContent = '프레임 데이터를 입력하세요'; st.style.color = 'var(--muted)'; return; }

    // byte 배열로 변환
    const bytes = hexArr.map(function(h) { return parseInt(h, 16); });
    if (bytes.some(isNaN)) { st.textContent = '올바른 Hex 값을 입력하세요 (예: FF 00 11 ...)'; st.style.color = 'var(--red)'; return; }

    const byteLen = bytes.length;

    st.textContent = 'Checking AVAIL...'; st.style.color = 'var(--muted)';
    try {
      // 1. AVAIL 확인 (헤더 1워드 + 데이터 워드 포함)
      const wordsNeeded = 1 + Math.ceil(byteLen / 4);  // header + data
      const avail = (await regRead(OFF.TX_AVAIL)) & 0xFFF;
      if (avail < wordsNeeded * 4) {
        st.textContent = 'TX 메모리 부족: ' + avail + 'bytes 남음, ' + (wordsNeeded * 4) + 'bytes 필요';
        st.style.color = 'var(--red)'; return;
      }

      st.textContent = 'Writing to TX memory...'; st.style.color = 'var(--muted)';

      // 2. 헤더 워드 write: [10:0]=Length(bytes)
      await memWrite(0, byteLen & 0x7FF);

      // 3. 데이터 워드 write (4바이트씩)
      for (let i = 0; i < byteLen; i += 4) {
        const w = ((bytes[i]   || 0) << 24) |
                  ((bytes[i+1] || 0) << 16) |
                  ((bytes[i+2] || 0) << 8)  |
                   (bytes[i+3] || 0);
        await memWrite(0, w >>> 0);
      }

      // 4. TX_READY = 1
      st.textContent = 'TX Ready...'; st.style.color = 'var(--muted)';
      await regWrite(OFF.TX_READY, 0x1);

      st.textContent = 'Sent ' + byteLen + ' bytes (' + wordsNeeded + ' words)';
      st.style.color = 'var(--green)';
      setTimeout(readAll, 300);
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();


// ── NIC RX Manager ────────────────────────────────────────────────────────────
(function nicRxManager() {
  const NIC_BASE = 0xAC0;
  const RX_MEM   = 0x2000;  // RX FIFO 메모리 (BASE + 0x2000)

  const OFF = {
    RX_FRAME_INFO: 0x080,
    RX_INTR_INFO:  0x084,
    RX_TRY:        0x090,
    RX_FCS_ERR:    0x094,
    RX_LEN_FAIL:   0x098,
    RX_MEM_FULL:   0x09C,
    RX_SUCC:       0x0A0,
  };

  function getSession() {
    const el = document.getElementById('serialPort');
    return el ? el.value : '';
  }

  async function regRead(offset) {
    const res = await api('/api/register/read', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: NIC_BASE + offset })
    });
    if (!res.ok) throw new Error(res.error || 'read failed');
    return res.value >>> 0;
  }

  async function regWrite(offset, value) {
    const res = await api('/api/register/write', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: NIC_BASE + offset, value: value >>> 0 })
    });
    if (!res.ok) throw new Error(res.error || 'write failed');
  }

  async function memRead(relOffset) {
    const res = await api('/api/register/read', {
      method: 'POST',
      body: JSON.stringify({ session: getSession(), offset: RX_MEM + relOffset })
    });
    if (!res.ok) throw new Error(res.error || 'mem read failed');
    return res.value >>> 0;
  }

  function setDot(id, active) {
    const el = document.getElementById(id);
    if (!el) return;
    if (active) el.classList.add('active'); else el.classList.remove('active');
  }

  function setCounter(id, val, isErr) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val.toLocaleString();
    el.style.color = (isErr && val > 0) ? 'var(--red)' : '';
  }

  function toHex8(v) { return (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

  // ── Read All (Frame Info + Intr Info + RX Memory + Counters) ─────────────────
  async function readAll() {
    const st = document.getElementById('rv-st-nic-rx');
    st.textContent = 'Reading...'; st.style.color = 'var(--muted)';
    try {
      // Frame Info
      const frameInfo = await regRead(OFF.RX_FRAME_INFO);
      const wordLen   = frameInfo & 0x1FF;
      const frameNum  = (frameInfo >> 12) & 0x7F;
      document.getElementById('nicRxWordLen').textContent  = wordLen + ' words (' + (wordLen * 4) + ' bytes)';
      document.getElementById('nicRxFrameNum').textContent = frameNum + ' frames';

      // Intr Info
      const intrInfo = await regRead(OFF.RX_INTR_INFO);
      const rxLen    = intrInfo & 0x7FF;
      const fcsErr   = !!(intrInfo & (1 << 12));
      const memFull  = !!(intrInfo & (1 << 13));
      document.getElementById('nicRxLength').textContent = rxLen + ' bytes';
      setDot('nicRxFcsErr',  fcsErr);
      setDot('nicRxMemFull', memFull);

      // RX Memory 읽기 (wordLen 워드만큼)
      const frameEl = document.getElementById('nicRxFrameData');
      if (wordLen > 0) {
        const words = [];
        for (let i = 0; i < wordLen; i++) {
          words.push(await memRead(0));
        }
        // 첫 워드: Switch Packet Header 파싱
        const hdr        = words[0];
        const hdrLen     = hdr & 0x7FF;
        const hdrTsAdded = !!(hdr & (1 << 12));
        const hdrFrmCnt  = (hdr >> 16) & 0xFFFF;

        let out = '[Header] Length=' + hdrLen + 'B  TS_ADDED=' + (hdrTsAdded ? 'Y' : 'N') + '  Frame_count=' + hdrFrmCnt + '\n';
        out += '[Data]\n';
        // 나머지 워드를 hex + ASCII로 표시
        for (let i = 1; i < words.length; i++) {
          const w = words[i];
          const b = [(w>>24)&0xFF,(w>>16)&0xFF,(w>>8)&0xFF,w&0xFF];
          const hex = b.map(function(x){return x.toString(16).toUpperCase().padStart(2,'0');}).join(' ');
          const asc = b.map(function(x){return x>=32&&x<127?String.fromCharCode(x):'.';}).join('');
          out += hex + '  ' + asc + '\n';
        }
        frameEl.textContent = out;
        frameEl.style.color = 'var(--fg)';
      } else {
        frameEl.textContent = '수신 데이터 없음 (wordLen=0)';
        frameEl.style.color = 'var(--muted)';
      }

      // Counters
      const tryVal   = await regRead(OFF.RX_TRY);
      const fcsErrC  = await regRead(OFF.RX_FCS_ERR);
      const lenFail  = await regRead(OFF.RX_LEN_FAIL);
      const memFullC = await regRead(OFF.RX_MEM_FULL);
      const succVal  = await regRead(OFF.RX_SUCC);

      setCounter('nicRxTry',       tryVal,  false);
      setCounter('nicRxSucc',      succVal, false);
      setCounter('nicRxFcsErrCnt', fcsErrC, true);
      setCounter('nicRxLenFail',   lenFail, true);
      setCounter('nicRxMemFullCnt',memFullC,true);

      const sumEl = document.getElementById('nicRxSummary');
      if (sumEl) {
        const succPct  = tryVal > 0 ? (succVal / tryVal * 100).toFixed(1) : '—';
        const errTotal = fcsErrC + lenFail + memFullC;
        sumEl.textContent = 'TRY ' + tryVal.toLocaleString() +
          '  →  SUCCESS ' + succVal.toLocaleString() + ' (' + succPct + '%)' +
          (errTotal > 0 ? '  |  에러: FCS ' + fcsErrC + '  LEN ' + lenFail + '  MEM ' + memFullC : '  |  에러 없음');
        sumEl.style.color = errTotal > 0 ? 'var(--red)' : 'var(--green)';
      }

      st.textContent = 'OK  wordLen=' + wordLen + '  frameNum=' + frameNum;
      st.style.color = 'var(--green)';
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  }

  document.getElementById('nicRxRead').addEventListener('click', readAll);

  // ── Next Frame ────────────────────────────────────────────────────────────────
  document.getElementById('nicRxNext').addEventListener('click', async function() {
    const st = document.getElementById('rv-st-nic-rx');
    st.textContent = 'Next frame...'; st.style.color = 'var(--muted)';
    try {
      await regWrite(OFF.RX_FRAME_INFO, 0x0);
      setTimeout(readAll, 100);
    } catch(e) { st.textContent = e.message; st.style.color = 'var(--red)'; }
  });
})();
