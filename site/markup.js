/*
 * Turning FTS5 snippets into safe HTML.
 *
 * SQLite's snippet() wraps matches in whatever delimiters you give it and does
 * no escaping whatsoever. The text it is quoting here comes out of scraped
 * PDFs, which genuinely do contain '<' - OCR'd signature lines, form fields and
 * mangled ligatures all produce it. Passing that straight into innerHTML would
 * let document content inject markup into the page.
 *
 * So the queries ask snippet() to mark matches with two control characters that
 * cannot occur in extracted text, and we escape everything before converting
 * only those sentinels into <mark> tags.
 */

/** Sentinels passed to snippet() as char(1) / char(2) in SQL. */
export const MARK_OPEN = '\u0001';
export const MARK_CLOSE = '\u0002';

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape a snippet, then promote its sentinels to <mark> elements. */
export function highlight(snippet) {
  if (!snippet) return '';
  return escapeHtml(snippet)
    .split(MARK_OPEN).join('<mark>')
    .split(MARK_CLOSE).join('</mark>');
}

/** Did snippet() actually find the term in this column? */
export function hasMatch(snippet) {
  return typeof snippet === 'string' && snippet.includes(MARK_OPEN);
}
