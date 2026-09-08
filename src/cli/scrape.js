#!/usr/bin/env node
import { config, paths, urls } from '../config.js';
import { fetchMeetingList } from '../scrape/meetings.js';
import { fetchAgenda } from '../scrape/agenda.js';
import { fetchMinutes } from '../scrape/minutes.js';
import { fetchBuffer } from '../lib/http.js';
import { extractDocumentText } from '../extract/index.js';
import { ocrAvailable } from '../extract/ocr.js';
import {
  loadState, saveState, writeText, hasText,
  writePdf, writeJson, readJson, sha1, meetingsFile,
} from '../lib/store.js';
import { log, progress } from '../lib/log.js';

const args = new Set(process.argv.slice(2));
const flag = (name) => args.has(`--${name}`);
const optValue = (name) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const FULL = flag('full');                       // ignore incremental state
const SKIP_DOCS = flag('skip-documents');        // metadata only, no PDFs
const KEEP_PDFS = flag('keep-pdfs');
const DRY_RUN = flag('dry-run');                 // resolve scope, fetch nothing else
const LIMIT = Number(optValue('limit') || 0);    // cap meetings processed (testing)
const SINCE = optValue('since') || config.attachmentsSinceDate;

/**
 * Which meetings to consider at all, as an ISO date or null for "everything".
 * `--months=6` is the shorthand worth reaching for when trying this out: it
 * keeps a first run to a handful of meetings instead of sixteen years of them.
 */
function resolveMeetingsSince() {
  const months = Number(optValue('months') || 0);
  if (months > 0) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  }
  return optValue('meetings-since') || config.meetingsSinceDate || null;
}

const MEETINGS_SINCE = resolveMeetingsSince();
// Wall-clock budget. The first backfill of a 16-year archive takes many hours,
// so a run stops cleanly at the budget and the next run resumes from state.
const MAX_SECONDS = Number(optValue('max-seconds') || 0);
const deadline = MAX_SECONDS ? Date.now() + MAX_SECONDS * 1000 : Infinity;

// Minutes are drafted, then approved a meeting or two later, so a recent
// meeting's minutes can still change. Past this window they are settled and
// re-fetching them on every weekly run is wasted load on BoardBook.
const SETTLED_DAYS = 120;
const SETTLED_BEFORE = new Date(Date.now() - SETTLED_DAYS * 86_400_000)
  .toISOString().slice(0, 10);

// Whether this run can actually read scanned pages. Resolved once in main().
let ocrReady = false;

/**
 * Does this document have scanned pages that no run has yet been able to read?
 *
 * Checked by every cache shortcut, not just extractDocument: a meeting whose
 * agenda is unchanged, and minutes that are past the "settled" window, are both
 * served straight from the cache, so without this they would skip the very
 * documents OCR was installed to rescue.
 */
const needsOcrRetry = (fileId, state) =>
  ocrReady && Boolean(state.documents[fileId]?.ocrPending);

const inScopeForDocs = (meeting) => {
  if (SKIP_DOCS) return false;
  if (!SINCE) return true;
  return !meeting.date || meeting.date >= SINCE;
};

/**
 * Print what a run would do, without fetching anything past the meeting index.
 * Worth checking before a long backfill, since a full archive is hours of work.
 */
