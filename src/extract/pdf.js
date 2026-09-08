import { createRequire } from 'node:module';
import { cleanExtractedText } from '../lib/text.js';
import { log } from '../lib/log.js';

const require = createRequire(import.meta.url);

let pdfjsPromise = null;
function getPdfjs() {
  // The legacy build is the one that runs under Node without a DOM.
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * Reassemble a page's text items into lines. pdfjs emits positioned runs, so
 * we group by baseline (transform[5]) and insert spaces where the horizontal
 * gap implies one. Without this, words in table cells run together.
 */
function itemsToText(items) {
  const lines = new Map();

  for (const it of items) {
    if (typeof it.str !== 'string' || it.str === '') continue;
    const y = Math.round(it.transform[5] * 2) / 2; // half-point tolerance
    let line = lines.get(y);
    if (!line) lines.set(y, (line = []));
    line.push({ x: it.transform[4], str: it.str, w: it.width ?? 0, eol: it.hasEOL });
  }

  const ys = [...lines.keys()].sort((a, b) => b - a); // top of page first
  const out = [];

  for (const y of ys) {
    const runs = lines.get(y).sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    for (const r of runs) {
      if (prevEnd !== null) {
        const gap = r.x - prevEnd;
        // A gap wider than roughly a space means a real separation.
        if (gap > 1.2 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      }
      text += r.str;
      prevEnd = r.x + r.w;
    }
    if (text.trim()) out.push(text.trim());
  }
  return out.join('\n');
}

/**
 * Extract text from a PDF buffer.
 * Returns { text, pages, pagesWithText, truncated, encrypted }.
 */
export async function extractPdfText(buffer, {
  maxPages = Infinity,
  maxChars = Infinity,
  label = 'pdf',
} = {}) {
  const pdfjs = await getPdfjs();

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // Board packets are text documents; skip the extra machinery and noise.
      disableFontFace: true,
      useSystemFonts: false,
      isEvalSupported: false,
      verbosity: 0,
    }).promise;
  } catch (err) {
    if (/password/i.test(err?.message || '')) {
      return { text: '', pages: 0, pagesWithText: 0, truncated: false, encrypted: true };
    }
    throw err;
  }

  const total = doc.numPages;
  const limit = Math.min(total, maxPages);
  const parts = [];
  const perPageChars = [];

  try {
    for (let n = 1; n <= limit; n++) {
      let pageText = '';
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        pageText = itemsToText(content.items);
        page.cleanup();
      } catch (err) {
        log.debug(`${label}: page ${n} failed (${err.message})`);
      }
      perPageChars.push(pageText.replace(/\s/g, '').length);
      if (pageText) parts.push(pageText);

      if (parts.join('\n').length > maxChars) break;
    }
  } finally {
    await doc.destroy().catch(() => {});
  }

  const text = cleanExtractedText(parts.join('\n\n'), maxChars);
  return {
    text,
    pages: total,
    pagesScanned: limit,
    pagesWithText: perPageChars.filter((c) => c > 0).length,
    perPageChars,
    truncated: limit < total || text.endsWith('[truncated]'),
    encrypted: false,
  };
}
