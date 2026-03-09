// Simple dev server with SPA fallback to index.html
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.csv': 'text/csv', '.txt': 'text/plain', '.pdf': 'application/pdf',
};

http.createServer((req, res) => {
  const urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);

  // Try to serve static file
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // SPA fallback: serve index.html for all non-file routes
  const ext = path.extname(urlPath);
  if (!ext) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}).listen(PORT, () => {
  console.log(`Dev server: http://localhost:${PORT}`);
});
