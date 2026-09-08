/*
 * BoardBook document search - runs entirely in the visitor's browser.
 *
 * Uses the official SQLite WebAssembly build (vendored under vendor/) rather
 * than sql.js, because the stock sql.js distribution is compiled without FTS5
 * and every query here depends on it.
 */
import sqlite3InitModule from './vendor/index.mjs';
import { escapeHtml as esc, highlight, hasMatch } from './markup.js';
import { toMatchExpr } from './query.js';

const DB_URL = 'site.db';
const PAGE_SIZE = 25;

const el = {
  form: document.getElementById('search-form'),
  q: document.getElementById('q'),
  go: document.getElementById('go'),
  filters: document.getElementById('filters'),
  year: document.getElementById('f-year'),
  kind: document.getElementById('f-kind'),
  sort: document.getElementById('f-sort'),
  reset: document.getElementById('reset'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  pager: document.getElementById('pager'),
  more: document.getElementById('more'),
  tips: document.getElementById('tips'),
  title: document.getElementById('site-title'),
  tagline: document.getElementById('site-tagline'),
  footMeta: document.getElementById('foot-meta'),
};

let db = null;
const meta = {};
let offset = 0;

function setStatus(msg, isError) {
  el.status.textContent = msg;
  el.status.classList.toggle('error', !!isError);
}

const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);

