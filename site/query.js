/*
 * Translating what people type into an FTS5 MATCH expression.
 *
 * FTS5's query grammar is unforgiving in ways that bite ordinary searchers:
 *
 *   - operators must be UPPERCASE. "a not b" silently searches for the word
 *     "not" instead of excluding b, and returns a confidently wrong answer.
 *   - there is no Google-style "-term"; it is a syntax error.
 *   - "a AND NOT b" is a syntax error; the operator is a bare NOT.
 *   - bare punctuation ("6.A.1", "ISD #281") is a syntax error.
 *
 * A naive "try it raw, fall back to quoting every word" strategy turns the
 * failures into something worse than an error: `-"board report"` falls back to
 * searching FOR board report. So we parse the input ourselves and emit an
 * expression that means what the person intended.
 */

/** Columns a searcher may scope a term to, e.g. title:budget */
const COLUMNS = new Set(['title', 'item_title', 'presenter', 'text']);

// 1: leading minus  2: column:  3: "phrase"  4: phrase's trailing *  5: bare word
const TERM_RE = /(-)?(?:([A-Za-z_]+):)?(?:"([^"]*)"(\*)?|([^\s"]+))/g;

/** Quote a term as an FTS5 string so punctuation cannot break the grammar. */
function quote(text, prefix, column) {
  const body = `"${String(text).replace(/"/g, '""')}"${prefix ? '*' : ''}`;
  return column ? `${column}:${body}` : body;
}

/**
 * Parse a raw search box value.
 * @returns {{positives: string[], negatives: string[], joiner: 'AND'|'OR'}}
 */
export function parseQuery(raw) {
  const positives = [];
  const negatives = [];
  let joiner = 'AND';
  let negateNext = false;

  TERM_RE.lastIndex = 0;
  let m;
  while ((m = TERM_RE.exec(String(raw ?? ''))) !== null) {
    const [, minus, rawColumn, phrase, phraseStar, word] = m;

    // Operators are only operators when written bare - "not guilty" in quotes
    // is a phrase, and -not is a term to exclude.
    if (word !== undefined && !minus && !rawColumn) {
      const op = word.toUpperCase();
      if (op === 'NOT') { negateNext = true; continue; }
      if (op === 'OR') { joiner = 'OR'; continue; }
      if (op === 'AND') { continue; }
    }

    let text;
    let prefix;
    if (phrase !== undefined) {
      text = phrase;
      prefix = Boolean(phraseStar);
    } else {
      prefix = word.endsWith('*');
      text = prefix ? word.slice(0, -1) : word;
    }

    // An unknown prefix is part of the search text, not a column filter:
    // "9:00" and "Note:" should not become "no such column".
    const column = rawColumn && COLUMNS.has(rawColumn.toLowerCase())
      ? rawColumn.toLowerCase()
      : null;
    if (rawColumn && !column) text = `${rawColumn}:${text}`;

    if (!text) { negateNext = false; continue; }

    (minus || negateNext ? negatives : positives).push(quote(text, prefix, column));
    negateNext = false;
  }

  return { positives, negatives, joiner };
}

/**
 * Build an FTS5 MATCH expression.
 * @returns {{expr: string|null, reason: string|null}}
 */
export function toMatchExpr(raw) {
  const { positives, negatives, joiner } = parseQuery(raw);

  if (!positives.length) {
    return {
      expr: null,
      reason: negatives.length
        // FTS5 has no way to match "everything except X" - NOT needs a left
        // operand - and an exclusion on its own is a browse, not a search.
        ? 'Add at least one word to search for, then exclude with a minus (for example: budget -"board report").'
        : null,
    };
  }

  let expr = positives.join(` ${joiner} `);
  if (positives.length > 1 && joiner === 'OR' && negatives.length) expr = `(${expr})`;
  if (negatives.length) expr += ` NOT (${negatives.join(' OR ')})`;

  return { expr, reason: null };
}
