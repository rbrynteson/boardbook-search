#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config.js';
import { log } from '../lib/log.js';

/**
 * Local preview server. Serves site/ plus the built database at /site.db so the
 * page behaves exactly as it will on a static host.
 */
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Module scripts are MIME-checked strictly; octet-stream is rejected.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.db': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = url === '/site.db'
    ? paths.db
    : path.join(paths.site, path.normalize(url === '/' ? '/index.html' : url).replace(/^[/\\]+/, ''));

  // Never serve outside the two directories we intend to expose.
  if (file !== paths.db && !file.startsWith(paths.site)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, () => {
  if (!fs.existsSync(paths.db)) {
    log.warn(`${paths.db} does not exist yet - run "npm run scrape && npm run build" first.`);
  }
  log.step(`Preview running at http://localhost:${PORT}`);
});
