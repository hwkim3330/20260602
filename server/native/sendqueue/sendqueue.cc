// sendqueue.cc — cross-platform high-rate Ethernet TX addon.
//   Windows: Npcap send-queue (pcap_sendqueue_alloc/queue/transmit) — one driver
//            call per chunk instead of one pcap_sendpacket per packet.
//   Linux:   AF_PACKET raw socket + sendmmsg() — one syscall per batch.
// Same JS API on both:  transmit(deviceName, frameBuffer, count, chunk, sync)
//                        -> { ok, frames, bytes, error }
// (sync only meaningful on Windows; Linux blasts as fast as possible.)
#include <nan.h>
#include <string.h>
#include <stdio.h>

#ifdef _WIN32
  #include <pcap.h>
#else
  #include <errno.h>
  #include <unistd.h>
  #include <sys/socket.h>
  #include <arpa/inet.h>        // htons
  #include <linux/if_ether.h>   // ETH_P_ALL, ETH_ALEN
  #include <linux/if_packet.h>  // struct sockaddr_ll
  #include <net/if.h>           // if_nametoindex
  #include <vector>
#endif

using namespace Nan;

NAN_METHOD(Transmit) {
  if (info.Length() < 3 || !info[1]->IsObject()) {
    Nan::ThrowError("transmit(device, frameBuffer, count, [chunk], [sync])");
    return;
  }
  Nan::Utf8String dev(info[0]);
  v8::Local<v8::Object> bufObj = info[1].As<v8::Object>();
  const unsigned char* frame = (const unsigned char*)node::Buffer::Data(bufObj);
  size_t   frameLen = node::Buffer::Length(bufObj);
  uint32_t count    = Nan::To<uint32_t>(info[2]).FromMaybe(0);
  uint32_t chunk    = info[3]->IsUndefined() ? 1000u : Nan::To<uint32_t>(info[3]).FromMaybe(1000);
  int      sync     = info[4]->IsUndefined() ? 0 : Nan::To<int32_t>(info[4]).FromMaybe(0);
  if (chunk == 0) chunk = 1000;
  if (frameLen == 0 || count == 0) { Nan::ThrowError("empty frame or count"); return; }

  uint64_t framesSent = 0, bytesSent = 0;
  bool ok = true;
  char emsg[256] = {0};

#ifdef _WIN32
  char errbuf[PCAP_ERRBUF_SIZE] = {0};
  pcap_t* p = pcap_open_live(*dev, 65536, 0, 1000, errbuf);
  if (!p) { Nan::ThrowError(errbuf[0] ? errbuf : "pcap_open_live failed"); return; }
  const size_t hdrSz = sizeof(struct pcap_pkthdr);
  struct pcap_pkthdr hdr; memset(&hdr, 0, sizeof(hdr));
  hdr.caplen = (bpf_u_int32)frameLen; hdr.len = (bpf_u_int32)frameLen;

  // Build ONE queue of `per` identical frames, then transmit it repeatedly. This
  // does the per-frame memcpy into the queue once instead of `count` times — the
  // transmit (the actual DMA/USB blast) is what repeats.
  uint32_t per = (count < chunk) ? count : chunk;
  u_int memsize = (u_int)((frameLen + hdrSz) * (size_t)per);
  pcap_send_queue* q = pcap_sendqueue_alloc(memsize);
  if (!q) { pcap_close(p); snprintf(emsg, sizeof(emsg), "sendqueue_alloc(%u) failed", memsize); Nan::ThrowError(emsg); return; }
  uint32_t built = 0;
  for (uint32_t i = 0; i < per; i++) { if (pcap_sendqueue_queue(q, &hdr, frame) < 0) break; built++; }
  if (built < per) { pcap_sendqueue_destroy(q); pcap_close(p); Nan::ThrowError("sendqueue_queue failed while building"); return; }
  u_int qlen = q->len;

  uint32_t remaining = count;
  while (remaining >= per && ok) {
    u_int sent = pcap_sendqueue_transmit(p, q, sync);
    if (sent < qlen) { ok = false; snprintf(emsg, sizeof(emsg), "transmit short: %u of %u bytes", sent, qlen); break; }
    framesSent += per; bytesSent += (uint64_t)per * frameLen;
    remaining -= per;
  }
  // Remainder (< per): a small one-off queue.
  if (ok && remaining > 0) {
    pcap_send_queue* q2 = pcap_sendqueue_alloc((u_int)((frameLen + hdrSz) * (size_t)remaining));
    if (q2) {
      uint32_t b2 = 0;
      for (uint32_t i = 0; i < remaining; i++) { if (pcap_sendqueue_queue(q2, &hdr, frame) < 0) break; b2++; }
      u_int q2len = q2->len;
      u_int sent2 = pcap_sendqueue_transmit(p, q2, sync);
      pcap_sendqueue_destroy(q2);
      if (b2 == remaining && sent2 >= q2len) { framesSent += remaining; bytesSent += (uint64_t)remaining * frameLen; }
      else { ok = false; snprintf(emsg, sizeof(emsg), "remainder transmit short"); }
    }
  }
  pcap_sendqueue_destroy(q);
  pcap_close(p);
#else
  unsigned int ifidx = if_nametoindex(*dev);
  if (ifidx == 0) { Nan::ThrowError("if_nametoindex failed (no such interface)"); return; }
  int fd = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
  if (fd < 0) { Nan::ThrowError("socket(AF_PACKET) failed (need root / CAP_NET_RAW)"); return; }

  struct sockaddr_ll addr; memset(&addr, 0, sizeof(addr));
  addr.sll_family  = AF_PACKET;
  addr.sll_ifindex = ifidx;
  addr.sll_halen   = ETH_ALEN;
  memcpy(addr.sll_addr, frame, ETH_ALEN);   // dst MAC from the frame

  // sendmmsg vlen is capped (UIO_MAXIOV ~1024); cap the batch accordingly.
  uint32_t batch = chunk > 1024 ? 1024 : chunk;
  struct iovec iov; iov.iov_base = (void*)frame; iov.iov_len = frameLen;
  std::vector<struct mmsghdr> msgs(batch);
  for (uint32_t i = 0; i < batch; i++) {
    memset(&msgs[i], 0, sizeof(struct mmsghdr));
    msgs[i].msg_hdr.msg_iov     = &iov;
    msgs[i].msg_hdr.msg_iovlen  = 1;
    msgs[i].msg_hdr.msg_name    = &addr;
    msgs[i].msg_hdr.msg_namelen = sizeof(addr);
  }
  uint32_t remaining = count;
  while (remaining > 0 && ok) {
    uint32_t n = (remaining < batch) ? remaining : batch;
    int r = sendmmsg(fd, msgs.data(), n, 0);
    if (r < 0) { ok = false; snprintf(emsg, sizeof(emsg), "sendmmsg: %s", strerror(errno)); break; }
    framesSent += (uint32_t)r; bytesSent += (uint64_t)r * frameLen;
    remaining  -= (uint32_t)r;
    if ((uint32_t)r < n) continue; // short send: loop sends the remainder
  }
  close(fd);
#endif

  v8::Local<v8::Object> res = Nan::New<v8::Object>();
  Nan::Set(res, Nan::New("ok").ToLocalChecked(),     Nan::New<v8::Boolean>(ok));
  Nan::Set(res, Nan::New("frames").ToLocalChecked(), Nan::New<v8::Number>((double)framesSent));
  Nan::Set(res, Nan::New("bytes").ToLocalChecked(),  Nan::New<v8::Number>((double)bytesSent));
  if (!ok) Nan::Set(res, Nan::New("error").ToLocalChecked(), Nan::New(emsg).ToLocalChecked());
  info.GetReturnValue().Set(res);
}

NAN_MODULE_INIT(Init) {
  Nan::Set(target, Nan::New("transmit").ToLocalChecked(),
    Nan::GetFunction(Nan::New<v8::FunctionTemplate>(Transmit)).ToLocalChecked());
}
NODE_MODULE(sendqueue, Init)
