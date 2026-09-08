/*
 * BoardBook document search - runs entirely in the visitor's browser.
 *
 * Uses the official SQLite WebAssembly build (vendored under vendor/) rather
 * than sql.js, because the stock sql.js distribution is compiled without FTS5
 * and every query here depends on it.
 */
import sqlite3InitModule from './vendor/index.mjs';
import { escapeHtml as esc, highlight, hasMatch } from './markup.js';
import { toMatchExpr, canRelax } from './query.js';
import {
  loadStars, toggleStar, clearStars, encodeStars, decodeStars, mergeStars, MAX_STARS,
} from './favorites.js';

const DB_URL = 'site.db';
const PAGE_SIZE = 25;
// Below this many strict (AND) matches, fall back to relaxed OR ranking.
const RELAX_THRESHOLD = 5;

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
  explain: document.getElementById('explain'),
  showStarred: document.getElementById('show-starred'),
  starCount: document.getElementById('star-count'),
  starTools: document.getElementById('star-tools'),
  shareStars: document.getElementById('share-stars'),
  copyStars: document.getElementById('copy-stars'),
  clearStars: document.getElementById('clear-stars'),
  showBrowse: document.getElementById('show-browse'),
  coverageBody: document.getElementById('coverage-body'),
  title: document.getElementById('site-title'),
  tagline: document.getElementById('site-tagline'),
  footMeta: document.getElementById('foot-meta'),
};

let db = null;
const meta = {};
let offset = 0;
// Mirror of the stored stars, as a Set for cheap per-row lookup while rendering.
let stars = new Set();

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
    stars = new Set(loadStars());
    refreshStarUi();
    renderCoverage();

    el.q.disabled = false;
    el.go.disabled = false;
    el.filters.hidden = false;
    el.q.focus();

    setStatus(
      `Ready. ${Number(meta.document_count || 0).toLocaleString()} documents from ` +
      `${Number(meta.meeting_count || 0).toLocaleString()} meetings.`,
    );

    // A shared collection arrives in the fragment and takes precedence over a
    // query string, since the visitor followed that link deliberately.
    const shared = /^#stars=(.+)$/.exec(location.hash);
    if (!shared || !openSharedCollection(shared[1])) restoreFromUrl();
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
SELECT d.id, d.ref, d.kind, d.item_id, d.item_label, d.item_title, d.title,
       d.presenter, d.source_url, d.extract_method,
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
      // Compare without the fragment: an agenda item's deep link and the plain
      // agenda page are the same destination, and offering both is the
      // duplicate-link problem all over again.
      const key = href?.split('#')[0];
      if (!href || seen.has(key)) return;
      seen.add(key);
      links.push(`<a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`);
    };

    // BoardBook gives every agenda row an id="<itemId>" anchor, so a link can
    // land on the item itself instead of the top of a very long agenda.
    const deepAgenda = agendaLink(r);
    const primaryUrl = r.kind === 'agenda_item' ? (deepAgenda || r.source_url) : r.source_url;

    addLink(primaryUrl, r.kind === 'attachment' ? 'Open document'
      : r.kind === 'minutes' ? 'Open minutes' : 'Open agenda item');
    addLink(deepAgenda, 'Full agenda');
    addLink(r.minutes_url, 'Minutes');

    // 779 documents in this index were read by OCR. Saying so is a correctness
    // matter for a public-records tool, not decoration.
    const ocr = /ocr/.test(r.extract_method || '');
    const starred = stars.has(r.ref);

    card.innerHTML =
      '<p class="meta">' +
        `<span class="badge ${esc(r.kind)}">${esc(KIND_LABEL[r.kind] || r.kind)}</span>` +
        `<span>${esc(fmtDate(r.date))}</span>` +
        `<span>${esc(r.meeting_name || r.meeting_title || '')}</span>` +
        (r.meeting_type ? `<span>${esc(r.meeting_type)}</span>` : '') +
        (ocr ? '<span class="badge ocr" title="This text was recognised from a scanned image and may contain errors.">OCR text</span>' : '') +
        `<button type="button" class="star${starred ? ' on' : ''}" data-ref="${esc(r.ref)}"` +
          ` aria-pressed="${starred}" title="Star this document">` +
          `<span aria-hidden="true">${starred ? '★' : '☆'}</span>` +
          `<span class="sr-only">Star ${esc(r.title)}</span></button>` +
      '</p>' +
      `<h3><a href="${esc(primaryUrl)}" target="_blank" rel="noopener">${heading}</a></h3>` +
      (crumb || r.presenter
        ? `<p class="crumb">${[crumb, r.presenter ? presenterPart : null].filter(Boolean).join(' · ')}</p>`
        : '') +
      (body ? `<p class="snippet">${body}</p>` : '') +
      `<p class="links">${links.join('')}</p>`;

    frag.appendChild(card);
  }

  el.results.appendChild(frag);
}