function reportPlan(meetings, state) {
  const withMinutes = meetings.filter((m) => m.minutesUrl).length;
  const withDocs = meetings.filter(inScopeForDocs).length;
  const alreadyScraped = meetings.filter((m) => state.meetings[m.meetingId]).length;

  // Attachments per meeting are only known after fetching each agenda, so use
  // what we have already seen for this org and fall back to a stated guess.
  const priorMeetings = readJson(meetingsFile)?.meetings ?? [];
  const sampled = priorMeetings.filter((m) => m.items?.length);
  const perMeeting = sampled.length
    ? sampled.reduce((s, m) => s + m.items.reduce((t, i) => t + (i.attachments?.length ?? 0), 0), 0) / sampled.length
    : 16;

  const cachedDocs = Object.values(state.documents).filter((d) => !d.failed).length;
  const newMeetings = meetings.length - alreadyScraped;
  // Only meetings that are both new and inside the attachment window cost
  // PDF requests; older ones are indexed from their agenda page alone.
  const newWithDocs = meetings.filter((m) => !state.meetings[m.meetingId] && inScopeForDocs(m)).length;
  const estAttachments = Math.round(newWithDocs * perMeeting);
  const estRequests = meetings.length + withMinutes + estAttachments;
  const estSeconds = (estRequests * config.requestDelayMs) / 1000;
  const hrs = Math.floor(estSeconds / 3600);
  const mins = Math.round((estSeconds % 3600) / 60);

  log.step('Dry run - nothing was downloaded beyond the meeting index');
  log.info(`meetings in scope   ${meetings.length}` +
           (meetings.length ? ` (${meetings.at(-1).date} .. ${meetings[0].date})` : ''));
  log.info(`  with minutes      ${withMinutes}`);
  log.info(`  attachments in scope (>= ${SINCE ?? 'all'})  ${withDocs}`);
  log.info(`  already scraped   ${alreadyScraped}  (would be skipped or revalidated)`);
  log.info(`  new this run      ${newMeetings}  (${newWithDocs} of them need PDFs)`);
  log.info(`documents already cached  ${cachedDocs}`);
  log.info(`estimated new requests    ~${estRequests.toLocaleString()} ` +
           `(assuming ~${perMeeting.toFixed(0)} attachments per meeting)`);
  log.info(`estimated wall time       ~${hrs ? `${hrs}h ` : ''}${mins}m at ${config.requestDelayMs}ms between requests`);
  log.info('Re-run without --dry-run to start. Add --max-seconds=N to work in chunks.');
}

/**
 * Ensure a document's text is present in the cache under `fileId`.
 *
 * Returns whether text is available rather than the text itself: meetings.json
 * records only references, so the text lives in exactly one place
 * (data/text/<fileId>.txt) and the build step reads it from there. That keeps
 * meetings.json small and append-friendly in git, instead of a multi-megabyte
 * file that is rewritten wholesale on every run.
 */
async function extractDocument(fileId, url, label, state, stats) {
  const prior = state.documents[fileId];

  // A document whose scanned pages were never read is not really "done". If it
  // was extracted somewhere without tesseract - a laptop, say - and this run
  // does have OCR, retry it. Otherwise the empty result from the first machine
  // is cached forever and the scanned minutes stay invisible.
  const retryForOcr = needsOcrRetry(fileId, state);

  if (!FULL && prior && !prior.failed && hasText(fileId) && !retryForOcr) {
    stats.cached += 1;
    return true;
  }
  if (retryForOcr) stats.ocrRetried += 1;

  const { buffer, bytes, tooLarge, contentType } = await fetchBuffer(url, {
    maxBytes: config.maxAttachmentBytes,
  });

  if (tooLarge) {
    log.warn(`${label}: ${(bytes / 1e6).toFixed(1)}MB exceeds maxAttachmentBytes; skipping`);
    state.documents[fileId] = { failed: 'too-large', bytes, extractedAt: new Date().toISOString() };
    stats.skipped += 1;
    return false;
  }

  if (KEEP_PDFS) await writePdf(fileId, buffer);

  const result = await extractDocumentText(buffer, { label, contentType });
  await writeText(fileId, result.text);

  state.documents[fileId] = {
    hash: sha1(buffer),
    bytes,
    chars: result.text.length,
    pages: result.pages,
    method: result.method,
    note: result.note || undefined,
    ocrPending: result.ocrPending || undefined,
    // Set once, on first sight, and carried through every re-extraction - an
    // OCR retry must not make a 2019 document look newly published.
    firstSeen: prior?.firstSeen ?? new Date().toISOString(),
    extractedAt: new Date().toISOString(),
  };

  stats.fetched += 1;
  stats.chars += result.text.length;
  stats.byMethod[result.method] = (stats.byMethod[result.method] || 0) + 1;
  return true;
}

