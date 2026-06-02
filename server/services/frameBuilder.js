'use strict';
/**
 * frameBuilder.js — Pure JS Ethernet frame construction.
 * Mirrors C# LabPacketService.BuildFrame() for Linux / headless operation.
 */

function macBytes(mac) {
  return Buffer.from((mac || 'ff:ff:ff:ff:ff:ff').replace(/[:\-]/g, '').padStart(12, '0'), 'hex');
}

function ipBytes(ip) {
  return Buffer.from((ip || '0.0.0.0').split('.').map(Number));
}

function u16be(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v >>> 0);
  return b;
}

function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2)
    sum += (i + 1 < buf.length) ? (buf[i] << 8) + buf[i + 1] : buf[i] << 8;
  while (sum >> 16) sum = (sum & 0xFFFF) + (sum >> 16);
  return (~sum) & 0xFFFF;
}

function parseHex(s) { return parseInt(String(s ?? '0').replace(/^0x/i, ''), 16) || 0; }

function payloadBytes(p, seq) {
  const pl = p.payload || {};
  const mode = (pl.mode || 'text').toLowerCase();
  if (mode === 'hex') return Buffer.from((pl.data || '').replace(/[:\s]/g, ''), 'hex');
  if (mode === 'random') {
    const len = pl.length || pl.size || 64;
    const b = Buffer.alloc(len);
    for (let i = 0; i < len; i++) b[i] = Math.random() * 256 | 0;
    return b;
  }
  // NOTE: the payload is emitted exactly as given. We deliberately do NOT append
  // a "_<seq>" suffix — that silently changed the frame size (e.g. a 1472-byte
  // payload became 1474, pushing a "1514-byte" frame to 1516 and over the Ethernet
  // max so the NIC rejected it), and made frame sizes vary across a burst, which
  // skews throughput/measurement. Use payload mode 'random' for per-packet variety.
  const text = pl.data || pl.text || '';
  return Buffer.from(text, 'utf8');
}

function buildUDP(p, seq) {
  const u = p.udp || {};
  const data  = payloadBytes(p, seq);
  const sp    = u.srcPort ?? p.srcPort ?? 40000;
  const dp    = u.dstPort ?? p.dstPort ?? 50000;
  const len   = 8 + data.length;
  const ip    = p.ipv4 || {};
  const srcIp = Buffer.from((ip.src || '0.0.0.0').split('.').map(Number));
  const dstIp = Buffer.from((ip.dst || '0.0.0.0').split('.').map(Number));

  // UDP header (checksum = 0 for simplicity)
  const hdr = Buffer.concat([u16be(sp), u16be(dp), u16be(len), u16be(0)]);
  // Pseudo-header for checksum
  const pseudo = Buffer.concat([srcIp, dstIp, Buffer.from([0, 17]), u16be(len)]);
  const full   = Buffer.concat([pseudo, hdr, data]);
  const cs     = checksum(full);
  // RFC 768: a computed checksum of 0 must be transmitted as 0xFFFF, since an
  // all-zero UDP checksum means "no checksum present".
  hdr.writeUInt16BE(cs || 0xFFFF, 6);
  return Buffer.concat([hdr, data]);
}

function buildICMP(p, seq) {
  const ic   = p.icmp || {};
  const type = ic.type ?? 8;
  const code = ic.code ?? 0;
  const data = payloadBytes(p, seq);
  const hdr  = Buffer.alloc(8);
  hdr[0] = type; hdr[1] = code;
  hdr.writeUInt16BE(1, 4);
  hdr.writeUInt16BE(seq ?? 0, 6);
  const payload = Buffer.concat([hdr, data]);
  const cs = checksum(payload);
  payload.writeUInt16BE(cs, 2);
  return payload;
}