/** Agenda URL, deep-linked to the item's own row where we know it. */
function agendaLink(r) {
  if (!r.agenda_url) return null;
  return r.item_id ? `${r.agenda_url}#${encodeURIComponent(r.item_id)}` : r.agenda_url;
}

/* ---------- starred documents ---------- */

let starredView = false;

function refreshStarUi() {
  el.starCount.textContent = String(stars.size);
  el.showStarred.setAttribute('aria-pressed', String(starredView));
  el.starTools.hidden = !starredView || stars.size === 0;
}

/** Look up starred documents by ref. No FTS involved, so there are no snippets. */
function starredRows() {
  if (!stars.size) return [];
  const refs = [...stars];
  const holes = refs.map((_, i) => `$r${i}`).join(', ');
  const params = Object.fromEntries(refs.map((r, i) => [`$r${i}`, r]));
  return db.selectObjects(
    `SELECT d.id, d.ref, d.kind, d.item_id, d.item_label, d.item_title, d.title,
            d.presenter, d.source_url, d.extract_method,
            m.date, m.name AS meeting_name, m.title AS meeting_title, m.meeting_type,
            m.agenda_url, m.minutes_url
     FROM documents d JOIN meetings m ON m.meeting_id = d.meeting_id
     WHERE d.ref IN (${holes})
     ORDER BY m.date DESC, d.sort_order`,
    params,
  );
}

function showStarred() {
  starredView = true;
  el.tips.hidden = true;
  el.explain.hidden = true;
  el.pager.hidden = true;

  const rows = starredRows();
  render(rows, false);
  refreshStarUi();

  const missing = stars.size - rows.length;
  setStatus(
    stars.size === 0
      ? 'No starred documents yet. Use the ☆ on any result to start a collection.'
      : `${rows.length} starred document${rows.length === 1 ? '' : 's'}.` +
        // A star can outlive its document if BoardBook removes it and a later
        // scrape drops it from the index. Say so rather than quietly showing fewer.
        (missing > 0 ? ` ${missing} no longer in the index.` : ''),
  );
}

function leaveStarredView() {
  if (!starredView) return;
  starredView = false;
  refreshStarUi();
}

/** Toggle a star from the delegated click on a result card. */
function onStarClick(button) {
  const ref = button.dataset.ref;
  const { stars: next, starred, full, stored } = toggleStar(ref);
  stars = new Set(next);

  if (full) {
    setStatus(`You can star up to ${MAX_STARS} documents. Remove some first.`, true);
    return;
  }
  if (!stored) {
    setStatus('This browser is not allowing local storage, so stars cannot be saved.', true);
  }

  button.classList.toggle('on', starred);
  button.setAttribute('aria-pressed', String(starred));
  button.querySelector('span[aria-hidden]').textContent = starred ? '★' : '☆';
  refreshStarUi();

  // Unstarring from within the collection should remove the card immediately.
  if (starredView && !starred) showStarred();
}

async function copyToClipboard(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(okMessage);
  } catch {
    setStatus('Could not copy automatically - select the link in the address bar instead.', true);
  }
}

function shareStars() {
  const url = `${location.origin}${location.pathname}#stars=${encodeStars([...stars])}`;
  copyToClipboard(url, `Share link copied - ${stars.size} document${stars.size === 1 ? '' : 's'}.`);
}

/** Plain-text export, for pasting into an email or board notes. */
function copyStarsAsList() {
  const lines = starredRows().map((r) => `- ${r.title} (${fmtDate(r.date)}) ${r.source_url}`);
  copyToClipboard(lines.join('\n'), `Copied ${lines.length} document${lines.length === 1 ? '' : 's'}.`);
}

/* ---------- browse by meeting ---------- */

let browseView = false;

