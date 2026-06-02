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

## Bottom line

| Path | 1 Gbps | 10 Gbps |
|------|:------:|:-------:|
| Windows, current `cap` (per-packet) | ❌ (~124 Mbps) | ❌ |
| Windows + Npcap send-queue addon | ☑ feasible (untested) | ❌ (small frames) |
| Linux `txgen`/`rxcap` (sendmmsg/recvmmsg) | ✅ (963 Mbps measured) | ☑ large frames; 64 B needs DPDK |

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
