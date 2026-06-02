'use strict';

function sendProxyError(res, err) {
  const status = err.workerError ? 502 : 503;
  res.status(status).json({ ok: false, error: err.message });
}

function proxyGet(router, publicPath, csharpPath, csharp) {
  router.get(publicPath, async (req, res) => {
    try {
      const data = await csharp.get(csharpPath, req.query);
      res.json(data);
    } catch (err) {
      sendProxyError(res, err);
    }
  });
}

function proxyPost(router, publicPath, csharpPath, csharp) {
  router.post(publicPath, async (req, res) => {
    try {
      const data = await csharp.post(csharpPath, req.body);
      res.json(data);
    } catch (err) {
      sendProxyError(res, err);
    }
  });
}

module.exports = { proxyGet, proxyPost, sendProxyError };
