import { config } from '../config.js';
import { extractPdfText } from './pdf.js';
import { ocrPdfPages, ocrAvailable } from './ocr.js';
import { log } from '../lib/log.js';

/**
 * Extract text from a document buffer, using the embedded text layer where one
 * exists and falling back to OCR for pages that look scanned.
 */
export async function extractDocumentText(buffer, { label = 'document', contentType = '' } = {}) {
  const looksPdf = buffer.subarray(0, 5).toString('latin1') === '%PDF-'
    || contentType.includes('application/pdf');

  if (!looksPdf) {
    return { text: '', pages: 0, method: 'unsupported', note: contentType || 'unknown content type' };
  }

  const base = await extractPdfText(buffer, {
    maxPages: config.maxAttachmentPages,
    maxChars: config.maxTextCharsPerDoc,
    label,
  });

  if (base.encrypted) {
    return { text: '', pages: base.pages, method: 'encrypted', note: 'password protected' };
  }

  // Which pages produced essentially nothing?
  const threshold = config.ocr?.minCharsPerPage ?? 40;
  const emptyPages = base.perPageChars
    .map((chars, i) => (chars < threshold ? i + 1 : null))
    .filter(Boolean);

  const wantsOcr = config.ocr?.enabled && emptyPages.length > 0;
  if (!wantsOcr) {
    return {
      text: base.text,
      pages: base.pages,
      method: base.pagesWithText > 0 ? 'text-layer' : 'none',
      note: base.pagesWithText === 0 ? 'no text layer (scanned?); OCR disabled' : '',
      truncated: base.truncated,
    };
  }

  const avail = await ocrAvailable();
  if (!avail.ok) {
    return {
      text: base.text,
      pages: base.pages,
      method: base.pagesWithText > 0 ? 'text-layer' : 'none',
      note: 'OCR requested but pdftoppm/tesseract not on PATH',
      truncated: base.truncated,
    };
  }

  const budget = config.ocr.maxPagesPerDoc ?? 10;
  const toRead = emptyPages.slice(0, budget);
  log.debug(`${label}: OCR-ing ${toRead.length}/${emptyPages.length} page(s)`);
  const ocr = await ocrPdfPages(buffer, toRead, { label });

  const merged = [base.text, ocr.text].filter(Boolean).join('\n\n');
  return {
    text: merged.slice(0, config.maxTextCharsPerDoc),
    pages: base.pages,
    method: base.pagesWithText > 0 ? 'text-layer+ocr' : 'ocr',
    note: emptyPages.length > toRead.length
      ? `OCR limited to first ${budget} scanned pages`
      : '',
    truncated: base.truncated || emptyPages.length > toRead.length,
  };
}
