# Changelog — PacketLabManager fixes & improvements

Bug-fix and hardening pass on the packet generation / capture / interface code.
Structure was kept as-is; only the affected functions were changed. Commit refs
are on `main`.

## Packet generation (frameBuilder.js)
- **Block fields are now authoritative** in block mode. IPv4 `srcIp/dstIp/ttl/tos`,
  UDP `srcPort/dstPort`, TCP `srcPort/dstPort/flags/seqNum/ackNum`, ICMP
  `icmpType/icmpCode`, ARP `operation/senderMac/senderIp/targetMac/targetIp` are
  read from the block first (profile.* is fallback). Editing a block field now
  changes the built frame. (`6c67045`)
- **ARP Request** (op=1) target hardware address defaults to `00:00:00:00:00:00`
  (was the Ethernet/broadcast dst MAC). ARP Reply (op=2) unchanged. (`6c67045`)
- **Exact frame size**: dropped the automatic `_<seq>` payload suffix that grew a
  1472-byte payload to 1474 — which made a "1514-byte" frame actually 1516,
  exceeding the Ethernet max so the NIC rejected it (PacketSendPacket error 20),
  and made frame sizes vary across a burst. Payload is emitted exactly; use
  payload mode `random` for per-packet variety. (`ec156bd`)
- **`targetFrameLength` / `frameSize`** are honored in block mode (pad after the
  60-byte minimum), matching the non-blocks path. (`6c67045`)
- **UDP checksum 0 → 0xFFFF** per RFC 768. (`a22d6a7`)
- **srcMac auto-fill** for empty *or* all-zero MACs, into the flat profile, the
  Ethernet block, and ARP sender; resolves real NIC MAC even on IP-less L2 NICs
  via Linux sysfs. (`a22d6a7`)
- **normalizeProfile** preserves `srcPort/dstPort = 0` (null-checks, not truthy). (`6c67045`)

## Capture (packetBackend.js, routes/capture.js)
- **TX-echo dedup race** fixed (register the dedup key before `cap.send`). (`a22d6a7`)
- **Capture status** reflects the tcpdump fallback too, not just `cap`. (`a22d6a7`)
- **pcap device name vs OS interface name** separated: rows/status/labels show the
  OS name; the interface monitor checks liveness by OS name (fixes Npcap handles
  being force-closed on Windows). (`a22d6a7`)
- **one-shot `POST /api/capture`** now detects start failure (return value +
  `isCapturing()` + last error) and returns HTTP 500 with a specific cause,
  sharing one message helper with `/capture/start`. (`6c67045`)
- **Clear, specific errors** for `/capture/start` and `/capture-stream`:
  no backend / permission / no device / BPF error / pcap resolve fail. (`a22d6a7`)
- **`buildIfaceBpfFilter`** uses the sysfs-aware MAC resolver (IP-less L2 NICs). (`6c67045`)
- **High-count send**: reuse one frame + single summary TX row for `count > 1000`
  (prevents capture-buffer blow-up). See `docs/PERFORMANCE.md`. (`9a27018`)

## Interfaces (packetBackend.js)
- **`listInterfaces`**: on Linux, state comes from `/sys/class/net/<if>/operstate`
  (+flags) so an IP-less L2 NIC is not forced to "down"; also lists L2-only NICs
  present in sysfs but missing from `os.networkInterfaces()`. (`6c67045`)

## Switch control (serialBridge.js, switchProtocol.js)
- **Serial response desync** fixed: a timed-out command's late `OK/ERR` could be
  mis-attributed to the next queued command (silently wrong register/FDB value).
  Each timeout now registers a short-lived slot that discards that stale response
  (serialport + stty sessions). (`ec156bd`)
- **`fdbDelete`** honors `vlanValid` (matches fdbRead/fdbWrite). (`ec156bd`)

## Cross-platform native module (`cap`)
- **node_modules kept committed**, with a per-target prebuilt loader: ships
  `server/prebuilds/win32-x64/node-v137/cap.node` and copies the matching binary
  into place at startup (`tools/cap-prebuilt.js`). Windows runs from a fresh clone
  with no `npm install`. Add a Linux prebuilt once via
  `npm rebuild cap && npm run cap:save`. (`5a4ac5e`)
- **`npm run setup:windows-cap`** + a non-fatal `postinstall` rebuild cap from the
  Npcap SDK when the committed binary doesn't match the platform/ABI. (`2ce68bf`, `a1ad8f8`)

## High-rate TX — one cross-platform addon (engine:"sendqueue")
- New native addon `server/native/sendqueue` — **one C file, two backends via
  `#ifdef`**: Windows uses the Npcap send-queue (`pcap_sendqueue_transmit`), Linux
  uses an AF_PACKET raw socket + `sendmmsg()`. Both queue many frames and hand them
  to the driver in one call per chunk instead of one `pcap_sendpacket` per packet.
  Same JS API and same `engine:"sendqueue"` on both OSes.
- Exposed as `engine:"sendqueue"` on `/api/send`, reported by `/api/packet/engines`.
- **Windows: measured ~0.43–0.66 Gbps @1514B** on a USB 2.5GbE NIC (~4–5× the
  per-packet path; USB-adapter limited, not software — PCIe should hit 1 Gbps).
- **Linux backend (sendmmsg/AF_PACKET) is written but not yet run here** (no Linux
  toolchain on the dev box) — build with `npm run setup:winfast` equivalent
  (`node-gyp rebuild`) on Linux; needs root/CAP_NET_RAW.
- Prebuilt shipped under `server/prebuilds/<plat>-<arch>/node-v<ABI>/sendqueue.node`
  and placed at startup by `tools/cap-prebuilt.js`; (re)build via
  `npm run setup:winfast`. See `docs/PERFORMANCE.md`.

## Simultaneous multi-interface send (POST /api/send-multi)
- Fire a burst on several interfaces at the SAME wall-clock instant. One child
  process per interface (`tools/sendworker.js`) using the sendqueue addon; all are
  given a shared `startAt` epoch-ms and busy-wait to fire together, so the bursts
  run truly in parallel (separate processes/cores), not the single-threaded
  sequential path. `services/multiSend.js` orchestrates; each interface's frame
  gets its own NIC MAC auto-filled. body: { interfaces:[...], count, chunk,
  startDelayMs, sync, + frame (blocks/flat) }. Returns per-interface
  frames/bytes/gbps/skewMs + maxStartSkewMs + aggregateGbps.
- Measured: 2 USB NICs fired with **maxStartSkewMs = 0** (synchronized start),
  500k×1514B each in parallel.

## Optional Linux fast engine (txgen/rxcap)
- `services/fastEngine.js` + `GET /api/packet/engines` + `engine:"fast"` on
  `/api/send` + `POST /api/capture/measure`. Gated to Linux + installed binaries;
  a clean 503 elsewhere. No new UI tab — extends Packet Generator / Capture. (`fb9acef`)

## Docs
- `README.md`: repo name 20260528 → 20260602, Windows (Npcap) build, fast engine,
  cap prebuilt mechanism.
- `docs/PERFORMANCE.md`: measured throughput, why `cap` caps at ~124 Mbps, and the
  1 G / 10 G path.
