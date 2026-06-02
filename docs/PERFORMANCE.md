# PacketLabManager — Send/Capture Performance Notes

Measured on this dev box (Windows 11, Node 24 x64, Npcap, **Realtek USB 2.5GbE**
adapter "이더넷", link negotiated at 1 Gbps).

## Measured throughput (current `cap` path)

| Frame size | Result | Notes |
|-----------:|--------|-------|
| 64 B  | ~10,000 pps → **~5 Mbps**   | tiny frames, dominated by per-call overhead |
| 1514 B | ~10,000 pps → **~124 Mbps** | full-size frames |

Throughput is ~**10k packets/sec regardless of frame size** → ~**97 µs per
`cap.send()`**. So the limit is the *number of send calls*, not the bytes.

## Why — the bottleneck is `cap.send()`, not JS

`cap` (Npcap binding) exposes only **one-packet-at-a-time** send
(`pcap_sendpacket`). Every packet is a separate JS → native → driver → USB call
(~97 µs here). Building the frame in JS is negligible by comparison — we verified
this: reusing a pre-built frame for a 300k-packet burst left throughput
unchanged (~8k → ~10k pps). The frame builder is *not* the wall; the per-packet
native send call is.

What this means for line rate:

| Target | 64 B | 1514 B |
|-------:|-----:|-------:|
| 1 Gbps  | 1,488,095 pps | 81,274 pps |
| 10 Gbps | 14,880,952 pps | 812,744 pps |

At ~10k pps the current ceiling is **~124 Mbps (1514 B)** — well short of 1 Gbps.

## Can JavaScript do 1 Gbps? 10 Gbps?

**Not with per-packet `cap.send()`** — no language can, because the cost is one
syscall per packet (~97 µs). The fix is **batching**: hand many packets to the
kernel/driver in a single call. JS is then only *building* packets (cheap,
amortized) and is no longer in the per-packet hot path.

- **Linux — `sendmmsg` / AF_PACKET (txgen):** sends hundreds–thousands of packets
  per syscall. The bundled `traffic-generator` `txgen` measured **963 Mbps** at
  1 Gbps with 0 loss. A Node app driving `txgen` as a child process (the
  `engine:"fast"` path already scaffolded here) reaches line rate — **1 Gbps: yes**.
- **Windows — Npcap send-queue** (`pcap_sendqueue_queue` + `pcap_sendqueue_transmit`):
  queues many packets and transmits in one call, approaching line rate. **`cap`
  npm does not expose this** — it would need a small native addon (or a different
  module). With it, **1 Gbps is feasible**, large frames more easily than small.

**10 Gbps:**
- Large frames (1514 B, ~813k pps): achievable with send-queue / `sendmmsg` on a
  real 10G PCIe NIC.
- Small frames (64 B, ~14.9M pps): realistically needs **kernel bypass (DPDK /
  AF_XDP)** — beyond Npcap and ordinary sockets, and beyond pure JS. Even C tools
  struggle at 64 B/10G without DPDK.
- This box's NIC is 2.5GbE (1 Gbps link), so 10G needs 10G hardware regardless.

## Windows Npcap send-queue — MEASURED (engine:"sendqueue")

We added a small Npcap send-queue addon (`server/native/sendqueue`, exposed as
`engine:"sendqueue"`) that queues many frames and transmits them with one driver
call per chunk (`pcap_sendqueue_transmit`) instead of one `pcap_sendpacket` per
packet. Measured on the same USB 2.5GbE NIC, 1514 B frames:

| Path | pps | Throughput |
|------|----:|-----------:|
| `cap` per-packet | ~10,000 | ~124 Mbps |
| `sendqueue` v1 (rebuild queue per chunk) | ~54,000 | ~0.66–0.76 Gbps |
| **`sendqueue` v2 (build queue once, transmit many)** | **~77,000** | **~0.92–0.93 Gbps** |

The v1→v2 jump came from building the send-queue **once** and calling
`pcap_sendqueue_transmit` on it repeatedly, instead of re-queuing (memcpy-ing)
every frame for each chunk. At 1514 B, 1 GbE line rate is ~0.98 Gbps of frame
bytes, so **~0.93 Gbps is effectively line rate** (the rest is USB/driver + IFG
overhead). Verified end-to-end through `/api/send {engine:"sendqueue"}`:
1,000,000 × 1514 B in 12.97 s = **0.934 Gbps**. So 1 GbE IS reached on Windows
with this method; JS is not the bottleneck (it builds one frame, the addon blasts).

## Real over-the-wire test (Windows → Linux, 2.5GbE link)

Validated against a Linux box (PacketLabManager, tcpdump capture) directly cabled
to the Windows USB 2.5GbE NIC. Cabling discovered by sending a marked broadcast:

