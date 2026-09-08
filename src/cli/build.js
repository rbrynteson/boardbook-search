#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, paths, fromRoot } from '../config.js';
import { readJson, readText, meetingsFile, loadState } from '../lib/store.js';
import { normalizeText } from '../lib/text.js';
import { buildAtomFeed } from '../lib/feed.js';
import { log, progress } from '../lib/log.js';

const args = new Set(process.argv.slice(2));
const OUT = [...args].find((a) => a.startsWith('--out='))?.slice(6) || paths.db;

/** How many documents the Atom feed carries. */
const FEED_SIZE = 100;

/**
 * Write the "newly indexed documents" feed alongside the static site.
 *
 * It lands in site/ (gitignored, like the vendored runtime) so that both the
 * local preview server and the deploy step - which copies site/ wholesale -
 * pick it up without any extra wiring.
 */
function writeFeed(db, meta) {
  const documents = db.prepare(`
    SELECT d.ref, d.title, d.kind, d.source_url, d.item_label, d.first_seen,
           m.date, m.name AS meeting_name
    FROM documents d JOIN meetings m ON m.meeting_id = d.meeting_id
    -- Attachments and minutes only. Agenda items are structure, not documents:
    -- a feed led by "Welcome" and "Roll Call" tells a subscriber nothing.
    WHERE d.first_seen IS NOT NULL AND d.kind IN ('attachment', 'minutes')
    -- Bucket by the DAY a document was indexed, then order by meeting date.
    -- A bulk backfill stamps thousands of documents within the same run, and it
    -- walks meetings newest-first, so the oldest meetings end up with the latest
    -- timestamps - ordering on the raw value alone would lead the feed with a
    -- 2010 document. Day buckets collapse one run into one batch; a genuinely
    -- new document lands in a later bucket and rises to the top on its own.
    ORDER BY date(d.first_seen) DESC, m.date DESC, d.sort_order
    LIMIT ?
  `).all(FEED_SIZE);

  const xml = buildAtomFeed({
    title: meta.site_title,
    subtitle: meta.site_tagline,
    siteUrl: meta.site_url,
    orgId: meta.org_id,
    documents,
  });

  const file = path.join(paths.site, 'feed.xml');
  fs.writeFileSync(file, xml, 'utf8');
  log.info(`wrote ${file} (${documents.length} entries)`);
}