function buildARP(arp, p) {
  arp = arp || {};
  const ip  = p.ipv4 || {};
  const op  = Number(arp.operation ?? 1) || 1;
  const b   = Buffer.alloc(28);
  b.writeUInt16BE(0x0001, 0); // HW type: Ethernet
  b.writeUInt16BE(0x0800, 2); // Protocol: IPv4
  b[4] = 6; b[5] = 4;
  b.writeUInt16BE(op, 6);
  macBytes(arp.senderMac || p.srcMac).copy(b, 8);
  ipBytes(arp.senderIp   || ip.src || '0.0.0.0').copy(b, 14);
  // ARP Request (op=1): target hardware address is unknown, so it must be all
  // zeros — NOT the Ethernet broadcast/dst MAC. Only an ARP Reply (op=2) carries
  // a real target MAC (fall back to the dst MAC for replies, as before).
  const tgtMac = arp.targetMac || (op === 1 ? '00:00:00:00:00:00' : p.dstMac);
  macBytes(tgtMac).copy(b, 18);
  ipBytes(arp.targetIp   || ip.dst || '0.0.0.0').copy(b, 24);
  return b;
}

function buildTCP(p, seq) {
  const t      = p.tcp || {};
  const data   = payloadBytes(p, seq);
  const sp     = t.srcPort  ?? p.srcPort  ?? 40000;
  const dp     = t.dstPort  ?? p.dstPort  ?? 50000;
  const seqNum = t.seqNum   ?? t.seq ?? (seq != null ? seq : 0);
  const ackNum = t.ackNum   ?? t.ack ?? 0;
  // Default: PSH+ACK (0x18) when payload present, SYN (0x02) otherwise
  const flags  = t.flags    ?? (data.length > 0 ? 0x18 : 0x02);
  const win    = t.window   ?? 65535;

  const hdr = Buffer.alloc(20);
  hdr.writeUInt16BE(sp,      0);
  hdr.writeUInt16BE(dp,      2);
  hdr.writeUInt32BE(seqNum,  4);
  hdr.writeUInt32BE(ackNum,  8);
  hdr[12] = 0x50;               // data offset = 5 (20 bytes header)
  hdr[13] = flags;
  hdr.writeUInt16BE(win,    14);

  const ip     = p.ipv4 || {};
  const srcIp  = Buffer.from((ip.src || '0.0.0.0').split('.').map(Number));
  const dstIp  = Buffer.from((ip.dst || '0.0.0.0').split('.').map(Number));
  const tcpLen = 20 + data.length;
  const pseudo = Buffer.concat([srcIp, dstIp, Buffer.from([0, 6]), u16be(tcpLen)]);
  const cs     = checksum(Buffer.concat([pseudo, hdr, data]));
  hdr.writeUInt16BE(cs, 16);

  return Buffer.concat([hdr, data]);
}

function buildIPv4(p, proto, innerPayload, seq) {
  const ip  = p.ipv4 || {};
  const ttl = ip.ttl ?? 64;
  const tos = ip.tos ?? 0;
  const id  = ip.id  ?? ((seq ?? 0) & 0xFFFF);
  const ff  = ip.flagsFragment ?? 0x4000;
  const tot = 20 + innerPayload.length;

  const h = Buffer.alloc(20);
  h[0] = 0x45; h[1] = tos;
  h.writeUInt16BE(tot, 2);
  h.writeUInt16BE(id, 4);
  h.writeUInt16BE(ff, 6);
  h[8] = ttl; h[9] = proto;
  ipBytes(ip.src).copy(h, 12);
  ipBytes(ip.dst).copy(h, 16);
  const cs = checksum(h);
  h.writeUInt16BE(cs, 10);
  return Buffer.concat([h, innerPayload]);
}

function buildEthHdr(p, etherType) {
  const vlan = p.vlan;
  const dst  = macBytes(p.dstMac);
  const src  = macBytes(p.srcMac);
  if (vlan && vlan.enabled) {
    const pri = vlan.priority ?? 0;
    const dei = vlan.dei ? 1 : 0;
    const vid = vlan.id ?? 1;
    const tci = (pri << 13) | (dei << 12) | (vid & 0xFFF);
    return Buffer.concat([dst, src, u16be(0x8100), u16be(tci), u16be(etherType)]);
  }
  return Buffer.concat([dst, src, u16be(etherType)]);
}

