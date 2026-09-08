import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';

export const sha1 = (input) =>
  crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);

const STATE_VERSION = 4;

/**
 * Bring an older state file forward rather than discarding it - the cache it
 * describes represents hours of polite, rate-limited scraping.
 *
 * v2 -> v3: v2 recorded a scanned document with no readable text as simply
 * "extracted, 0 chars". A later run with OCR available would treat it as done
 * and skip it forever. Mark those so they get retried once.
 *
 * v3 -> v4: add `firstSeen`, so the "what's new" feed can report when a document
 * entered the index. `extractedAt` cannot stand in for it - re-extraction moves
 * that timestamp, as the OCR retry did for every scanned document - so the
 * existing value is copied once here and then left alone.
 */
function migrate(state) {
  if (state.version === 2) {
    let marked = 0;
    for (const doc of Object.values(state.documents ?? {})) {
      if (!doc.failed && (doc.chars ?? 0) === 0 && doc.method === 'none') {
        doc.ocrPending = true;
        marked += 1;
      }
    }
    state.version = 3;
    if (marked) {
      process.stderr.write(
        `state: migrated to v3, flagged ${marked} scanned document(s) for OCR retry\n`,
      );
    }
  }

  if (state.version === 3) {
    let seeded = 0;
    for (const doc of Object.values(state.documents ?? {})) {
      if (!doc.firstSeen && doc.extractedAt) {
        doc.firstSeen = doc.extractedAt;
        seeded += 1;
      }
    }
    state.version = 4;
    if (seeded) {
      process.stderr.write(`state: migrated to v4, seeded firstSeen for ${seeded} document(s)\n`);
    }
  }

  return state;
}

const emptyState = (orgId) => ({
  version: STATE_VERSION,
  orgId,
  lastRun: null,
  meetings: {},   // meetingId -> { agendaHash, minutesFileId, itemCount, scrapedAt }
  documents: {},  // fileId    -> { hash, chars, pages, method, extractedAt, failed }
});

export function loadState(orgId) {
  try {
    const s = migrate(JSON.parse(fs.readFileSync(paths.state, 'utf8')));
    // An org change, or a version we cannot migrate, invalidates the cache.
    if (s.version !== STATE_VERSION || String(s.orgId) !== String(orgId)) return emptyState(orgId);
    return { ...emptyState(orgId), ...s };
  } catch {
    return emptyState(orgId);
  }
}

export async function saveState(state) {
  await fsp.mkdir(paths.data, { recursive: true });
  state.lastRun = new Date().toISOString();
  const tmp = `${paths.state}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, paths.state);
}

const textPath = (fileId) => path.join(paths.data, 'text', `${fileId}.txt`);
const pdfPath = (fileId) => path.join(paths.data, 'pdf', `${fileId}.pdf`);

export async function writeText(fileId, text) {
  await fsp.mkdir(path.dirname(textPath(fileId)), { recursive: true });
  await fsp.writeFile(textPath(fileId), text, 'utf8');
}

export function readText(fileId) {
  try {
    return fs.readFileSync(textPath(fileId), 'utf8');
  } catch {
    return null;
  }
}

export const hasText = (fileId) => fs.existsSync(textPath(fileId));

export async function writePdf(fileId, buffer) {
  await fsp.mkdir(path.dirname(pdfPath(fileId)), { recursive: true });
  await fsp.writeFile(pdfPath(fileId), buffer);
}

export async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export const meetingsFile = path.join(paths.data, 'meetings.json');
