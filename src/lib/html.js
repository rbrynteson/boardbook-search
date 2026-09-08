/**
 * cheerio's .text() concatenates without any separator, so <br> and block
 * boundaries silently glue words together ("Boardroom4148 Winnetka").
 * Replace line-breaking elements with real newlines before reading text.
 */
export function blockText($, node) {
  const $c = $(node).clone();
  $c.find('br').replaceWith('\n');
  $c.find('p, div, li, tr, h1, h2, h3, h4, h5, h6').each((_, el) => {
    $(el).append('\n');
  });
  return $c.text();
}