function normalizeProfile(raw) {
  const p = JSON.parse(JSON.stringify(raw));
  if (!p.ipv4) p.ipv4 = {};
  // Top-level flat fields → ipv4 sub-object
  if (p.srcIp != null && p.ipv4.src == null) { p.ipv4.src = p.srcIp; delete p.srcIp; }
  if (p.dstIp != null && p.ipv4.dst == null) { p.ipv4.dst = p.dstIp; delete p.dstIp; }
  if (p.ttl   != null && p.ipv4.ttl == null) { p.ipv4.ttl = Number(p.ttl); delete p.ttl; }
  if (p.tos   != null && p.ipv4.tos == null) { p.ipv4.tos = Number(p.tos); delete p.tos; }

  const proto = (p.protocol || 'udp').toLowerCase();
  // Use null/undefined checks (not truthiness) so boundary values like
  // srcPort=0 / dstPort=0 are preserved instead of being silently dropped.
  if (proto === 'udp') {
    if (!p.udp) p.udp = {};
    if (p.srcPort != null && p.udp.srcPort == null) { p.udp.srcPort = p.srcPort; delete p.srcPort; }
    if (p.dstPort != null && p.udp.dstPort == null) { p.udp.dstPort = p.dstPort; delete p.dstPort; }
  } else if (proto === 'tcp') {
    if (!p.tcp) p.tcp = {};
    if (p.srcPort != null && p.tcp.srcPort == null) { p.tcp.srcPort = p.srcPort; delete p.srcPort; }
    if (p.dstPort != null && p.tcp.dstPort == null) { p.tcp.dstPort = p.dstPort; delete p.dstPort; }
  }
  return p;
}

/**
 * Build a frame respecting the user-defined block order in profile.blocks[].
 *
 * Each block contributes only its own header bytes (no inner payload bundled in).
 * Payload blocks contribute their raw data bytes.  Transport/network headers that
 * need to know the bytes that follow (IPv4 total-length, UDP/TCP/ICMP checksums)
 * look ahead at the precomputed sizes and payload bytes.
 */
