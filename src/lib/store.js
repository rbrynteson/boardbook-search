import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../config.js';

export const sha1 = (input) =>
  crypto.createHash('sha1').update(input).digest('hex').slice(0, 16);

const STATE_VERSION = 2;

const emptyState = (orgId) => ({
  version: STATE_VERSION,
  orgId,
  lastRun: null,
  meetings: {},   // meetingId -> { agendaHash, minutesFileId, itemCount, scrapedAt }
  documents: {},  // fileId    -> { hash, chars, pages, method, extractedAt, failed }
});

export function loadState(orgId) {
  try {
    const s = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    // A version or org change invalidates the incremental cache.
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
