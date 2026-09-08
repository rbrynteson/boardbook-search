import * as cheerio from 'cheerio';
import { config, urls } from '../config.js';
import { fetchText } from '../lib/http.js';
import { normalizeText, parseMeetingTitle } from '../lib/text.js';
import { blockText } from '../lib/html.js';
import { log } from '../lib/log.js';

/**
 * The organization page is server-rendered and lists the org's entire meeting
 * history in one table - no pagination, no JS required. Each <tr> carries a
 * body class (row-for-board / row-for-unit-N) plus links to the agenda and,
 * where published, the minutes.
 */
export function parseMeetingList(html) {
  const $ = cheerio.load(html);
  const byId = new Map();

  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const agendaHref = $tr.find('a[href*="/Public/Agenda/"]').attr('href');
    if (!agendaHref) return;

    const meetingId = /meeting=(\d+)/.exec(agendaHref)?.[1];
    if (!meetingId || byId.has(meetingId)) return;

    const cells = $tr.find('> td');
    const $first = cells.eq(0);

    // First <div> of the first cell holds the title line. Cancelled meetings
    // wrap it in "Cancelled" badges, which would otherwise break date parsing.
    let rawTitle = normalizeText(blockText($, $first.find('> div').first()));
    const cancelled = /(^|\n)\s*cancell?ed\s*($|\n)/i.test(rawTitle);
    rawTitle = normalizeText(
      rawTitle.replace(/(^|\n)\s*cancell?ed\s*(?=$|\n)/gi, '\n')
    ).replace(/\n+/g, ' ').trim();

    const { title, date, time, name } = parseMeetingTitle(rawTitle);

    // "Meeting Type:" sits in a sibling div behind a <b> label.
    let meetingType = '';
    $first.find('div').each((__, d) => {
      const $d = $(d);
      if ($d.find('b.important-page-text').length) {
        meetingType = normalizeText(blockText($, $d).replace(/^\s*Meeting Type:\s*/i, ''));
      }
    });

    // Free-text notes: live-stream notices, remote attendance, etc.
    const notes = normalizeText(blockText($, $first.find('div.checkForUrls')));

    // Location cell, minus the "[ map it]" affordance.
    const $loc = cells.eq(1).clone();
    $loc.find('span.nowrap').remove();
    const location = normalizeText(blockText($, $loc)).replace(/\n+/g, ', ');

    const isCommittee = /row-for-unit/.test($tr.attr('class') || '');

    byId.set(meetingId, {
      meetingId,
      title,
      name,
      date,
      time,
      meetingType,
      cancelled,
      notes,
      location,
      body: isCommittee ? 'committee' : 'board',
      agendaUrl: urls.agenda(meetingId),
      minutesUrl: $tr.find('a[href*="/Public/Minutes/"]').length ? urls.minutes(meetingId) : null,
      packetUrl: urls.packet(meetingId),
    });
  });

  return [...byId.values()];
}

export async function fetchMeetingList() {
  log.step(`Fetching meeting index for org ${config.orgId}`);
  const html = await fetchText(urls.organization());
  const meetings = parseMeetingList(html);

  if (meetings.length === 0) {
    throw new Error(
      'Parsed 0 meetings from the organization page. BoardBook markup may have changed - see docs/SETUP.md.'
    );
  }
  const undated = meetings.filter((m) => !m.date);
  if (undated.length) {
    log.warn(`${undated.length} meeting(s) had an unparseable date; they will sort last`);
    undated.slice(0, 5).forEach((m) => log.debug(`  unparsed title: ${m.title}`));
  }

  meetings.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  log.info(
    `Found ${meetings.length} meetings (${meetings.at(-1)?.date} to ${meetings[0]?.date}), ` +
    `${meetings.filter((m) => m.minutesUrl).length} with minutes`
  );
  return meetings;
}