function buildFrameFromBlocks(blocks, profile, seq) {
  // Pre-compute Payload block bytes (needed for transport checksum over real data)
  const precomputed = blocks.map(b => {
    if (b.type !== 'Payload') return null;
    const mode = (b.mode || 'text').toLowerCase();
    if (mode === 'hex') return Buffer.from((b.data || '').replace(/[:\s]/g, ''), 'hex');
    if (mode === 'random') {
      const len = b.length || b.size || 64;
      const buf = Buffer.alloc(len);
      for (let k = 0; k < len; k++) buf[k] = Math.random() * 256 | 0;
      return buf;
    }
    // Emit payload exactly as given (no "_<seq>" suffix — see payloadBytes note):
    // keeps frame size exact/deterministic so max-size (1514) sends don't overflow.
    return Buffer.from(b.data || '', 'utf8');
  });

  // Fixed header sizes per block type (each block contributes only its header)
  const HDRSIZE = { Ethernet: 14, VLAN: 4, ARP: 28, IPv4: 20, TCP: 20, UDP: 8, ICMP: 8 };
  const sizes = blocks.map((b, i) =>
    b.type === 'Payload' ? precomputed[i].length : (HDRSIZE[b.type] || 0)
  );

  // Total bytes from block index `from` to end — used for length/checksum lookahead
  const sizeFrom = (from) => sizes.slice(from).reduce((a, s) => a + s, 0);

  // Bytes from block index `from` to end, using actual payload data and zero-fill
  // for other headers (best-effort for unusual orderings)
  const bytesFrom = (from) => Buffer.concat(
    precomputed.slice(from).map((b, j) => b !== null ? b : Buffer.alloc(sizes[from + j]))
  );

  // Coerce a block field to a number, honoring 0 but treating ''/null/undefined
  // as "not set" so the caller's fallback applies.
  const numB = (v, d) => (v != null && v !== '') ? Number(v) : d;

  const parts = [];
  for (let i = 0; i < blocks.length; i++) {
    const block   = blocks[i];
    const nextType = i + 1 < blocks.length ? blocks[i + 1].type : null;

    switch (block.type) {
      case 'Ethernet': {
        // If followed by a VLAN block, the etherType field becomes the TPID
        const et = (nextType === 'VLAN') ? 0x8100 : parseHex(block.etherType ?? '0x0800');
        parts.push(Buffer.concat([macBytes(block.dstMac), macBytes(block.srcMac), u16be(et)]));
        break;
      }
      case 'VLAN': {
        // VLAN contributes 4 bytes: TCI (2) + inner EtherType (2)
        // The TPID 0x8100 is in the preceding Ethernet block's etherType field
        const tci = ((block.priority ?? 0) << 13) | ((block.dei ? 1 : 0) << 12) | ((block.vlanId ?? 1) & 0xFFF);
        parts.push(Buffer.concat([u16be(tci), u16be(parseHex(block.innerEtherType ?? '0x0800'))]));
        break;
      }
      case 'IPv4': {
        // Block fields win; profile.ipv4 is the fallback. UI block field names:
        // srcIp/dstIp/ttl/tos.
        const ip = profile.ipv4 || {};
        let ipProto = ip.ipProto ?? 0;
        for (let j = i + 1; j < blocks.length; j++) {
          if (blocks[j].type === 'UDP')  { ipProto = 17; break; }
          if (blocks[j].type === 'TCP')  { ipProto = 6;  break; }
          if (blocks[j].type === 'ICMP') { ipProto = 1;  break; }
        }
        const tos = numB(block.tos, ip.tos ?? 0);
        const ttl = numB(block.ttl, ip.ttl ?? 64);
        const id  = numB(block.id,  ip.id ?? ((seq ?? 0) & 0xFFFF));
        const ff  = numB(block.flagsFragment, ip.flagsFragment ?? 0x4000);
        const src = block.srcIp ?? ip.src ?? '0.0.0.0';
        const dst = block.dstIp ?? ip.dst ?? '0.0.0.0';
        const h = Buffer.alloc(20);
        h[0] = 0x45; h[1] = tos & 0xFF;
        h.writeUInt16BE(20 + sizeFrom(i + 1), 2);
        h.writeUInt16BE(id & 0xFFFF, 4);
        h.writeUInt16BE(ff & 0xFFFF, 6);
        h[8] = ttl & 0xFF; h[9] = ipProto;
        ipBytes(src).copy(h, 12);
        ipBytes(dst).copy(h, 16);
        h.writeUInt16BE(checksum(h), 10);
        parts.push(h);
        break;
      }
      case 'ARP': {
        // Block ARP fields win; profile.arp is the fallback.
        const pa = profile.arp || {};
        const a = {
          operation: block.operation ?? pa.operation,
          senderMac: block.senderMac ?? pa.senderMac,
          senderIp:  block.senderIp  ?? pa.senderIp,
          targetMac: block.targetMac ?? pa.targetMac,
          targetIp:  block.targetIp  ?? pa.targetIp,
        };
        parts.push(buildARP(a, profile));
        break;
      }
      case 'UDP': {
        const u = profile.udp || {};
        const after = bytesFrom(i + 1);
        const len   = 8 + after.length;
        const srcIp = ipBytes(profile.ipv4?.src || '0.0.0.0');
        const dstIp = ipBytes(profile.ipv4?.dst || '0.0.0.0');
        const sp    = numB(block.srcPort, u.srcPort ?? 40000);
        const dp    = numB(block.dstPort, u.dstPort ?? 50000);
        const hdr   = Buffer.concat([u16be(sp), u16be(dp), u16be(len), u16be(0)]);
        const pseudo = Buffer.concat([srcIp, dstIp, Buffer.from([0, 17]), u16be(len)]);
        // RFC 768: transmit 0xFFFF when the computed checksum is 0.
        hdr.writeUInt16BE(checksum(Buffer.concat([pseudo, hdr, after])) || 0xFFFF, 6);
        parts.push(hdr);
        break;
      }
      case 'TCP': {
        // UI block field names: srcPort/dstPort/flags/seqNum/ackNum (+ optional window).
        const t     = profile.tcp || {};
        const after = bytesFrom(i + 1);
        const sp    = numB(block.srcPort, t.srcPort ?? 40000);
        const dp    = numB(block.dstPort, t.dstPort ?? 50000);
        const seqN  = numB(block.seqNum ?? block.seq, t.seq ?? t.seqNum ?? 0);
        const ackN  = numB(block.ackNum ?? block.ack, t.ack ?? t.ackNum ?? 0);
        const flags = numB(block.flags, t.flags ?? (after.length > 0 ? 0x18 : 0x02));
        const win   = numB(block.window, t.window ?? 65535);
        const hdr   = Buffer.alloc(20);
        hdr.writeUInt16BE(sp, 0);
        hdr.writeUInt16BE(dp, 2);
        hdr.writeUInt32BE(seqN >>> 0, 4);
        hdr.writeUInt32BE(ackN >>> 0, 8);
        hdr[12] = 0x50;
        hdr[13] = flags & 0xFF;
        hdr.writeUInt16BE(win & 0xFFFF, 14);
        const srcIp  = ipBytes(profile.ipv4?.src || '0.0.0.0');
        const dstIp  = ipBytes(profile.ipv4?.dst || '0.0.0.0');
        const pseudo = Buffer.concat([srcIp, dstIp, Buffer.from([0, 6]), u16be(20 + after.length)]);
        hdr.writeUInt16BE(checksum(Buffer.concat([pseudo, hdr, after])), 16);
        parts.push(hdr);
        break;
      }
      case 'ICMP': {
        // UI block field names: icmpType/icmpCode.
        const ic    = profile.icmp || {};
        const after = bytesFrom(i + 1);
        const type  = numB(block.icmpType ?? block.type, ic.type ?? 8);
        const code  = numB(block.icmpCode ?? block.code, ic.code ?? 0);
        const hdr   = Buffer.alloc(8);
        hdr[0] = type & 0xFF; hdr[1] = code & 0xFF;
        hdr.writeUInt16BE(1, 4);
        hdr.writeUInt16BE(seq ?? 0, 6);
        hdr.writeUInt16BE(checksum(Buffer.concat([hdr, after])), 2);
        parts.push(hdr);
        break;
      }
      case 'Payload':
        parts.push(precomputed[i]);
        break;
      default:
        parts.push(Buffer.alloc(0));
    }
  }

  let frame = Buffer.concat(parts);
  // Minimum 60-byte Ethernet padding is implicit, so suppress it in preview.
  if (!profile._preview && frame.length < 60) frame = Buffer.concat([frame, Buffer.alloc(60 - frame.length)]);
  // An explicit requested length is honored in both normal and preview modes,
  // matching the non-blocks buildFrame() path.
  const target = profile.targetFrameLength ?? profile.frameSize;
  if (target && Number(target) > frame.length)
    frame = Buffer.concat([frame, Buffer.alloc(Number(target) - frame.length)]);
  return frame;
}