async function main() {
  log.step(`BoardBook scrape - org ${config.orgId} (${config.orgName})`);
  if (config.ocr?.enabled) {
    const a = await ocrAvailable();
    ocrReady = a.ok;
    log.info(a.ok ? 'OCR enabled (pdftoppm + tesseract found)' : 'OCR enabled in config but tooling missing - scanned pages will be skipped');
  }

  const state = loadState(config.orgId);
  if (FULL) log.info('--full: ignoring incremental state');

  let meetings = await fetchMeetingList();
  if (MEETINGS_SINCE) {
    const before = meetings.length;
    // Undated meetings are rare (cancelled rows); drop them when a window is
    // set rather than silently pulling the whole archive back in.
    meetings = meetings.filter((m) => m.date && m.date >= MEETINGS_SINCE);
    log.info(`meetings since ${MEETINGS_SINCE}: ${meetings.length}/${before} in scope`);
  }
  if (LIMIT) {
    meetings = meetings.slice(0, LIMIT);
    log.info(`--limit=${LIMIT}: processing newest ${meetings.length} meetings`);
  }

  if (DRY_RUN) {
    reportPlan(meetings, state);
    return;
  }

  const docStats = { fetched: 0, cached: 0, skipped: 0, ocrRetried: 0, chars: 0, byMethod: {} };
  const bar = progress('meetings', meetings.length);
  const records = [];

  // Previously scraped records, keyed by meeting id. Used both to survive a
  // transient failure mid-run and to carry forward meetings a budgeted run
  // never reached.
  const priorFile = readJson(meetingsFile);
  const priorRecords = new Map((priorFile?.meetings ?? []).map((m) => [m.meetingId, m]));

  let stoppedEarly = false;
  for (const meeting of meetings) {
    if (Date.now() > deadline) {
      stoppedEarly = true;
      log.warn(
        `Time budget of ${MAX_SECONDS}s reached after ${records.length} meetings; ` +
        'stopping cleanly (state saved, next run resumes where this left off)'
      );
      break;
    }
    const wantDocs = inScopeForDocs(meeting);
    const prior = state.meetings[meeting.meetingId];

    let agenda = null;
    try {
      agenda = await fetchAgenda(meeting.meetingId);
    } catch (err) {
      log.warn(`meeting ${meeting.meetingId}: agenda fetch failed - ${err.message}`);
    }

    // A transient failure must not overwrite a meeting we already indexed.
    // Leave both the state entry and the previous record untouched; the
    // carry-forward below will preserve it and the next run will retry.
    if (!agenda) {
      if (priorRecords.has(meeting.meetingId)) {
        log.debug(`meeting ${meeting.meetingId}: keeping previously scraped record`);
      } else {
        records.push({ ...meeting, items: [], minutes: null, documentsIndexed: false });
      }
      bar.tick(`${meeting.date} (agenda unavailable)`);
      continue;
    }

    const agendaHash = sha1(JSON.stringify(agenda.items));
    // A meeting whose agenda is unchanged and whose documents were already
    // extracted needs no further network work.
    const unchanged = !FULL && prior?.agendaHash === agendaHash && prior?.docsComplete === wantDocs;

    // Minutes
    let minutes = null;
    try {
      if (meeting.minutesUrl) {
        // Minutes for a recent meeting change as drafts get approved, so those
        // are always re-checked. Once a meeting is well past that window and we
        // already hold its minutes, re-requesting them every week is pure load.
        const settled = SETTLED_BEFORE && meeting.date && meeting.date < SETTLED_BEFORE;
        const cachedMinutes = unchanged && settled && prior?.minutesFileId
          && hasText(prior.minutesFileId)
          && !needsOcrRetry(prior.minutesFileId, state);

        if (cachedMinutes) {
          minutes = {
            kind: 'pdf',
            title: 'Minutes',
            url: meeting.minutesUrl,
            fileId: prior.minutesFileId,
            textKey: prior.minutesFileId,
          };
          docStats.cached += 1;
        } else {
          const mi = await fetchMinutes(meeting.meetingId);
          minutes = {
            kind: mi.kind,
            title: mi.title,
            url: meeting.minutesUrl,
            fileId: mi.fileId ?? null,
            textKey: null,
          };

          if (mi.text) {
            // Generated HTML minutes: no file id, so cache under the meeting.
            const key = `minutes-${meeting.meetingId}`;
            await writeText(key, mi.text);
            minutes.textKey = key;
          } else if (wantDocs && mi.buffer) {
            // Some orgs return the minutes PDF straight from the redirect.
            const key = `minutes-${meeting.meetingId}`;
            const r = await extractDocumentText(mi.buffer, { label: `minutes ${meeting.date}` });
            await writeText(key, r.text);
            minutes.textKey = key;
            docStats.byMethod[r.method] = (docStats.byMethod[r.method] || 0) + 1;
          } else if (wantDocs && mi.fileId) {
            const ok = await extractDocument(
              mi.fileId, mi.pdfUrl, `minutes ${meeting.date}`, state, docStats
            );
            if (ok) minutes.textKey = mi.fileId;
          }
        }
      }
    } catch (err) {
      log.warn(`meeting ${meeting.meetingId}: minutes failed - ${err.message}`);
    }

    // Attachments. Text is cached under the file id; the record keeps only the
    // reference, so meetings.json stays small.
    for (const item of agenda.items) {
      for (const att of item.attachments) {
        if (!wantDocs) { att.indexed = false; continue; }
        if (unchanged && hasText(att.fileId) && !needsOcrRetry(att.fileId, state)) {
          att.indexed = true;
          docStats.cached += 1;
          continue;
        }
        try {
          att.indexed = await extractDocument(
            att.fileId, att.pdfUrl, `${meeting.date} ${att.name}`.slice(0, 70), state, docStats
          );
        } catch (err) {
          log.warn(`attachment ${att.fileId} failed - ${err.message}`);
          att.indexed = false;
          state.documents[att.fileId] = { failed: err.message.slice(0, 120), extractedAt: new Date().toISOString() };
        }
      }
    }

    state.meetings[meeting.meetingId] = {
      agendaHash,
      itemCount: agenda.items.length,
      minutesFileId: minutes?.fileId ?? null,
      docsComplete: wantDocs,
      scrapedAt: new Date().toISOString(),
    };

    records.push({ ...meeting, packetUrl: agenda.packetUrl, items: agenda.items, minutes, documentsIndexed: wantDocs });
    bar.tick(`${meeting.date} ${meeting.name ?? ''}`);

    // Persist as we go so a CI timeout still leaves usable progress.
    if (records.length % 25 === 0) await saveState(state);
  }
  bar.done();

  await saveState(state);

  // Carry forward meetings this run did not reach so a budgeted or limited run
  // never drops data that was already indexed.
  if (priorRecords.size) {
    const seen = new Set(records.map((r) => r.meetingId));
    const carried = [...priorRecords.values()].filter((m) => !seen.has(m.meetingId));
    if (carried.length) {
      log.info(`carrying forward ${carried.length} previously scraped meeting(s)`);
      records.push(...carried);
    }
  }
  records.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  await writeJson(meetingsFile, {
    orgId: config.orgId,
    orgName: config.orgName,
    baseUrl: config.baseUrl,
    generatedAt: new Date().toISOString(),
    attachmentsSinceDate: SINCE,
    meetings: records,
  });

  const items = records.reduce((s, m) => s + m.items.length, 0);
  const atts = records.reduce((s, m) => s + m.items.reduce((t, i) => t + i.attachments.length, 0), 0);
  log.step('Scrape complete');
  log.info(`meetings=${records.length} items=${items} attachments=${atts}`);
  log.info(`documents: fetched=${docStats.fetched} cached=${docStats.cached} skipped=${docStats.skipped} ocr-retried=${docStats.ocrRetried} text=${(docStats.chars / 1e6).toFixed(2)}M chars`);
  log.info(`extraction methods: ${JSON.stringify(docStats.byMethod)}`);
  log.info(`wrote ${meetingsFile}`);
  if (stoppedEarly) log.warn('Run was cut short by --max-seconds; re-run to continue the backfill.');
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
