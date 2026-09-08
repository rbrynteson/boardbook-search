import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAtomFeed, xmlEscape } from '../src/lib/feed.js';

const doc = (over = {}) => ({
  ref: 'f4447235',
  title: 'Bond Referendum Presentation',
  kind: 'attachment',
  source_url: 'https://meetings.boardbook.org/Documents/FileViewerOrPublic/964?file=4447235',
  item_label: '5.A.',
  first_seen: '2026-09-01T12:00:00.000Z',
  date: '2026-08-03',
  meeting_name: 'Business Meeting',
  ...over,
});

const feed = (documents, over = {}) => buildAtomFeed({
  title: 'ISD 281 Board Document Search',
  subtitle: 'Full-text search',
  siteUrl: 'https://example.github.io/boardbook-search',
  orgId: '964',
  documents,
  ...over,
});

test('produces a well-formed Atom document', () => {
  const xml = feed([doc()]);

  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<\/feed>\n$/);
  assert.equal((xml.match(/<entry>/g) || []).length, 1);
  assert.match(xml, /<link rel="self" href="[^"]+\/feed\.xml" \/>/);
});

test('entry ids are keyed by the stable ref, not a row id', () => {
  // Readers dedupe on <id>. Keying it to documents.id would re-announce the
  // whole archive as "new" every time a rebuild reshuffled the ids.
  assert.match(feed([doc()]), /<id>urn:boardbook:964:f4447235<\/id>/);
});

test('ampersands and angle brackets in titles are escaped', () => {
  const xml = feed([doc({ title: 'Budget & Levy <draft>', source_url: 'https://x/?a=1&b=2' })]);

  assert.match(xml, /<title>Budget &amp; Levy &lt;draft&gt;<\/title>/);
  assert.match(xml, /href="https:\/\/x\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(xml, /<draft>/);
});

test('control characters from OCR text are removed, not escaped', () => {
  // XML 1.0 forbids these outright - an escaped control char is still invalid and
  // makes the whole feed unparseable.
  const xml = feed([doc({ title: 'Bell\u0007 schedule\u0000' })]);

  assert.match(xml, /<title>Bell schedule<\/title>/);
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
});

test('the summary carries the meeting context a bare title lacks', () => {
  assert.match(feed([doc()]), /<summary>Business Meeting · 2026-08-03 · item 5\.A\.<\/summary>/);
});

test('an unparseable or missing date does not emit invalid timestamps', () => {
  const xml = feed([doc({ first_seen: 'not a date' })]);
  const stamps = [...xml.matchAll(/<updated>([^<]+)<\/updated>/g)].map((m) => m[1]);

  assert.ok(stamps.length >= 1);
  for (const s of stamps) assert.equal(Number.isNaN(Date.parse(s)), false);
});

test('an empty index still yields a valid feed', () => {
  const xml = feed([]);
  assert.match(xml, /<\/feed>/);
  assert.doesNotMatch(xml, /<entry>/);
});

test('a site with no configured URL omits the site links rather than emitting empty ones', () => {
  const xml = feed([doc()], { siteUrl: '' });

  assert.doesNotMatch(xml, /href=""/);
  assert.match(xml, /<id>urn:boardbook:964<\/id>/);
});

test('xmlEscape handles null and undefined', () => {
  assert.equal(xmlEscape(null), '');
  assert.equal(xmlEscape(undefined), '');
});