/** Build a raw Ethernet frame from a packet profile object. Returns Buffer. */
function buildFrame(profile, seq) {
  const p = normalizeProfile(profile);

  // If the client sent an ordered blocks array, build in that exact order
  if (Array.isArray(p.blocks) && p.blocks.length > 0) {
    return buildFrameFromBlocks(p.blocks, p, seq);
  }

  const proto = (p.protocol || 'udp').toLowerCase();

  let frame;
  switch (proto) {
    case 'udp':
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, 17, buildUDP(p, seq), seq)]);
      break;
    case 'icmp':
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, 1, buildICMP(p, seq), seq)]);
      break;
    case 'tcp':
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, 6, buildTCP(p, seq), seq)]);
      break;
    case 'arp':
      frame = Buffer.concat([buildEthHdr(p, 0x0806), buildARP(p.arp, p)]);
      break;
    case 'ipv4': {
      // IPv4 block present but no transport-layer block — include IPv4 header with payload
      const ipProto = p.ipv4?.ipProto ?? p.ipv4?.proto ?? 0;
      frame = Buffer.concat([buildEthHdr(p, 0x0800), buildIPv4(p, ipProto, payloadBytes(p, seq), seq)]);
      break;
    }
    case 'raw': {
      const et = parseHex(p.etherType ?? '0x88b5');
      frame = Buffer.concat([buildEthHdr(p, et), payloadBytes(p, seq)]);
      break;
    }
    default:
      throw new Error(`Unsupported protocol: ${proto}`);
  }

  if (!p._preview && frame.length < 60) frame = Buffer.concat([frame, Buffer.alloc(60 - frame.length)]);
  const target = p.targetFrameLength ?? p.frameSize;
  if (target && Number(target) > frame.length)
    frame = Buffer.concat([frame, Buffer.alloc(Number(target) - frame.length)]);

  return frame;
}

module.exports = { buildFrame, normalizeProfile };