/** Meetings newest first. Search only helps when you know the words. */
function showBrowse() {
  browseView = true;
  leaveStarredView();
  el.tips.hidden = true;
  el.explain.hidden = true;
  el.pager.hidden = true;
  el.showBrowse.setAttribute('aria-pressed', 'true');

  const rows = db.selectObjects(`
    SELECT m.meeting_id, m.date, m.name, m.title, m.meeting_type, m.cancelled,
           m.agenda_url, m.minutes_url, m.item_count,
           (SELECT COUNT(*) FROM documents d
             WHERE d.meeting_id = m.meeting_id AND d.kind = 'attachment') AS attachments
    FROM meetings m
    WHERE m.date IS NOT NULL
    ORDER BY m.date DESC
    LIMIT 400
  `);

  el.results.innerHTML = rows.map((m) => `
    <article class="result meeting">
      <p class="meta">
        <span>${esc(fmtDate(m.date))}</span>
        ${m.meeting_type ? `<span>${esc(m.meeting_type)}</span>` : ''}
        ${m.cancelled ? '<span class="badge">Cancelled</span>' : ''}
      </p>
      <h3><button type="button" class="linkish open-meeting" data-meeting="${esc(m.meeting_id)}">${esc(m.name || m.title)}</button></h3>
      <p class="crumb">${m.item_count} agenda item${m.item_count === 1 ? '' : 's'}${
        m.attachments ? ` · ${m.attachments} document${m.attachments === 1 ? '' : 's'}` : ' · no documents indexed'
      }</p>
    </article>`).join('');

  setStatus(`Browsing ${rows.length} most recent meetings. Choose one to see its documents.`);
}

/** Everything filed under one meeting, in agenda order. */
function showMeeting(meetingId) {
  const rows = db.selectObjects(`
    SELECT d.id, d.ref, d.kind, d.item_id, d.item_label, d.item_title, d.title,
           d.presenter, d.source_url, d.extract_method,
           m.date, m.name AS meeting_name, m.title AS meeting_title, m.meeting_type,
           m.agenda_url, m.minutes_url
    FROM documents d JOIN meetings m ON m.meeting_id = d.meeting_id
    WHERE d.meeting_id = $id
    ORDER BY d.sort_order`, { $id: meetingId });

  render(rows, false);
  const when = rows[0] ? `${rows[0].meeting_name || ''} — ${fmtDate(rows[0].date)}` : '';
  setStatus(`${rows.length} item${rows.length === 1 ? '' : 's'} in this meeting. ${when}`);
}

function leaveBrowseView() {
  browseView = false;
  el.showBrowse.setAttribute('aria-pressed', 'false');
}

/* ---------- coverage ---------- */

/**
 * Say plainly what is and is not searchable. Full text only goes back to
 * `attachments_since`, and a fifth of it came from OCR - a reader comparing
 * this index against the record deserves to know both.
 */
