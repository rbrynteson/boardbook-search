import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadStars, saveStars, toggleStar, clearStars, isStarred,
  encodeStars, decodeStars, mergeStars, MAX_STARS,
} from '../site/favorites.js';

/** Minimal localStorage stand-in; `mode` lets a test simulate a hostile browser. */
function installStorage(mode = 'ok') {
  const data = new Map();
  globalThis.localStorage = {
    getItem(k) {
      if (mode === 'throw') throw new DOMException('denied');
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (mode === 'throw' || mode === 'full') throw new DOMException('quota');
      data.set(k, v);
    },
  };
  return data;
}

test.beforeEach(() => { installStorage(); });

test('starring is keyed by ref and round-trips', () => {
  assert.deepEqual(loadStars(), []);

  const added = toggleStar('f4447235');
  assert.equal(added.starred, true);
  assert.equal(added.stored, true);
  assert.deepEqual(loadStars(), ['f4447235']);
  assert.equal(isStarred('f4447235'), true);

  const removed = toggleStar('f4447235');
  assert.equal(removed.starred, false);
  assert.deepEqual(loadStars(), []);
});

test('all three ref shapes are accepted, anything else is not', () => {
  for (const ref of ['f4447235', 'i18570124', 'm757763']) {
    toggleStar(ref);
  }
  assert.equal(loadStars().length, 3);

  // A raw row id is exactly the mistake this design exists to prevent.
  assert.equal(toggleStar('781').starred, false);
  assert.equal(toggleStar('../etc/passwd').starred, false);
  assert.equal(loadStars().length, 3);
});

test('duplicates collapse', () => {
  saveStars(['f1', 'f1', 'f2']);
  assert.deepEqual(loadStars(), ['f1', 'f2']);
});

test('stars are capped rather than growing without bound', () => {
  saveStars(Array.from({ length: MAX_STARS }, (_, i) => `f${i + 1}`));
  assert.equal(loadStars().length, MAX_STARS);

  const overflow = toggleStar('f999999');
  assert.equal(overflow.full, true);
  assert.equal(overflow.starred, false);
  assert.equal(loadStars().length, MAX_STARS);
});

test('a share link round-trips through the fragment encoding', () => {
  const refs = ['f4447235', 'i18570124', 'm757763'];
  const encoded = encodeStars(refs);

  assert.doesNotMatch(encoded, /[+/=]/, 'must be URL-fragment safe');
  assert.deepEqual(decodeStars(encoded), refs);
});

test('a malformed or hostile share link yields nothing, not a crash', () => {
  assert.deepEqual(decodeStars('not base64 !!!'), []);
  assert.deepEqual(decodeStars(''), []);
  assert.deepEqual(decodeStars(encodeStars([])), []);
  // Valid base64 whose payload is not a ref list.
  assert.deepEqual(decodeStars(globalThis.btoa('<script>alert(1)</script>')), []);
});

test('merging a shared collection keeps existing stars and reports additions', () => {
  saveStars(['f1', 'f2']);
  const { stars, added } = mergeStars(['f2', 'f3', 'bogus']);

  assert.deepEqual(stars, ['f1', 'f2', 'f3']);
  assert.equal(added, 1);
});

test('a browser that refuses storage degrades to no stars instead of breaking', () => {
  installStorage('throw');

  assert.deepEqual(loadStars(), []);
  const result = toggleStar('f4447235');
  assert.equal(result.stored, false, 'write failed');
  assert.deepEqual(loadStars(), [], 'and nothing was persisted');
});

test('a full quota reports the failure rather than pretending it saved', () => {
  installStorage('full');
  assert.equal(toggleStar('f4447235').stored, false);
});

test('clearing removes everything', () => {
  saveStars(['f1', 'f2']);
  clearStars();
  assert.deepEqual(loadStars(), []);
});
