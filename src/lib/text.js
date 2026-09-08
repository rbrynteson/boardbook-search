/** Collapse whitespace, normalise unicode punctuation, strip control chars. */
export function normalizeText(input) {
  if (!input) return '';
  return String(input)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * PDF extractors emit one line per text run, which produces heavily
 * fragmented lines. Re-join lines that were split mid-sentence so FTS5
 * phrase matching and snippets behave.
 */
export function dehyphenate(text) {
  return text
    .replace(/([a-z,;])-\n([a-z])/g, '$1$2')
    .replace(/([a-z,;])\n([a-z])/g, '$1 $2');
}

/** Drop pure page furniture: bare page numbers, repeated rule characters. */
export function stripPageNoise(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(t)) return false;
      if (/^[-_=.*\u2022\s]{4,}$/.test(t)) return false;
      return true;
    })
    .join('\n');
}

export function cleanExtractedText(raw, maxChars = Infinity) {
  let t = normalizeText(raw);
  t = stripPageNoise(t);
  t = dehyphenate(t);
  t = normalizeText(t);
  if (t.length > maxChars) t = `${t.slice(0, maxChars)}\n[truncated]`;
  return t;
}

/** Parse "August 3, 2026 at 7:00 PM - Business Meeting" into its parts. */
const TITLE_RE = /^(?<month>[A-Z][a-z]+)\s+(?<day>\d{1,2}),\s*(?<year>\d{4})\s+at\s+(?<time>\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(?<rest>.+)$/;
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function parseMeetingTitle(title) {
  const t = normalizeText(title);
  const m = TITLE_RE.exec(t);
  if (!m) return { title: t, date: null, time: null, name: t };
  const { month, day, year, time, rest } = m.groups;
  const mo = MONTHS[month.toLowerCase()];
  if (!mo) return { title: t, date: null, time: null, name: t };
  const date = `${year}-${String(mo).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
  return { title: t, date, time: time.replace(/\s+/g, ' ').toUpperCase(), name: rest.trim() };
}
