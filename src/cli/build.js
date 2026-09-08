#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, paths, fromRoot } from '../config.js';
import { readJson, readText, meetingsFile } from '../lib/store.js';
import { normalizeText } from '../lib/text.js';
import { log, progress } from '../lib/log.js';

const args = new Set(process.argv.slice(2));
const OUT = [...args].find((a) => a.startsWith('--out='))?.slice(6) || paths.db;

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
    INSERT INTO documents (meeting_id, kind, item_label, item_title, title, presenter,
                           source_url, pages, sort_order, text)
    VALUES (@meeting_id, @kind, @item_label, @item_title, @title, @presenter,
            @source_url, @pages, @sort_order, @text)
  `);

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

      for (const item of m.items ?? []) {
        // The agenda item itself is searchable even when nothing is attached:
        // titles, presenters and descriptions carry a lot of signal, and this
        // is what keeps pre-2021 meetings searchable without any PDF fetching.
        const body = [item.qualifier, item.description].filter(Boolean).join('\n');
        insDoc.run({
          meeting_id: m.meetingId,
          kind: 'agenda_item',
          item_label: item.label || null,
          item_title: item.title || null,
          title: item.title || 'Agenda item',
          presenter: item.presenter || null,
          source_url: m.agendaUrl,
          pages: null,
          sort_order: order++,
          text: normalizeText(body),
        });
        docCount++;
        textBytes += body.length;

        for (const att of item.attachments ?? []) {
          // Text lives in data/text/, not in meetings.json.
          const text = att.indexed ? normalizeText(readText(att.fileId) || '') : '';
          insDoc.run({
            meeting_id: m.meetingId,
            kind: 'attachment',
            item_label: item.label || null,
            item_title: item.title || null,
            title: att.name || 'Attachment',
            presenter: item.presenter || null,
            source_url: att.viewerUrl,
            pages: null,
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
        insDoc.run({
          meeting_id: m.meetingId,
          kind: 'minutes',
          item_label: null,
          item_title: 'Minutes',
          title: `Minutes - ${m.title}`,
          presenter: null,
          source_url: m.minutes.url || m.minutesUrl,
          pages: null,
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
    schema_version: '1',
  };
  const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v ?? ''));

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
