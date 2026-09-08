#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Copy the SQLite WebAssembly runtime into site/vendor/.
 *
 * We use the official @sqlite.org/sqlite-wasm build rather than sql.js: the
 * stock sql.js distribution is compiled without FTS5, so every query against
 * this index fails with "no such module: fts5".
 *
 * The runtime is vendored rather than pulled from a CDN so the page keeps
 * working on networks that block third-party CDNs - which includes plenty of
 * school and library networks, i.e. exactly this tool's audience.
 *
 * index.mjs locates its .wasm with `new URL('sqlite3.wasm', import.meta.url)`,
 * so the two files must sit next to each other. No bundler is involved.
 */
const require = createRequire(import.meta.url);
const FILES = ['index.mjs', 'sqlite3.wasm'];

// Deliberately independent of src/config.js: this also runs from npm
// postinstall, and a malformed org config should not break "npm install".
const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'site');

function main() {
  const pkgJson = require.resolve('@sqlite.org/sqlite-wasm/package.json');
  const dist = path.join(path.dirname(pkgJson), 'dist');
  const dest = path.join(siteDir, 'vendor');
  fs.mkdirSync(dest, { recursive: true });

  for (const f of FILES) {
    const from = path.join(dist, f);
    if (!fs.existsSync(from)) {
      throw new Error(`Expected ${from} - the @sqlite.org/sqlite-wasm layout may have changed.`);
    }
    fs.copyFileSync(from, path.join(dest, f));
    console.log(`vendored ${f} (${(fs.statSync(from).size / 1e3).toFixed(0)} KB)`);
  }

  const { version } = require('@sqlite.org/sqlite-wasm/package.json');
  fs.writeFileSync(path.join(dest, 'VERSION'), `@sqlite.org/sqlite-wasm ${version}\n`);
  console.log(`SQLite WASM ${version} vendored into site/vendor/`);
}

try {
  main();
} catch (err) {
  console.error(`vendor: ${err.message}`);
  process.exit(1);
}