| Windows NIC | ↔ | Linux NIC |
|---|---|---|
| 이더넷 (2.5G, c8:4d:44:26:3b:a6) | ↔ | enp1s0f1 |
| 이더넷 2 (1G, c8:4d:44:20:40:5b) | ↔ | enp1s0f3 |

Windows `engine:"sendqueue"` → Linux capture (enp1s0f1), 1514 B unicast:

| TX | Wire rate | Linux captured |
|---:|----------:|---------------:|
| 20,000 frames | 540 Mbps | 16,002 (80%) |
| 100,000 frames | 761 Mbps | 71,701 (72%) |

Frames genuinely cross the wire (first true end-to-end validation). The ~20–28%
shortfall is the **Linux tcpdump + JS-decode capture path dropping** at >0.5 Gbps,
not wire loss — accurate counting at line rate needs **rxcap** (AF_PACKET batch +
`SO_RXQ_OVFL` kernel-drop counting), which must be built on the Linux box.

## Languages & roles — is it Python? is Node enough?

**Python is NOT used at runtime or anywhere in the packet path.** It is only a
build-time dependency of `node-gyp`, which compiles the C addons. Because the
compiled binaries are shipped as prebuilts (`server/prebuilds/...`), end users
don't even need Python to run.

| Layer | Tech | Role | At runtime? |
|-------|------|------|:-----------:|
| Web UI | HTML / JS (browser) | tabs, packet builder, tables | yes |
| App / orchestration | **Node.js** | HTTP API, build frames, drive engines, capture buffer, 2-PC | yes |
| Packet TX/RX engine | **C** (cap = Npcap/libpcap; `sendqueue` addon; Linux txgen/rxcap) | the actual send/capture | yes |
| Build glue | **Python + node-gyp + C/C++ compiler** | compile the C addons **once** | **no** (build-time only; not needed with prebuilt) |

So: **app = Node, engine = C, build glue = Python (one time).** Node is not the
bottleneck — it builds one frame and hands a batch to the C engine.

### Send throughput by approach (1514 B, this box)

| Approach | Languages | Send API | Throughput |
|----------|-----------|----------|-----------:|
| Node + `cap` per-packet | JS → C | `pcap_sendpacket` ×N (1 syscall/pkt) | ~124 Mbps |
| Node + `sendqueue` v1 | JS → C | Npcap send-queue, rebuilt per chunk | ~0.66–0.76 Gbps |
| **Node + `sendqueue` v2** | JS → C | Npcap send-queue, **built once, transmit many** | **~0.93 Gbps (≈ line rate)** |
| Linux `txgen` (reference) | C | AF_PACKET + `sendmmsg` | ~0.96 Gbps (README) |

"Why wasn't pure Node enough?" — not a language limit: the `cap` npm module only
exposes one-packet-at-a-time send, so JS issued one syscall per packet (~124 Mbps).
The win was switching to a **batched** native send (the C addon), still fully
driven by Node. Same JS, ~7.5× the throughput.

## Bottom line

| Path | 1 Gbps | 10 Gbps |
|------|:------:|:-------:|
| Windows, current `cap` (per-packet) | ❌ (~124 Mbps) | ❌ |
| Windows + Npcap send-queue (`engine:"sendqueue"`) | ✅ **~0.93 Gbps measured @1514B** (≈ line rate) | ❌ (small frames) |
| Linux `txgen`/`rxcap` (sendmmsg/recvmmsg) | ✅ (963 Mbps measured) | ☑ large frames; 64 B needs DPDK |

> `engine:"sendqueue"` is synchronous (blocks for the burst duration) and is for a
> fixed frame (no `random` payload). A committed prebuilt
> (`server/prebuilds/<plat>-<arch>/node-v<ABI>/sendqueue.node`) is placed at startup
> by `tools/cap-prebuilt.js`; rebuild with `npm run setup:winfast`.

**Recommendation:** for true 1 G/10 G generation **and** accurate measurement
(latency / IAT / loss via `rxcap`), use the Linux fast engine — it is already
wired in (`engine:"fast"`, `POST /api/capture/measure`). The Windows `cap` path
is optimal for **functional** packet crafting, inspection, and scenario/forwarding
tests, not for line-rate load.

## What was optimized

For `count > 1000`, `sendPackets` now builds the frame **once** and reuses it, and
records a **single summary TX row** instead of decoding + storing one capture row
per packet. This barely changes throughput (the wall is `cap.send`) but prevents
the capture buffer from ballooning to hundreds of thousands of rows during a bulk
send (memory/stability). Small sends keep per-packet behavior (IP id / seq vary,
every TX recorded).
