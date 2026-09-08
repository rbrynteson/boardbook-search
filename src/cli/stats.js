#!/usr/bin/env node
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { paths } from '../config.js';
import { log } from '../lib/log.js';

if (!fs.existsSync(paths.db)) {
  log.error(`${paths.db} not found. Run "npm run scrape && npm run build".`);
  process.exit(1);
}

const db = new Database(paths.db, { readonly: true });
const one = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();

const meta = Object.fromEntries(all('SELECT key, value FROM meta').map((r) => [r.key, r.value]));

console.log(`\n${meta.site_title || meta.org_name}`);
console.log(`org ${meta.org_id} · index built ${meta.generated_at}`);
console.log(`file ${(fs.statSync(paths.db).size / 1e6).toFixed(2)} MB\n`);

console.log('Meetings');
console.log(`  total            ${one('SELECT COUNT(*) n FROM meetings').n}`);
console.log(`  with documents   ${one('SELECT COUNT(*) n FROM meetings WHERE docs_indexed=1').n}`);
console.log(`  cancelled        ${one('SELECT COUNT(*) n FROM meetings WHERE cancelled=1').n}`);
const range = one('SELECT MIN(date) a, MAX(date) b FROM meetings WHERE date IS NOT NULL');
console.log(`  date range       ${range.a} .. ${range.b}\n`);

console.log('Documents by kind');
for (const r of all(`SELECT kind, COUNT(*) n, SUM(LENGTH(text)) chars
                     FROM documents GROUP BY kind ORDER BY n DESC`)) {
  const withText = db.prepare('SELECT COUNT(*) n FROM documents WHERE kind=? AND LENGTH(text)>0').get(r.kind).n;
  console.log(`  ${r.kind.padEnd(14)} ${String(r.n).padStart(6)}  with text ${String(withText).padStart(6)}  ${((r.chars || 0) / 1e6).toFixed(2)}M chars`);
}

console.log('\nMeetings per year');
for (const r of all('SELECT year, COUNT(*) n FROM meetings WHERE year IS NOT NULL GROUP BY year ORDER BY year DESC LIMIT 20')) {
  console.log(`  ${r.year}  ${'#'.repeat(Math.min(60, r.n))} ${r.n}`);
}
console.log();
db.close();