function main() {
  const data = readJson(meetingsFile);
  if (!data) {
    throw new Error(`${meetingsFile} not found. Run "npm run scrape" first.`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.rmSync(OUT, { force: true });

  const db = new Database(OUT);
  db.exec(fs.readFileSync(fromRoot('src', 'db', 'schema.sql'), 'utf8'));

  const insMeeting = db.prepare(`
    INSERT INTO meetings (meeting_id, date, year, time, title, name, meeting_type, body,
                          cancelled, location, notes, agenda_url, minutes_url, packet_url,
                          item_count, docs_indexed)
    VALUES (@meeting_id, @date, @year, @time, @title, @name, @meeting_type, @body,
            @cancelled, @location, @notes, @agenda_url, @minutes_url, @packet_url,
            @item_count, @docs_indexed)
  `);

  const insDoc = db.prepare(`
    INSERT INTO documents (ref, meeting_id, kind, item_id, item_label, item_title, title,
                           presenter, source_url, pages, extract_method, first_seen,
                           sort_order, text)
    VALUES (@ref, @meeting_id, @kind, @item_id, @item_label, @item_title, @title,
            @presenter, @source_url, @pages, @extract_method, @first_seen,
            @sort_order, @text)
  `);

  // Extraction provenance and first-seen dates live in the scrape state, not in
  // meetings.json, so read them here rather than duplicating them on disk.
  const state = loadState(config.orgId);
  const docMeta = (fileId) => state.documents[fileId] ?? {};

  let docCount = 0;
  let textBytes = 0;
  const bar = progress('indexing meetings', data.meetings.length);

  const load = db.transaction((meetings) => {
    for (const m of meetings) {
      insMeeting.run({
        meeting_id: m.meetingId,
        date: m.date ?? null,
        year: m.date ? Number(m.date.slice(0, 4)) : null,
        time: m.time ?? null,
        title: m.title,
        name: m.name ?? null,
        meeting_type: m.meetingType ?? null,
        body: m.body ?? 'board',
        cancelled: m.cancelled ? 1 : 0,
        location: m.location ?? null,
        notes: m.notes ?? null,
        agenda_url: m.agendaUrl ?? null,
        minutes_url: m.minutesUrl ?? null,
        packet_url: m.packetUrl ?? null,
        item_count: m.items?.length ?? 0,
        docs_indexed: m.documentsIndexed ? 1 : 0,
      });

      let order = 0;

      // Agenda items have no file of their own, so they inherit the date the
      // meeting was first scraped. Attachments and minutes prefer their own
      // per-document firstSeen and fall back to this.
      const meetingFirstSeen = state.meetings[m.meetingId]?.scrapedAt ?? null;

      for (const item of m.items ?? []) {
        // The agenda item itself is searchable even when nothing is attached:
        // titles, presenters and descriptions carry a lot of signal, and this
        // is what keeps pre-2021 meetings searchable without any PDF fetching.
        const body = [item.qualifier, item.description].filter(Boolean).join('\n');
        insDoc.run({
          ref: `i${item.itemId}`,
          meeting_id: m.meetingId,
          kind: 'agenda_item',
          item_id: item.itemId ?? null,
          item_label: item.label || null,
          item_title: item.title || null,
          title: item.title || 'Agenda item',
          presenter: item.presenter || null,
          source_url: m.agendaUrl,
          pages: null,
          extract_method: null,
          first_seen: meetingFirstSeen,
          sort_order: order++,
          text: normalizeText(body),
        });
        docCount++;
        textBytes += body.length;

        for (const att of item.attachments ?? []) {
          // Text lives in data/text/, not in meetings.json.
          const text = att.indexed ? normalizeText(readText(att.fileId) || '') : '';
          const meta = docMeta(att.fileId);
          insDoc.run({
            ref: `f${att.fileId}`,
            meeting_id: m.meetingId,
            kind: 'attachment',
            item_id: item.itemId ?? null,
            item_label: item.label || null,
            item_title: item.title || null,
            title: att.name || 'Attachment',
            presenter: item.presenter || null,
            source_url: att.viewerUrl,
            pages: meta.pages ?? null,
            extract_method: meta.method ?? null,
            first_seen: meta.firstSeen ?? meetingFirstSeen,
            sort_order: order++,
            text,
          });
          docCount++;
          textBytes += text.length;
        }
      }

      if (m.minutes) {
        const text = m.minutes.textKey
          ? normalizeText(readText(m.minutes.textKey) || '')
          : '';
        // Keyed by meeting, not by file: approving draft minutes replaces the
        // file (and its id), and a saved reference has to survive that.
        const meta = docMeta(m.minutes.fileId);
        insDoc.run({
          ref: `m${m.meetingId}`,
          meeting_id: m.meetingId,
          kind: 'minutes',
          item_id: null,
          item_label: null,
          item_title: 'Minutes',
          title: `Minutes - ${m.title}`,
          presenter: null,
          source_url: m.minutes.url || m.minutesUrl,
          pages: meta.pages ?? null,
          extract_method: meta.method ?? null,
          first_seen: meta.firstSeen ?? meetingFirstSeen,
          sort_order: 10_000,
          text,
        });
        docCount++;
        textBytes += text.length;
      }

      bar.tick(m.date ?? '');
    }
  });

  load(data.meetings);
  bar.done();

  log.step('Building FTS index');
  db.exec(`INSERT INTO documents_fts(rowid, title, item_title, presenter, text)
           SELECT id, title, item_title, presenter, text FROM documents`);
  db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('optimize')`);

  const one = (sql) => db.prepare(sql).get().n;

  const meta = {
    org_id: config.orgId,
    org_name: config.orgName,
    org_short_name: config.orgShortName ?? config.orgName,
    site_title: config.siteTitle ?? `${config.orgName} Document Search`,
    site_tagline: config.siteTagline ?? '',
    base_url: config.baseUrl,
    generated_at: new Date().toISOString(),
    scraped_at: data.generatedAt ?? '',
    attachments_since: data.attachmentsSinceDate ?? '',
    meeting_count: String(data.meetings.length),
    document_count: String(docCount),
    site_url: config.siteUrl ?? '',
    // Coverage figures, so the page can be honest about what is and is not
    // searchable rather than leaving the reader to guess.
    documents_with_text: String(one('SELECT COUNT(*) n FROM documents WHERE LENGTH(text) > 0')),
    documents_ocr: String(one("SELECT COUNT(*) n FROM documents WHERE extract_method LIKE '%ocr%'")),
    meetings_with_documents: String(one('SELECT COUNT(*) n FROM meetings WHERE docs_indexed = 1')),
    schema_version: '2',
  };
  const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v ?? ''));

  writeFeed(db, meta);

  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('VACUUM');
  db.close();

  const bytes = fs.statSync(OUT).size;
  log.step('Database built');
  log.info(`${OUT}`);
  log.info(`meetings=${data.meetings.length} documents=${docCount} text=${(textBytes / 1e6).toFixed(2)}MB`);
  log.info(`file size=${(bytes / 1e6).toFixed(2)}MB on disk, roughly ${(bytes / 3e6).toFixed(2)}MB over the wire once the host gzips it`);
}

try {
  main();
} catch (err) {
  log.error(err.stack || err.message);
  process.exit(1);
}