function fmtDate(iso) {
  if (!iso) return 'Undated';
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

/* ---------- loading ---------- */

async function fetchDb(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download the search index (HTTP ${res.status})`);

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());

  // Stream so a large index reports real progress instead of looking hung.
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    setStatus(`Downloading search index… ${fmtBytes(got)} of ${fmtBytes(total)}`);
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Hand the downloaded bytes to SQLite as an in-memory database. */
function openDatabase(sqlite3, bytes) {
  const handle = new sqlite3.oo1.DB();
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    handle.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  handle.checkRc(rc);
  return handle;
}

async function init() {
  try {
    setStatus('Loading search engine…');
    const sqlite3 = await sqlite3InitModule();

    const bytes = await fetchDb(DB_URL);
    setStatus('Preparing index…');
    db = openDatabase(sqlite3, bytes);

    for (const row of db.selectObjects('SELECT key, value FROM meta')) {
      meta[row.key] = row.value;
    }
    applyBranding();
    populateYears();

    el.q.disabled = false;
    el.go.disabled = false;
    el.filters.hidden = false;
    el.q.focus();

    setStatus(
      `Ready. ${Number(meta.document_count || 0).toLocaleString()} documents from ` +
      `${Number(meta.meeting_count || 0).toLocaleString()} meetings.`,
    );

    restoreFromUrl();
  } catch (err) {
    setStatus(`Search is unavailable: ${err.message}`, true);
    console.error(err);
  }
}

function applyBranding() {
  if (meta.site_title) {
    el.title.textContent = meta.site_title;
    document.title = meta.site_title;
  }
  el.tagline.textContent = meta.site_tagline || '';

  const bits = [];
  if (meta.scraped_at) bits.push(`Index updated ${fmtDate(meta.scraped_at.slice(0, 10))}`);
  if (meta.attachments_since) {
    bits.push(
      `Attachment full text covers meetings from ${fmtDate(meta.attachments_since)} onward; ` +
      'earlier meetings are searchable by agenda item.',
    );
  }
  el.footMeta.textContent = bits.join(' · ');
}

function populateYears() {
  const rows = db.selectObjects(
    'SELECT DISTINCT year FROM meetings WHERE year IS NOT NULL ORDER BY year DESC',
  );
  for (const r of rows) {
    const o = document.createElement('option');
    o.value = r.year;
    o.textContent = r.year;
    el.year.appendChild(o);
  }
}

/* ---------- query building ---------- */

/*
 * bm25 column weights: title, item_title, presenter, text.
 *
 * A hit in a document's own title is the strongest signal, and the agenda item
 * it is filed under is the next strongest. Presenter is deliberately weak: a
 * search for "sandburg" should not rank an unrelated item highly just because
 * someone's job title happens to read "Principal of Sandburg Middle School".
 */
const WEIGHTS = '8.0, 5.0, 0.3, 1.5';

const SELECT = `
SELECT d.id, d.kind, d.item_label, d.item_title, d.title, d.presenter, d.source_url,
       m.date, m.name AS meeting_name, m.title AS meeting_title, m.meeting_type,
       m.agenda_url, m.minutes_url,
       snippet(documents_fts, 3, char(1), char(2), '…', 22) AS snip,
       snippet(documents_fts, 0, char(1), char(2), '…', 40) AS tsnip,
       snippet(documents_fts, 1, char(1), char(2), '…', 24) AS isnip,
       snippet(documents_fts, 2, char(1), char(2), '…', 24) AS psnip,
       bm25(documents_fts, ${WEIGHTS}) AS rank
FROM documents_fts
JOIN documents d ON d.id = documents_fts.rowid
JOIN meetings m ON m.meeting_id = d.meeting_id
WHERE documents_fts MATCH $expr`;

function filters(state, params) {
  let sql = '';
  if (state.year) { sql += ' AND m.year = $year'; params.$year = Number(state.year); }
  if (state.kind) { sql += ' AND d.kind = $kind'; params.$kind = state.kind; }
  return sql;
}

function runQuery(state) {
  const params = { $expr: state.expr };
  let sql = SELECT + filters(state, params);
  sql += `\nORDER BY ${
    state.sort === 'newest' ? 'm.date DESC, rank'
      : state.sort === 'oldest' ? 'm.date ASC, rank'
        : 'rank'
  }`;
  sql += '\nLIMIT $limit OFFSET $offset';
  params.$limit = PAGE_SIZE;
  params.$offset = state.offset;
  return db.selectObjects(sql, params);
}

function countMatches(state) {
  const params = { $expr: state.expr };
  const sql =
    'SELECT COUNT(*) AS n FROM documents_fts ' +
    'JOIN documents d ON d.id = documents_fts.rowid ' +
    'JOIN meetings m ON m.meeting_id = d.meeting_id ' +
    'WHERE documents_fts MATCH $expr' + filters(state, params);
  return db.selectObjects(sql, params)[0]?.n ?? 0;
}

/* ---------- rendering ---------- */

const KIND_LABEL = {
  agenda_item: 'Agenda item',
  attachment: 'Attachment',
  minutes: 'Minutes',
};

function render(rows, append) {
  if (!append) el.results.innerHTML = '';
  const frag = document.createDocumentFragment();

  for (const r of rows) {
    const card = document.createElement('article');
    card.className = 'result';

    // Breadcrumb places the result within the agenda. For an attachment that
    // means "which item is this filed under"; for the item itself the title is
    // already the heading, so only its number is worth repeating.
    //
    // A term can match the agenda item or the presenter rather than the
    // document, so those are highlighted here too - otherwise a result appears
    // with no visible reason for being in the list at all.
    const itemPart = r.item_title === r.title
      ? null
      : (hasMatch(r.isnip) ? highlight(r.isnip) : esc(r.item_title));
    const crumb = [r.item_label ? esc(r.item_label) : null, itemPart]
      .filter(Boolean).join(' ');
    const presenterPart = hasMatch(r.psnip) ? highlight(r.psnip) : esc(r.presenter);

    // Highlight the match in the heading; show a body snippet only when the
    // document actually has text. An agenda item has no separate body, so
    // repeating its title underneath itself would just be noise.
    const heading = hasMatch(r.tsnip) ? highlight(r.tsnip) : esc(r.title);
    const body = r.snip?.trim() ? highlight(r.snip) : '';

    // An agenda item's "document" IS the agenda page, and a minutes result's is
    // the minutes page, so those secondary links would point where the reader
    // already is. Offer each destination once.
    const links = [];
    const seen = new Set();
    const addLink = (href, label) => {
      if (!href || seen.has(href)) return;
      seen.add(href);
      links.push(`<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`);
    };
    addLink(r.source_url, r.kind === 'attachment' ? 'Open document'
      : r.kind === 'minutes' ? 'Open minutes' : 'Open agenda item');
    addLink(r.agenda_url, 'Full agenda');
    addLink(r.minutes_url, 'Minutes');

    card.innerHTML =
      '<p class="meta">' +
        `<span class="badge ${esc(r.kind)}">${esc(KIND_LABEL[r.kind] || r.kind)}</span>` +
        `<span>${esc(fmtDate(r.date))}</span>` +
        `<span>${esc(r.meeting_name || r.meeting_title || '')}</span>` +
        (r.meeting_type ? `<span>${esc(r.meeting_type)}</span>` : '') +
      '</p>' +
      `<h3><a href="${esc(r.source_url)}" target="_blank" rel="noopener">${heading}</a></h3>` +
      (crumb || r.presenter
        ? `<p class="crumb">${[crumb, r.presenter ? presenterPart : null].filter(Boolean).join(' · ')}</p>`
        : '') +
      (body ? `<p class="snippet">${body}</p>` : '') +
      `<p class="links">${links.join('')}</p>`;

    frag.appendChild(card);
  }

  el.results.appendChild(frag);
}

/* ---------- search flow ---------- */

const currentState = (newOffset) => ({
  raw: el.q.value.trim(),
  year: el.year.value,
  kind: el.kind.value,
  sort: el.sort.value,
  offset: newOffset || 0,
});

function search(append) {
  if (!db) return;
  const state = currentState(append ? offset : 0);

  if (!state.raw) {
    el.results.innerHTML = '';
    el.pager.hidden = true;
    el.tips.hidden = false;
    setStatus('Enter a search term to begin.');
    writeUrl(state);
    return;
  }

  const { expr, reason } = toMatchExpr(state.raw);
  if (!expr) {
    el.results.innerHTML = '';
    el.pager.hidden = true;
    setStatus(reason || 'Enter a word to search for.', Boolean(reason));
    return;
  }

  state.expr = expr;
  let rows;
  try {
    rows = runQuery(state);
  } catch (err) {
    // Every term is quoted before it reaches FTS5, so this should not happen;
    // surface it rather than silently searching for something else.
    setStatus('That search could not be understood. Try plain words, or "a phrase in quotes".', true);
    console.warn(err, state.expr);
    return;
  }

  el.tips.hidden = true;
  render(rows, append);
  offset = state.offset + rows.length;

  const total = countMatches(state);
  if (total === 0) {
    setStatus(`No matches for “${state.raw}”. Try fewer or broader words.`);
    el.pager.hidden = true;
  } else {
    setStatus(
      `Showing ${Math.min(offset, total).toLocaleString()} of ${total.toLocaleString()} matching documents.`,
    );
    el.pager.hidden = offset >= total;
  }
  writeUrl(state);
}

/* ---------- url state ---------- */

function writeUrl(state) {
  const p = new URLSearchParams();
  if (state.raw) p.set('q', state.raw);
  if (state.year) p.set('year', state.year);
  if (state.kind) p.set('kind', state.kind);
  if (state.sort && state.sort !== 'rank') p.set('sort', state.sort);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function restoreFromUrl() {
  const p = new URLSearchParams(location.search);
  if (!p.has('q')) return;
  el.q.value = p.get('q') || '';
  if (p.get('year')) el.year.value = p.get('year');
  if (p.get('kind')) el.kind.value = p.get('kind');
  if (p.get('sort')) el.sort.value = p.get('sort');
  search(false);
}

/* ---------- events ---------- */

el.form.addEventListener('submit', (e) => { e.preventDefault(); search(false); });
el.more.addEventListener('click', () => search(true));
for (const n of [el.year, el.kind, el.sort]) {
  n.addEventListener('change', () => { if (el.q.value.trim()) search(false); });
}
el.reset.addEventListener('click', () => {
  el.q.value = '';
  el.year.value = '';
  el.kind.value = '';
  el.sort.value = 'rank';
  el.results.innerHTML = '';
  el.pager.hidden = true;
  el.tips.hidden = false;
  writeUrl(currentState(0));
  setStatus('Enter a search term to begin.');
  el.q.focus();
});

init();
