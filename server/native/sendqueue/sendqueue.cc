// sendqueue.cc — minimal Npcap send-queue addon for high-rate TX on Windows.
// Exposes transmit(deviceName, frameBuffer, count, chunk, sync) which queues
// `count` copies of the frame via pcap_sendqueue_* and blasts them with
// pcap_sendqueue_transmit (ONE driver call per chunk) — far faster than
// per-packet pcap_sendpacket. Returns { ok, frames, bytes, error }.
#include <nan.h>
#include <pcap.h>
#include <string.h>
#include <stdio.h>

using namespace Nan;

NAN_METHOD(Transmit) {
  if (info.Length() < 3 || !info[1]->IsObject()) {
    Nan::ThrowError("transmit(device, frameBuffer, count, [chunk], [sync])");
    return;
  }
  Nan::Utf8String dev(info[0]);
  v8::Local<v8::Object> bufObj = info[1].As<v8::Object>();
  const u_char* frame = (const u_char*)node::Buffer::Data(bufObj);
  size_t frameLen = node::Buffer::Length(bufObj);
  uint32_t count  = Nan::To<uint32_t>(info[2]).FromMaybe(0);
  uint32_t chunk  = info[3]->IsUndefined() ? 1000u : Nan::To<uint32_t>(info[3]).FromMaybe(1000);
  int sync        = info[4]->IsUndefined() ? 0 : Nan::To<int32_t>(info[4]).FromMaybe(0);
  if (chunk == 0) chunk = 1000;
  if (frameLen == 0 || count == 0) { Nan::ThrowError("empty frame or count"); return; }

  char errbuf[PCAP_ERRBUF_SIZE] = {0};
  pcap_t* p = pcap_open_live(*dev, 65536, 0, 1000, errbuf);
  if (!p) { Nan::ThrowError(errbuf[0] ? errbuf : "pcap_open_live failed"); return; }

  uint64_t framesSent = 0, bytesSent = 0;
  bool ok = true;
  char emsg[256] = {0};
  const size_t hdrSz = sizeof(struct pcap_pkthdr);

  uint32_t remaining = count;
  while (remaining > 0 && ok) {
    uint32_t n = (remaining < chunk) ? remaining : chunk;
    u_int memsize = (u_int)((frameLen + hdrSz) * (size_t)n);
    pcap_send_queue* q = pcap_sendqueue_alloc(memsize);
    if (!q) { ok = false; snprintf(emsg, sizeof(emsg), "sendqueue_alloc(%u) failed", memsize); break; }

    struct pcap_pkthdr hdr;
    memset(&hdr, 0, sizeof(hdr));
    hdr.caplen = (bpf_u_int32)frameLen;
    hdr.len    = (bpf_u_int32)frameLen;

    uint32_t queued = 0;
    for (uint32_t i = 0; i < n; i++) {
      if (pcap_sendqueue_queue(q, &hdr, frame) < 0) break;
      queued++;
    }
    u_int qlen = q->len;                       // total queued bytes (incl. headers)
    u_int sent = pcap_sendqueue_transmit(p, q, sync);
    pcap_sendqueue_destroy(q);

    framesSent += queued;
    bytesSent  += (uint64_t)queued * frameLen;
    if (queued < n)   { ok = false; snprintf(emsg, sizeof(emsg), "queued %u of %u", queued, n); }
    else if (sent < qlen) { ok = false; snprintf(emsg, sizeof(emsg), "transmit short: %u of %u bytes", sent, qlen); }
    remaining -= n;
  }
  pcap_close(p);

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
