import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMeetingList } from '../src/scrape/meetings.js';
import { parseAgenda } from '../src/scrape/agenda.js';
import { parseMinutesPage } from '../src/scrape/minutes.js';
import { extractPdfText } from '../src/extract/pdf.js';
import { normalizeText, cleanExtractedText, parseMeetingTitle } from '../src/lib/text.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const fixtureBuf = (name) => fs.readFileSync(path.join(here, 'fixtures', name));

// These fixtures are real pages captured from meetings.boardbook.org for org
// 964. They exist so the parsers can be checked without hitting the live site,
// and so a change in BoardBook's markup shows up as a test failure rather than
// as a silently empty index.

test('meeting list: parses the full archive from one server-rendered page', () => {
  const meetings = parseMeetingList(fixture('org964.html'));

  assert.equal(meetings.length, 1133, 'every meeting row should be found');
  assert.equal(meetings.filter((m) => !m.date).length, 0, 'every meeting should yield a date');
  assert.ok(meetings.filter((m) => m.minutesUrl).length > 1000, 'minutes links should be detected');
});

test('meeting list: extracts a meeting record in full', () => {
  const m = parseMeetingList(fixture('org964.html')).find((x) => x.meetingId === '757763');

  assert.equal(m.date, '2026-08-03');
  assert.equal(m.time, '7:00 PM');
  assert.equal(m.name, 'Business Meeting');
  assert.equal(m.meetingType, 'Regular');
  assert.equal(m.body, 'board');
  assert.equal(m.cancelled, false);
  // <br> boundaries must become separators, not glue words together.
  assert.match(m.location, /Boardroom, 4148 Winnetka Ave N, New Hope, MN 55427/);
  assert.match(m.agendaUrl, /\/Public\/Agenda\/964\?meeting=757763$/);
});

test('meeting list: flags cancelled meetings without losing their date', () => {
  const cancelled = parseMeetingList(fixture('org964.html')).filter((m) => m.cancelled);

  assert.equal(cancelled.length, 3);
  for (const m of cancelled) {
    assert.ok(m.date, 'a cancelled meeting should still parse its date');
    assert.doesNotMatch(m.title, /cancelled/i, 'the badge should be stripped from the title');
  }
});

test('agenda: parses items, hierarchy and every attachment', () => {
  const agenda = parseAgenda(fixture('agenda-757763.html'), '757763');

  assert.equal(agenda.items.length, 25);
  const attachments = agenda.items.flatMap((i) => i.attachments);
  // The rendered DOM exposes exactly these 19 documents, so plain HTTP loses none.
  assert.equal(attachments.length, 19);
  assert.ok(attachments.every((a) => /\/Documents\/DownloadPDF\/\d+\?org=964$/.test(a.pdfUrl)));
});

test('agenda: splits label, title, qualifier and presenter', () => {
  const agenda = parseAgenda(fixture('agenda-757763.html'), '757763');
  const bond = agenda.items.find((i) => i.title === 'Bond Referendum Presentation');

  assert.equal(bond.label, '5.A.');
  assert.equal(bond.depth, 1);
  assert.equal(bond.qualifier, '30 minutes');
  assert.equal(bond.presenter, 'Dr. Teri Staloch, Superintendent');
  assert.equal(bond.attachments.length, 2);
  assert.equal(bond.attachments[0].kind, 'pdf');
});

test('agenda: captures description blocks', () => {
  const agenda = parseAgenda(fixture('agenda-757763.html'), '757763');
  const consent = agenda.items.find((i) => /Consent Agenda Items/.test(i.title));

  assert.match(consent.description, /^Consent Agenda items are considered to be routine/);
  assert.doesNotMatch(consent.description, /^Description:/);
});

test('minutes: resolves custom (uploaded PDF) minutes to a document id', () => {
  const min = parseMinutesPage(fixture('custom-minutes-757763.html'), '757763');

  assert.equal(min.kind, 'pdf');
  assert.equal(min.fileId, '14330488');
  assert.match(min.pdfUrl, /\/Documents\/DownloadPDF\/14330488\?org=964$/);
});

test('minutes: falls back to HTML text when there is no uploaded PDF', () => {
  const min = parseMinutesPage(
    '<html><body><div class="container body-content">' +
    '<p>Motion carried 6-0.</p><script>ignored()</script>' +
    '</div></body></html>',
    '1'
  );

  assert.equal(min.kind, 'html');
  assert.match(min.text, /Motion carried 6-0\./);
  assert.doesNotMatch(min.text, /ignored/);
});

test('pdf: extracts a readable text layer with lines intact', async () => {
  const res = await extractPdfText(fixtureBuf('attachment-4447235.pdf'), { label: 'test' });

  assert.equal(res.encrypted, false);
  assert.equal(res.pages, 1);
  assert.equal(res.pagesWithText, 1);
  assert.match(res.text, /Roll Call Attendance/);
  // Column headings on one visual line must not run together.
  assert.match(res.text, /PRESENT ABSENT/);
});

test('text: normalises punctuation and collapses whitespace', () => {
  assert.equal(normalizeText('a  b—c “d”'), 'a b-c "d"');
});

test('text: rejoins hyphenated line breaks and drops page furniture', () => {
  const out = cleanExtractedText('the bud-\nget was\napproved\nPage 3 of 9\n-----');
  assert.equal(out, 'the budget was approved');
});

test('text: parses BoardBook meeting titles', () => {
  const m = parseMeetingTitle('August 3, 2026 at 7:00 PM - Business Meeting');
  assert.deepEqual(
    { date: m.date, time: m.time, name: m.name },
    { date: '2026-08-03', time: '7:00 PM', name: 'Business Meeting' }
  );
});

test('text: leaves an unrecognised title usable rather than throwing', () => {
  const m = parseMeetingTitle('Special gathering, no date');
  assert.equal(m.date, null);
  assert.equal(m.name, 'Special gathering, no date');
});
