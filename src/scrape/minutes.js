import * as cheerio from 'cheerio';
import { config, urls } from '../config.js';
import { politeFetch } from '../lib/http.js';
import { normalizeText } from '../lib/text.js';
import { blockText } from '../lib/html.js';

/**
 * Minutes take one of two shapes depending on how the district publishes them:
 *
 *  - "Custom minutes": the district uploads a signed PDF. /Public/Minutes/{org}
 *    redirects to a viewer page that carries the document id in a hidden
 *    NewDocumentViewerDocumentID input; the PDF itself is at /Documents/DownloadPDF.
 *    (This is what ISD 281 uses.)
 *  - "Generated minutes": BoardBook renders the minutes as HTML in the page body.
 *
 * We detect which one we got and return a uniform descriptor.
 */
export function parseMinutesPage(html, meetingId) {
  const $ = cheerio.load(html);

  const fileId = $('#NewDocumentViewerDocumentID').attr('value');
  if (fileId && /^\d+$/.test(fileId)) {
    return {
      meetingId,
      kind: 'pdf',
      fileId,
      title: normalizeText($('#NewDocumentViewerDisplayName').attr('value') || '') || 'Minutes',
      pdfUrl: urls.attachmentPdf(fileId),
      text: '',
    };
  }

  // Generated HTML minutes: take the main content region, minus site chrome.
  const $body = $('.container.body-content').last().clone();
  $body.find('script, style, nav, header, footer, .sparqMenuBar, .displayNone').remove();
  const text = normalizeText(blockText($, $body));

  return {
    meetingId,
    kind: text ? 'html' : 'none',
    fileId: null,
    title: 'Minutes',
    pdfUrl: null,
    text,
  };
}

export async function fetchMinutes(meetingId) {
  const res = await politeFetch(urls.minutes(meetingId));
  const ct = res.headers.get('content-type') || '';

  // Some orgs serve the minutes as a PDF directly from the redirect target.
  if (ct.includes('application/pdf')) {
    return {
      meetingId,
      kind: 'pdf-direct',
      fileId: null,
      title: 'Minutes',
      pdfUrl: res.url,
      buffer: Buffer.from(await res.arrayBuffer()),
      text: '',
    };
  }

  return parseMinutesPage(await res.text(), meetingId);
}