function renderCoverage() {
  const years = db.selectObjects(`
    SELECT m.year,
           COUNT(DISTINCT m.meeting_id) AS meetings,
           SUM(CASE WHEN m.docs_indexed = 1 THEN 1 ELSE 0 END) AS with_docs
    FROM meetings m WHERE m.year IS NOT NULL
    GROUP BY m.year ORDER BY m.year DESC`);

  const n = (k) => Number(meta[k] || 0).toLocaleString();
  const since = meta.attachments_since ? fmtDate(meta.attachments_since) : null;

  el.coverageBody.innerHTML = `
    <ul>
      <li><strong>${n('meeting_count')}</strong> meetings and
          <strong>${n('document_count')}</strong> searchable items in total.</li>
      <li><strong>${n('documents_with_text')}</strong> have extracted text;
          <strong>${n('documents_ocr')}</strong> of those were read by OCR from scanned
          images and may contain recognition errors.</li>
      ${since ? `<li>Full document text covers meetings from <strong>${esc(since)}</strong>
          onward (<strong>${n('meetings_with_documents')}</strong> meetings). Earlier meetings
          are searchable by agenda item, presenter and description only.</li>` : ''}
      <li>The originals on BoardBook are always authoritative. This index is a finding aid.</li>
    </ul>
    <table class="coverage-table">
      <thead><tr><th>Year</th><th>Meetings</th><th>With document text</th></tr></thead>
      <tbody>${years.map((y) => `
        <tr><td>${y.year}</td><td>${y.meetings}</td><td>${y.with_docs || '—'}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

/** A #stars=… link opens as a read-only view of someone else's collection. */
function openSharedCollection(encoded) {
  const incoming = decodeStars(encoded);
  if (!incoming.length) return false;

  const { added } = mergeStars(incoming);
  stars = new Set(loadStars());
  showStarred();
  setStatus(
    added === 0
      ? `Opened a shared collection of ${incoming.length} document${incoming.length === 1 ? '' : 's'} - you already had them all starred.`
      : `Opened a shared collection and added ${added} document${added === 1 ? '' : 's'} to your stars.`,
  );
  return true;
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

  const strict = toMatchExpr(state.raw);
  if (!strict.expr) {
    el.results.innerHTML = '';
    el.pager.hidden = true;
    el.explain.hidden = true;
    setStatus(strict.reason || 'Enter a word to search for.', Boolean(strict.reason));
    return;
  }

  let plan = strict;
  let exactCount = null;

  // A question rarely has every one of its words in one document. When a strict
  // AND finds almost nothing, fall back to OR and let bm25 ranking do the work -
  // it puts documents matching the most terms first. Relaxing only at zero
  // results is not enough: "what did the board decide about the bond
  // referendum" returns four largely unrelated documents under a strict AND,
  // while the relaxed ranking surfaces the actual referendum papers.
  if (!append && canRelax(state.raw)) {
    exactCount = countMatches({ ...state, expr: strict.expr });
    if (exactCount < RELAX_THRESHOLD) plan = toMatchExpr(state.raw, { mode: 'relaxed' });
  }

  state.expr = plan.expr;
  state.relaxed = plan.relaxed;
  state.exactCount = exactCount;

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
  explainSearch(plan, state);
  writeUrl(state);
}

/** Say which words were actually searched, so a surprising result set is not a mystery. */
function explainSearch(plan, state) {
  const tidy = (list) => [...new Set(
    list.map((w) => w.replace(/[^\p{L}\p{N}*]+$/u, '')).filter(Boolean),
  )];

  const used = tidy(plan.used);
  const dropped = tidy(plan.dropped);
  const bits = [];

  if (dropped.length) {
    bits.push(`Searched for <strong>${used.map(esc).join(', ')}</strong> · ignored ${dropped.map(esc).join(', ')}`);
  }
  if (state.relaxed) {
    const exact = state.exactCount === 0
      ? 'No document contains every one of those words'
      : state.exactCount === 1
        ? 'Only 1 document contains every one of those words'
        : `Only ${state.exactCount} documents contain every one of those words`;
    bits.push(`${exact}, so the closest matches are shown first.`);
  }

  el.explain.innerHTML = bits.join(' — ');
  el.explain.hidden = bits.length === 0;
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

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  leaveStarredView();
  leaveBrowseView();
  search(false);
});
el.more.addEventListener('click', () => search(true));

// Stars are delegated: result cards are replaced wholesale on every render.
el.results.addEventListener('click', (e) => {
  const button = e.target.closest('.star');
  if (button) onStarClick(button);
});

el.showStarred.addEventListener('click', () => {
  if (starredView) {
    leaveStarredView();
    if (el.q.value.trim()) search(false);
    else {
      el.results.innerHTML = '';
      el.tips.hidden = false;
      setStatus('Enter a search term to begin.');
    }
  } else {
    showStarred();
  }
});

el.showBrowse.addEventListener('click', () => {
  if (browseView) {
    leaveBrowseView();
    el.results.innerHTML = '';
    el.tips.hidden = false;
    setStatus('Enter a search term to begin.');
  } else {
    showBrowse();
  }
});

el.results.addEventListener('click', (e) => {
  const open = e.target.closest('.open-meeting');
  if (open) showMeeting(open.dataset.meeting);
});

el.shareStars.addEventListener('click', shareStars);
el.copyStars.addEventListener('click', copyStarsAsList);
el.clearStars.addEventListener('click', () => {
  if (!stars.size) return;
  // Small, reversible-by-re-starring, but still worth a confirm - it is the one
  // action here that destroys something the visitor built up.
  if (!confirm(`Remove all ${stars.size} starred documents?`)) return;
  clearStars();
  stars = new Set();
  showStarred();
});
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
