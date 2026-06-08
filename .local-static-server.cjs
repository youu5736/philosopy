const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "artifacts", "philosophy-librarian", "dist", "public");
const apiTarget = new URL(process.env.API_PROXY_TARGET || "http://127.0.0.1:8099");
const port = Number(process.env.PORT || 8081);

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": mime[path.extname(filePath)] || "application/octet-stream",
    });
    res.end(body);
  });
}

function proxyApi(req, res) {
  const target = new URL(req.url, apiTarget);
  const proxy = http.request(
    target,
    {
      method: req.method,
      headers: { ...req.headers, host: apiTarget.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxy.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "API server is not reachable" }));
  });
  req.pipe(proxy);
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      proxyApi(req, res);
      return;
    }

    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const requested = path.normalize(path.join(root, urlPath));
    const filePath = requested.startsWith(root) && fs.existsSync(requested) && fs.statSync(requested).isFile()
      ? requested
      : path.join(root, "index.html");

    sendFile(res, filePath);
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`Static app server listening on http://127.0.0.1:${port}`);
  });
