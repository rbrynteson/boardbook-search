/*
 * Atom feed of newly indexed documents.
 *
 * The index updates in a weekly batch, so "check back and search again" is a
 * poor fit - a feed lets people be told when new packets appear instead. It is
 * a static file written at build time; nothing serves it dynamically.
 */

/** Escape text for XML content and attribute values. */
export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 even when escaped, and OCR'd
    // text does contain them.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

const iso = (value) => {
  const d = new Date(value ?? Date.now());
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/**
 * @param {object} o
 * @param {string} o.title        feed title
 * @param {string} o.subtitle
 * @param {string} o.siteUrl      canonical site URL (may be '')
 * @param {string} o.orgId
 * @param {Array}  o.documents    rows with ref, title, kind, source_url, date,
 *                                meeting_name, item_label, first_seen
 * @returns {string} Atom 1.0 document
 */
export function buildAtomFeed({ title, subtitle = '', siteUrl = '', orgId, documents }) {
  const base = siteUrl.replace(/\/+$/, '');
  const updated = documents.length ? iso(documents[0].first_seen) : new Date().toISOString();

  const entries = documents.map((d) => {
    const context = [
      d.meeting_name,
      d.date,
      d.item_label ? `item ${d.item_label}` : null,
    ].filter(Boolean).join(' · ');

    return [
      '  <entry>',
      `    <title>${xmlEscape(d.title)}</title>`,
      `    <link href="${xmlEscape(d.source_url)}" />`,
      // A tag: URI keyed by the stable ref - readers use this to tell whether
      // they have already shown an entry, so it must not change on rebuild.
      `    <id>urn:boardbook:${xmlEscape(orgId)}:${xmlEscape(d.ref)}</id>`,
      `    <updated>${iso(d.first_seen)}</updated>`,
      `    <category term="${xmlEscape(d.kind)}" />`,
      `    <summary>${xmlEscape(context)}</summary>`,
      '  </entry>',
    ].join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${xmlEscape(title)}</title>`,
    subtitle ? `  <subtitle>${xmlEscape(subtitle)}</subtitle>` : null,
    base ? `  <link href="${xmlEscape(base)}/" />` : null,
    base ? `  <link rel="self" href="${xmlEscape(base)}/feed.xml" />` : null,
    `  <id>${xmlEscape(base || `urn:boardbook:${orgId}`)}</id>`,
    `  <updated>${updated}</updated>`,
    ...entries,
    '</feed>',
    '',
  ].filter((line) => line !== null).join('\n');
}
