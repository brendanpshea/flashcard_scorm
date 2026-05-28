#!/usr/bin/env node
// Tiny static server for local preview. ES modules need http:// not file://,
// so use this instead of double-clicking index.html.
// Usage: node serve.js [dir] [port]

const http = require("http");
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || "preview/5week");
const port = parseInt(process.argv[3] || "8080", 10);

const TYPES = {
  ".html":"text/html",".js":"text/javascript",".css":"text/css",
  ".json":"application/json",".xml":"application/xml"
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(dir, url === "/" ? "index.html" : url);
  if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache"
    });
    res.end(data);
  });
}).listen(port, () => console.log(`Serving ${dir} at http://localhost:${port}`));
