# Contributing

Thanks for looking. This is a small, deliberately boring codebase — plain Node, no build
step, no framework. Keep it that way where you can.

## Ground rules

**Be courteous to BoardBook.** Every change that touches `src/lib/http.js` or the scrape
loop should be checked against one question: does this send more requests, faster? If yes,
it needs a good reason. The delay, the single-request-at-a-time gate, and the incremental
cache are load-bearing, not incidental. See [docs/LEGAL.md](docs/LEGAL.md).

**Never add authentication.** This tool reads the public, unauthenticated view. A PR that
adds a login, a cookie jar for member content, or a way past an access control will be
declined regardless of intent.

**Do not index anything that is not already public.** The whole database ships to every
visitor's browser.

## Getting set up

```bash
npm install
npm test                        # parsers against committed fixtures - no network
node src/cli/scrape.js --limit=3
npm run build && npm run serve
```

Node 20+. For OCR work you also need `poppler-utils` and `tesseract-ocr` on `PATH`.

## Layout

```
config/org.json      district config (org id, scope, courtesy settings, branding)
src/config.js        config loading, env overrides, BoardBook URL builders
src/lib/             http (rate limiting, retries), text normalisation, html helpers, store
src/scrape/          meetings.js, agenda.js, minutes.js - one parser per page type
src/extract/         pdf.js (text layer), ocr.js (scanned fallback), index.js (dispatch)
src/db/schema.sql    tables + the FTS5 index
src/cli/             scrape, build, serve, stats
site/                the static search page (no build step, no dependencies)
test/fixtures/       real BoardBook HTML, captured - the parsers are tested against these
```

## Working on the parsers

Parsers are pure functions over HTML strings, which is what makes them testable offline.

If BoardBook changes their markup:

1. Capture the new page into `test/fixtures/` (keep the existing naming).
2. Update the assertions to the new expected counts — deliberately, not by pasting whatever
   the parser now happens to produce.
3. Fix the parser.

The exact counts in `test/parsers.test.js` (1,133 meetings; 25 agenda items; 19
attachments) are intentional. A parser that silently returns fewer rows is the failure mode
that matters most here, because it produces an index that looks fine and is quietly
incomplete.

Please do not replace fixture-based tests with live network calls. Tests should not hit
BoardBook.

## Adding support for another district

Most of what varies between districts is already config. If you hit something structural
— different minutes handling, a different attachment layout — prefer:

1. A fixture from that district in `test/fixtures/`,
2. A test that fails,
3. A parser change that handles both districts,

over a district-specific branch. `src/scrape/minutes.js` is the model: it handles uploaded
PDFs, generated HTML, and a direct PDF response through one code path.

## Style

- Match the surrounding code. Two-space indent, single quotes, semicolons.
- Comments should explain *why*, especially where the code encodes something learned from
  the live site. `blockText()` exists because cheerio's `.text()` glues words across `<br>`
  — that sentence is worth more than a description of what the function does.
- Prefer clarity over cleverness. This should be readable by someone who maintains it once
  a year.
- No new runtime dependencies without a reason. The front end has none on purpose.

## Pull requests

- One concern per PR.
- Run `npm test` before pushing.
- If you changed scraping behaviour, say what you ran it against and what the request
  volume looked like.
- If you changed the schema, note whether existing `data/text/` caches survive it. They
  should — the schema is rebuilt from the cache, so a schema change should never force a
  re-scrape.

## Reporting problems

Useful issues include the organization id, what you ran, and the relevant output from
`npm run stats`. If it is a parsing problem, the page URL is essential.

Please do not paste large excerpts of meeting documents into issues. A link to the document
on BoardBook is enough.
