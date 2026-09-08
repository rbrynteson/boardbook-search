import test from 'node:test';
import assert from 'node:assert/strict';

import { parseQuery, toMatchExpr } from '../site/query.js';

const expr = (raw) => toMatchExpr(raw).expr;

test('a plain word is quoted so punctuation can never break the grammar', () => {
  assert.equal(expr('superintendent'), '"superintendent"');
});

test('multiple words are ANDed', () => {
  assert.equal(expr('bond referendum'), '"bond" AND "referendum"');
});

test('quoted input stays a phrase', () => {
  assert.equal(expr('"roll call vote"'), '"roll call vote"');
});

test('minus excludes a phrase', () => {
  assert.equal(
    expr('superintendent -"board report"'),
    '"superintendent" NOT ("board report")',
  );
});

test('NOT excludes, and is accepted in lower case', () => {
  // FTS5 itself only honours uppercase operators; "a not b" silently searches
  // for the word "not" and returns a confidently wrong answer.
  const uppercase = expr('superintendent NOT "board report"');
  assert.equal(expr('superintendent not "board report"'), uppercase);
  assert.equal(uppercase, '"superintendent" NOT ("board report")');
});

test('several exclusions collapse into one NOT group', () => {
  assert.equal(
    expr('superintendent -"board report" -disbursements'),
    '"superintendent" NOT ("board report" OR "disbursements")',
  );
});

test('OR is honoured and parenthesised when combined with an exclusion', () => {
  assert.equal(expr('budget or levy'), '"budget" OR "levy"');
  assert.equal(
    expr('budget OR levy -"board report"'),
    '("budget" OR "levy") NOT ("board report")',
  );
});

test('prefix search survives quoting', () => {
  assert.equal(expr('transport*'), '"transport"*');
  assert.equal(expr('"school bus"*'), '"school bus"*');
});

test('a known column scopes a term; an unknown one is just text', () => {
  assert.equal(expr('-title:"board report" budget'), '"budget" NOT (title:"board report")');
  // "Note:" and "9:00" must not become "no such column" errors.
  assert.equal(expr('9:00'), '"9:00"');
  assert.equal(expr('Note:something'), '"Note:something"');
});

test('punctuation that is a syntax error in raw FTS5 is safely quoted', () => {
  assert.equal(expr('6.A.1.'), '"6.A.1."');
  assert.equal(expr('ISD #281'), '"ISD" AND "#281"');
  assert.equal(expr('(parenthesised)'), '"(parenthesised)"');
});

test('an unbalanced quote is dropped rather than unbalancing the query', () => {
  assert.equal(expr('say "hi'), '"say" AND "hi"');
  assert.equal(expr('budget" OR levy'), '"budget" OR "levy"');
  assert.equal(expr('unbalanced " quote here'), '"unbalanced" AND "quote" AND "here"');
  assert.equal(expr('""'), null);
});

test('operator words inside quotes stay literal', () => {
  assert.equal(expr('"not guilty"'), '"not guilty"');
  assert.deepEqual(parseQuery('"not guilty"').negatives, []);
});

test('an exclusion-only query explains itself instead of inverting', () => {
  // The old behaviour fell back to quoting every token, so -"board report"
  // searched FOR board report - the opposite of what was asked.
  const { expr: e, reason } = toMatchExpr('-"board report"');
  assert.equal(e, null);
  assert.match(reason, /at least one word/i);
});

test('empty input yields no query and no complaint', () => {
  const { expr: e, reason } = toMatchExpr('   ');
  assert.equal(e, null);
  assert.equal(reason, null);
});
