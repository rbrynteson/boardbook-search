import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Repo-root-relative path helper. */
export const fromRoot = (...p) => path.join(root, ...p);

function load() {
  const file = process.env.BOARDBOOK_CONFIG
    ? path.resolve(process.env.BOARDBOOK_CONFIG)
    : fromRoot('config', 'org.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Environment overrides let the GitHub Actions workflow tune a run without
  // editing the committed config.
  if (process.env.BOARDBOOK_ORG_ID) cfg.orgId = process.env.BOARDBOOK_ORG_ID;
  if (process.env.BOARDBOOK_USER_AGENT) cfg.userAgent = process.env.BOARDBOOK_USER_AGENT;
  if (process.env.BOARDBOOK_DELAY_MS) cfg.requestDelayMs = Number(process.env.BOARDBOOK_DELAY_MS);
  if (process.env.BOARDBOOK_ATTACHMENTS_SINCE) cfg.attachmentsSinceDate = process.env.BOARDBOOK_ATTACHMENTS_SINCE;
  if (process.env.BOARDBOOK_MEETINGS_SINCE) cfg.meetingsSinceDate = process.env.BOARDBOOK_MEETINGS_SINCE;
  if (process.env.BOARDBOOK_OCR === '1') cfg.ocr.enabled = true;

  if (!/^\d+$/.test(String(cfg.orgId))) throw new Error(`orgId must be numeric, got ${cfg.orgId}`);
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return cfg;
}

export const config = load();

export const paths = {
  data: fromRoot('data'),
  raw: fromRoot('data', 'raw'),
  db: fromRoot('data', 'site.db'),
  state: fromRoot('data', 'state.json'),
  site: fromRoot('site'),
  dist: fromRoot('dist'),
};

/** URL builders for the BoardBook endpoints this tool relies on. */
export const urls = {
  organization: () => `${config.baseUrl}/Public/Organization/${config.orgId}`,
  agenda: (meetingId) => `${config.baseUrl}/Public/Agenda/${config.orgId}?meeting=${meetingId}`,
  minutes: (meetingId) => `${config.baseUrl}/Public/Minutes/${config.orgId}?meeting=${meetingId}`,
  minutesReport: (meetingId) =>
    `${config.baseUrl}/Documents/CustomMinutesOrMinutesReport/${config.orgId}?meeting=${meetingId}`,
  attachmentViewer: (fileId) => `${config.baseUrl}/Documents/FileViewerOrPublic/${config.orgId}?file=${fileId}`,
  attachmentPdf: (fileId) => `${config.baseUrl}/Documents/DownloadPDF/${fileId}?org=${config.orgId}`,
  packet: (meetingId) => `${config.baseUrl}/Public/DownloadAgenda/${config.orgId}?meeting=${meetingId}`,
};
