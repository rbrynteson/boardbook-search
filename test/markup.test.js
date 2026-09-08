import test from 'node:test';
import assert from 'node:assert/strict';

import { MARK_OPEN, MARK_CLOSE, escapeHtml, highlight, hasMatch } from '../site/markup.js';

const mark = (s) => `${MARK_OPEN}${s}${MARK_CLOSE}`;

// FTS5's snippet() performs no escaping, and the text it quotes comes from
// scraped PDFs. These tests exist so that highlighting can never become a way
// for document content to inject markup into the search page.

test('escapes HTML metacharacters', () => {
  assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('highlight promotes only the sentinels to <mark>', () => {
  assert.equal(highlight(`the ${mark('levy')} passed`), 'the <mark>levy</mark> passed');
});

test('highlight escapes markup that came from the document text', () => {
  // Real extracted text: an OCR'd signature line in the superintendent goals PDF
  // contains "Date _<i_" - unescaped, the browser starts parsing a tag.
  const snippet = `Signature Date _<i_ ${mark('goals')}`;
  const out = highlight(snippet);

  assert.match(out, /_&lt;i_/);
  assert.equal(out.includes('<i'), false, 'must not emit a raw tag from document text');
  assert.match(out, /<mark>goals<\/mark>/);
});

test('highlight neutralises an injection attempt in a document', () => {
  const out = highlight('<img src=x onerror=alert(1)>');

  assert.equal(out.includes('<img'), false);
  assert.equal(out.includes('onerror=alert(1)>'), false);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('highlight tolerates empty and missing snippets', () => {
  assert.equal(highlight(''), '');
  assert.equal(highlight(null), '');
  assert.equal(highlight(undefined), '');
});

test('hasMatch distinguishes a real hit from surrounding context', () => {
  assert.equal(hasMatch(`a ${mark('hit')} here`), true);
  assert.equal(hasMatch('just the head of a document'), false);
  assert.equal(hasMatch(''), false);
  assert.equal(hasMatch(null), false);
});
