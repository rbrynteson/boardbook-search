# BoardBook Search

Full-text search for public school board meeting documents hosted on
[BoardBook Premier](https://meetings.boardbook.org).

BoardBook is a good place to *publish* board materials and a poor place to *find* anything
in them. There is no search across meetings. If you want to know what the board decided
about a bond referendum in 2023, or every time transportation costs came up, you open
meetings one at a time and read.

This project scrapes the public view of a BoardBook organization, extracts the text from
agendas, minutes and attachments, and builds a single SQLite file with a full-text index.
A static web page loads that file and runs the searches **in the visitor's browser**.

There is no application server, no database server, and nothing to keep running.

> [!IMPORTANT]
> BoardBook's Terms of Use restrict automated copying of site content except "from a
> subscriber's account or as authorized by Supplier." Read
> **[docs/LEGAL.md](docs/LEGAL.md)** before deploying this publicly. Your district is the
> subscriber; the sanctioned path runs through them.

---

## How it works

```
meetings.boardbook.org
        │   plain HTTP - every page is server-rendered, no browser engine needed
        ▼
   scraper  (src/scrape)      meeting index → agenda items → attachments → minutes
        │
        ▼
  extraction (src/extract)    PDF text layer, OCR fallback for scanned pages
        │
        ▼
   data/text/*.txt            extracted text, committed to the repo (the expensive part)
        │
        ▼
  db builder (src/db)         site.db - SQLite + FTS5, rebuilt from the text cache
        │
        ▼
  GitHub Pages / any CDN      site.db + a static page + SQLite (WebAssembly)
        │
        ▼
   visitor's browser          FTS5 queries run locally; no request per keystroke
```

Nothing about a search leaves the visitor's machine. The CDN serves the same static files
regardless of how many people search.

### Why there is no headless browser

The project brief assumed BoardBook needed Playwright because the portal looks
JavaScript-heavy. It does not. Checked against org 964:

| Page | Server-rendered? |
|---|---|
| Meeting index (all 1,133 meetings, no pagination) | Yes |
| Agenda items, hierarchy, presenters, descriptions | Yes |
| Attachment links | Yes — the rendered DOM exposes exactly the same 19 document ids as the raw HTML |
| Minutes | Yes (resolves to an uploaded PDF or generated HTML) |

So the scraper is plain `fetch` plus [cheerio](https://cheerio.js.org/). That removes a
browser download from CI, makes runs faster and lighter on BoardBook, and makes the
parsers testable against committed HTML fixtures.

### Why not sql.js

The obvious choice for SQLite-in-the-browser is [sql.js](https://sql.js.org/), but the
stock sql.js distribution is **compiled without FTS5** — every query here fails with
`no such module: fts5`. This project uses the official
[`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm) build
instead, which includes FTS5 along with `snippet()` and `bm25()`.

It is vendored into `site/vendor/` rather than loaded from a CDN, so the page keeps working
on networks that block third-party CDNs — which describes a fair number of school and
library networks, i.e. exactly this tool's audience.

## What gets indexed

Two tiers, because the whole database downloads to every visitor:

- **Every meeting, all years** — agenda item titles, numbering, presenters, descriptions,
  meeting type, date and location. Cheap: one HTTP request per meeting, no PDFs.
- **Recent meetings** — full text of every attachment and of the minutes. Controlled by
  `attachmentsSinceDate` in `config/org.json` (default `2021-01-01`).

For ISD 281 that means all 1,133 meetings back to 2010 are searchable by agenda item, and
recent years are searchable down to the words inside the packets. Full attachment coverage
for the entire archive is roughly 15 GB of PDFs; the tiering is what keeps `site.db` small
enough to download.

### Scanned minutes and OCR

A majority of this district's approved minutes are **scanned images with no text layer** —
they extract to zero characters. Since minutes are where decisions actually live, OCR
matters here more than it usually would.

OCR shells out to `pdftoppm` (poppler) and `tesseract`. Both are installed by the CI
workflows. Locally it is off by default and degrades cleanly: without the binaries you
still get every text-layer document, just not the scanned ones.

## Quick start

Requires Node 20+.

```bash
npm install
```

Try it on a few meetings before committing to a full run:

```bash
node src/cli/scrape.js --limit=5
npm run build
npm run serve
```

Then open <http://localhost:8080>.

To point it at a different district, edit `config/org.json` — see
[docs/SETUP.md](docs/SETUP.md).

## Commands

| Command | What it does |
|---|---|
| `npm run scrape` | Incremental scrape + text extraction into `data/` |
| `npm run build` | Build `data/site.db` from the text cache |
| `npm run pipeline` | Both of the above |
| `npm run serve` | Preview the site at <http://localhost:8080> |
| `npm run stats` | Coverage report for the built database |
| `npm run vendor` | Copy the SQLite WASM runtime into `site/vendor/` (automatic) |
| `npm test` | Run the parsers against committed HTML fixtures |

Useful `scrape` flags:

| Flag | Effect |
|---|---|
| `--months=N` | Only meetings from the last N months — the one to use when trying this out |
| `--meetings-since=YYYY-MM-DD` | Same idea, explicit date |
| `--limit=N` | Only the N most recent meetings |
| `--dry-run` | Show what a run would do — scope, new work, time estimate — and fetch nothing else |
| `--max-seconds=N` | Stop cleanly at a wall-clock budget; the next run resumes |
| `--since=YYYY-MM-DD` | Override `attachmentsSinceDate` for this run |
| `--skip-documents` | Metadata only — no PDF downloads at all |
| `--full` | Ignore the incremental cache and re-extract everything |
| `--keep-pdfs` | Also save the source PDFs under `data/pdf/` (gitignored) |

`--dry-run` is worth a habit before any long run:

```bash
node src/cli/scrape.js --months=6 --dry-run
```

Measured on ISD 281: last 6 months ≈ 30 meetings and ~10 minutes; the full archive with
attachments back to 2021 ≈ 3h10m; metadata for all 1,133 meetings ≈ 43 minutes.

## Search syntax

| You type | You get |
|---|---|
| `bond referendum` | Both words |
| `"roll call vote"` | That exact phrase |
| `budget OR levy` | Either word |
| `transport*` | Prefix match — transportation, transported… |
| `budget -referendum` | Excludes a word (`NOT` works too) |
| `budget -"superintendent board report"` | Excludes a phrase |
| `budget -title:"board report"` | Excludes by document title only, keeping documents that merely mention it |

Searchable fields are `title`, `item_title`, `presenter` and `text`; any of them can be
used as a `field:term` filter.

The search box is not passed to SQLite as-is. FTS5's own grammar is unforgiving in ways
that produce confidently wrong answers rather than errors — its operators must be
uppercase, so `a not b` searches for the word "not"; there is no Google-style `-term`; and
bare punctuation like `6.A.1` or `ISD #281` is a syntax error. `site/query.js` parses the
input and emits an expression that means what was intended, quoting every term so
punctuation can never break the query. `-"board report"` on its own explains that a search
needs something to search *for*, rather than quietly returning the documents you asked to
exclude.

## Deployment

Two workflows in `.github/workflows/`:

- **`update.yml`** — runs weekly (Mondays 06:20 UTC) and on demand. Scrapes what is new,
  rebuilds `site.db`, commits the refreshed text cache, deploys to GitHub Pages.
- **`backfill.yml`** — manual, for the first pass over an archive. Each run takes a bounded
  chunk and commits its progress; re-run until it reports nothing new.

The first backfill takes many hours by design — the scraper waits between requests. That
is a feature, not a bottleneck to optimise away. See [docs/SETUP.md](docs/SETUP.md).

## Known limitations

- **Updates are batch.** New documents appear after the next scheduled run, not
  immediately. For a board that meets twice a month, weekly is comfortably ahead of need.
- **First load downloads the whole index.** Search is instant afterwards and the file is
  cached, but the initial download is real. Measured on ISD 281, full attachment text back
  to 2021 projects to roughly 53 MB on disk / **17 MB over the wire** (gzip takes it to a
  third), plus ~1.5 MB for the SQLite runtime. Moving `attachmentsSinceDate` to 2023 roughly
  halves that. `npm run stats` reports the current size.
- **Extracted text is imperfect.** Table-heavy PDFs lose their structure, and OCR of
  scanned minutes contains errors. Search results link back to the original document,
  which is always the authoritative version.
- **Older meetings are shallower.** Before `attachmentsSinceDate` you can find the agenda
  item but not words buried inside its attachments.
- **Scraping is coupled to BoardBook's markup.** If they change it, parsing breaks. The
  test suite runs against committed fixtures so the failure is loud rather than silent, and
  the scraper aborts rather than writing an empty index.

## Reusing this for another district

BoardBook hosts many districts on the same platform, so this should port with a config
change. Find the organization id in the public URL —
`meetings.boardbook.org/Public/Organization/<ORG_ID>` — and follow
[docs/SETUP.md](docs/SETUP.md).

If you get it working somewhere else, a note in the issues would be welcome, especially if
that district's minutes or attachments are shaped differently.

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — configuring, deploying, and adapting to another district
- [docs/LEGAL.md](docs/LEGAL.md) — public records basis, BoardBook's terms, scrape courtesy,
  data exposure
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to work on this

## Licence

MIT — see [LICENSE](LICENSE). The licence covers the code only, not the meeting documents.

This is an independent project. It is not affiliated with or endorsed by BoardBook, TASB,
or any school district.
