import * as cheerio from 'cheerio';
import { config, urls } from '../config.js';
import { fetchText } from '../lib/http.js';
import { normalizeText } from '../lib/text.js';
import { blockText } from '../lib/html.js';

/**
 * Agenda pages are server-rendered. Each item is a <tr class="agenda-item-information
 * agenda-item-children-of-{parentId}" data-agendaitemid="{id}">. The heading line,
 * presenter (<em>), optional description block and attachment links are all inline;
 * empty "attachments-for-*" containers belong to header items with no files.
 *
 * Verified against org 964: the rendered DOM exposes exactly the same set of
 * document ids as the raw HTML, so no browser engine is required.
 */

// "5.A." / "6.A.1." / "12." leading label on an item's heading line.
const LABEL_RE = /^((?:\d+|[A-Z])(?:\.(?:\d+|[A-Z]))*\.)\s*/;
// Trailing "(30 minutes)" / "(5 minutes, Roll Call Vote)" qualifier.
const QUALIFIER_RE = /\(([^()]*?(?:minutes?|vote|action|discussion)[^()]*?)\)\s*$/i;

export function parseAgenda(html, meetingId) {
  const $ = cheerio.load(html);

  const packetHref = $('a[href*="/Public/DownloadAgenda/"]').attr('href');
  const items = [];

  $('tr.agenda-item-information').each((_, tr) => {
    const $tr = $(tr);
    const itemId = $tr.attr('data-agendaitemid');
    if (!itemId) return;

    const parentId = /agenda-item-children-of-(\d+)/.exec($tr.attr('class') || '')?.[1] ?? '0';

    // Indentation encodes nesting depth: style="padding-left: 2em".
    const padding = /padding-left:\s*([\d.]+)em/.exec($tr.find('div[style]').first().attr('style') || '');
    const depth = padding ? Math.round(Number(padding[1])) : 0;

    // Heading line: "5.A. Bond Referendum Presentation (30 minutes)" + <em>presenter</em>.
    const $head = $tr.find('div.form-check').first();
    const $headClone = $head.clone();
    $headClone.find('i, input').remove();
    const presenter = normalizeText($headClone.find('em').text());
    $headClone.find('em').remove();

    let heading = normalizeText(blockText($, $headClone)).replace(/\n+/g, ' ').trim();

    const label = LABEL_RE.exec(heading)?.[1] ?? '';
    if (label) heading = heading.slice(label.length).trim();

    const qualifier = QUALIFIER_RE.exec(heading)?.[1] ?? '';
    if (qualifier) heading = heading.replace(QUALIFIER_RE, '').trim();

    // Description block, if the item has one.
    const $desc = $tr.find('div.Description').first().clone();
    $desc.find('strong').first().remove();
    const description = normalizeText(blockText($, $desc)).replace(/^Description:\s*/i, '').trim();

    const attachments = [];
    $tr.find('a[data-documentid]').each((__, a) => {
      const $a = $(a);
      const fileId = $a.attr('data-documentid');
      if (!fileId) return;
      const name = normalizeText($a.find('span.fileNameValue').text()) || normalizeText($a.text());
      const icon = $a.find('img').attr('src') || '';
      attachments.push({
        fileId,
        name,
        // The icon filename is BoardBook's own type hint (pdf.png, docx.png...).
        kind: /filetypes\/([a-z0-9]+)\.png/i.exec(icon)?.[1]?.toLowerCase() ?? 'unknown',
        viewerUrl: urls.attachmentViewer(fileId),
        pdfUrl: urls.attachmentPdf(fileId),
      });
    });

    if (!label && !heading && attachments.length === 0) return;

    items.push({
      itemId,
      parentId,
      depth,
      label,
      title: heading,
      qualifier,
      presenter,
      description,
      attachments,
      order: items.length,
    });
  });

  return {
    meetingId,
    packetUrl: packetHref ? new URL(packetHref, config.baseUrl).href : urls.packet(meetingId),
    items,
  };
}

export async function fetchAgenda(meetingId) {
  const html = await fetchText(urls.agenda(meetingId));
  return parseAgenda(html, meetingId);
}
