import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { cleanExtractedText } from '../lib/text.js';
import { log } from '../lib/log.js';

const run = promisify(execFile);

/**
 * OCR is an optional fallback for scanned documents. It shells out to poppler
 * (pdftoppm) to rasterise pages and tesseract to read them, rather than pulling
 * in a native rendering stack. Both are one apt-get away on CI; when they are
 * missing we degrade to "no text" instead of failing the run.
 *
 * This matters for ISD 281: a majority of sampled approved minutes are scanned
 * images with no embedded text layer.
 */
let availability = null;

export async function ocrAvailable() {
  if (availability) return availability;
  const probe = async (bin, args) => {
    try {
      await run(bin, args, { timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  };
  const [pdftoppm, tesseract] = await Promise.all([
    probe('pdftoppm', ['-v']),
    probe('tesseract', ['--version']),
  ]);
  availability = { pdftoppm, tesseract, ok: pdftoppm && tesseract };
  if (!availability.ok) {
    log.debug(`OCR unavailable (pdftoppm=${pdftoppm}, tesseract=${tesseract})`);
  }
  return availability;
}

/**
 * OCR selected pages of a PDF.
 * @param {Buffer} buffer  the PDF
 * @param {number[]} pages 1-based page numbers to read
 */
export async function ocrPdfPages(buffer, pages, { label = 'pdf', dpi = 200 } = {}) {
  const avail = await ocrAvailable();
  if (!avail.ok || pages.length === 0) return { text: '', pagesRead: 0, available: avail.ok };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bbsearch-ocr-'));
  const pdfPath = path.join(dir, 'in.pdf');
  const chunks = [];
  let pagesRead = 0;

  try {
    await fs.writeFile(pdfPath, buffer);

    for (const pageNo of pages) {
      const stem = path.join(dir, `p${pageNo}`);
      try {
        // Render one page to greyscale PNG.
        await run('pdftoppm', [
          '-f', String(pageNo), '-l', String(pageNo),
          '-r', String(dpi), '-gray', '-png',
          pdfPath, stem,
        ], { timeout: 120_000, maxBuffer: 1 << 26 });

        const produced = (await fs.readdir(dir)).filter((f) => f.startsWith(`p${pageNo}-`) || f === `p${pageNo}.png`);
        for (const img of produced) {
          const { stdout } = await run('tesseract', [
            path.join(dir, img), 'stdout', '--psm', '3', '-l', 'eng',
          ], { timeout: 180_000, maxBuffer: 1 << 26 });
          if (stdout.trim()) chunks.push(stdout);
          pagesRead += 1;
          await fs.rm(path.join(dir, img), { force: true });
        }
      } catch (err) {
        log.debug(`${label}: OCR failed on page ${pageNo} (${err.message.slice(0, 120)})`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    text: cleanExtractedText(chunks.join('\n\n'), config.maxTextCharsPerDoc),
    pagesRead,
    available: true,
  };
}
