'use strict';
/**
 * httpUtil.js — Node 16+ compatibility shims.
 *
 *  timeoutSignal(ms)    — polyfill for AbortSignal.timeout() (added in Node 17.3)
 *  httpFetch(url, opts) — fetch() using built-in http/https (Node 14+);
 *                         defers to global fetch when available (Node 18+)
 */
const http  = require('http');
const https = require('https');

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`Request timed out (${ms}ms)`)), ms);
  if (t?.unref) t.unref();
  return ctrl.signal;
}

function httpFetch(url, opts = {}) {
  if (typeof fetch === 'function') return fetch(url, opts);

  return new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal?.aborted) return reject(new Error('The operation was aborted'));

    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }

    const lib = u.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };

    let done = false;
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (done) return;
        done = true;
        const body   = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode;
        resolve({
          ok:   status >= 200 && status < 300,
          status,
          json: () => { try { return Promise.resolve(JSON.parse(body)); } catch (e) { return Promise.reject(e); } },
          text: () => Promise.resolve(body),
        });
      });
    });

    req.on('error', (err) => { if (!done) { done = true; reject(err); } });

    if (signal) {
      const onAbort = () => {
        if (done) return;
        done = true;
        req.destroy();
        reject(new Error('The operation was aborted'));
      };
      if (signal.aborted) { req.destroy(); return reject(new Error('The operation was aborted')); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

module.exports = { timeoutSignal, httpFetch };
