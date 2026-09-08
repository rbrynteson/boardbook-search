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
 *   - every word is ANDed, so an ordinary question finds nothing:
 *     "What did the board decide about the bond referendum?" returned 0 results
 *     against the live index, while "bond referendum" returned 62.
 *
 * A naive "try it raw, fall back to quoting every word" strategy turns the
 * failures into something worse than an error: `-"board report"` falls back to
 * searching FOR board report. So we parse the input ourselves and emit an
 * expression that means what the person intended.
 */

/** Columns a searcher may scope a term to, e.g. title:budget */
const COLUMNS = new Set(['title', 'item_title', 'presenter', 'text']);

/*
 * Words carrying no discriminating power in a question. Deliberately excludes
 * words that look generic but matter in this corpus - "board", "district",
 * "school", "policy", "report" - and every month name, so "May" survives.
 */
const STOPWORDS = new Set([
  'a', 'about', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between',
  'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'doing', 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'get', 'give', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more',
  'most', 'my', 'no', 'nor', 'of', 'off', 'on', 'once', 'only', 'other', 'our',
  'ours', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some',
  'such', 'tell', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then',
  'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under',
  'until', 'up', 'us', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours',
]);

// 1: leading minus  2: column:  3: "phrase"  4: phrase's trailing *  5: bare word
const TERM_RE = /(-)?(?:([A-Za-z_]+):)?(?:"([^"]*)"(\*)?|([^\s"]+))/g;

/** Quote a term as an FTS5 string so punctuation cannot break the grammar. */
function quote(text, prefix, column) {
  const body = `"${String(text).replace(/"/g, '""')}"${prefix ? '*' : ''}`;
  return column ? `${column}:${body}` : body;
}

/**
 * Parse a raw search box value.
 *
 * Positives are objects rather than strings so the caller can tell a bare word
 * (droppable as a stopword, relaxable to OR) from a quoted phrase or a
 * field-scoped term, both of which are explicit intent and must be preserved.
 *
 * @returns {{positives: {fts: string, display: string, bare: boolean}[],
 *            negatives: string[], joiner: 'AND'|'OR'}}
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
    const isPhrase = phrase !== undefined;
    if (isPhrase) {
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

    if (minus || negateNext) {
      negatives.push(quote(text, prefix, column));
    } else {
      positives.push({
        fts: quote(text, prefix, column),
        display: text,
        bare: !isPhrase && !column && !prefix,
      });
    }
    negateNext = false;
  }

  return { positives, negatives, joiner };
}

/**
 * Decide which terms actually get searched, setting stopwords aside.
 *
 * Only bare words are eligible: a quoted phrase or a field-scoped term is
 * explicit intent. If every term is a stopword the query is left intact -
 * someone searching "The Who" should still get to search for it.
 */
export function planQuery(raw) {
  const { positives, negatives, joiner } = parseQuery(raw);

  const content = positives.filter(
    (p) => !(p.bare && STOPWORDS.has(p.display.toLowerCase())),
  );
  const allStopwords = content.length === 0;

  return {
    used: allStopwords ? positives : content,
    dropped: allStopwords ? [] : positives.filter((p) => !content.includes(p)),
    negatives,
    joiner,
  };
}

/**
 * Build an FTS5 MATCH expression.
 *
 * `mode: 'relaxed'` joins the positive terms with OR instead of AND. Ranking
 * then does the work: bm25 puts documents matching more of the terms first, so
 * a question that finds nothing under a strict AND still surfaces the right
 * document at the top. Phrases and exclusions are never relaxed.
 *
 * @returns {{expr: string|null, reason: string|null, used: string[],
 *            dropped: string[], relaxed: boolean}}
 */
export function toMatchExpr(raw, { mode = 'strict' } = {}) {
  const { used, dropped, negatives, joiner } = planQuery(raw);
  const displays = (list) => list.map((p) => p.display);

  if (!used.length) {
    return {
      expr: null,
      reason: negatives.length
        // FTS5 has no way to match "everything except X" - NOT needs a left
        // operand - and an exclusion on its own is a browse, not a search.
        ? 'Add at least one word to search for, then exclude with a minus (for example: budget -"board report").'
        : null,
      used: [],
      dropped: displays(dropped),
      relaxed: false,
    };
  }

  const join = mode === 'relaxed' ? 'OR' : joiner;
  let expr = used.map((p) => p.fts).join(` ${join} `);
  if (used.length > 1 && join === 'OR' && negatives.length) expr = `(${expr})`;
  if (negatives.length) expr += ` NOT (${negatives.join(' OR ')})`;

  return {
    expr,
    reason: null,
    used: displays(used),
    dropped: displays(dropped),
    relaxed: join === 'OR' && joiner === 'AND' && used.length > 1,
  };
}

/** Would relaxing this query actually produce a different search? */
export function canRelax(raw) {
  const { used, joiner } = planQuery(raw);
  return joiner === 'AND' && used.length > 1;
}
