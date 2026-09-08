# Setup and deployment

How to configure this for a district, run the first backfill, and publish it.

Before deploying publicly, read [LEGAL.md](LEGAL.md) — BoardBook's terms restrict
automated copying except from a subscriber's account or with their authorization.

---

## 1. Find the organization id

Open the district's public BoardBook page. The URL looks like:

```
https://meetings.boardbook.org/Public/Organization/964
                                                  ^^^ organization id
```

If you only have a link to a single meeting, the id is in that URL too:
`/Public/Agenda/964?meeting=757763`.

Confirm the page lists meetings **without logging in**. If it does not, this tool is not
the right approach — it deliberately has no authentication.

## 2. Configure

Edit `config/org.json`:

```jsonc
{
  "orgId": "964",
  "orgName": "Robbinsdale Area Schools (ISD 281)",
  "orgShortName": "ISD 281",
  "baseUrl": "https://meetings.boardbook.org",

  "siteTitle": "ISD 281 Board Document Search",
  "siteTagline": "Full-text search across ... agendas, minutes, and packets.",

  // Attachment PDFs are only fetched for meetings on or after this date.
  // Agenda items and minutes are indexed for every meeting regardless.
  "attachmentsSinceDate": "2021-01-01",

  // Optional: ignore meetings before this date entirely.
  "meetingsSinceDate": null,

  "requestDelayMs": 1200,
  "userAgent": "BoardBookSearchBot/0.1 (+https://github.com/YOU/boardbook-search; public records indexing; contact: you@example.com)",

  "ocr": { "enabled": false, "minCharsPerPage": 40, "maxPagesPerDoc": 10 }
}
```

**Set a real `userAgent`.** A contactable identity is the difference between a courteous
crawler and an anonymous one. Put your repository URL and an address someone can reach you
at.

`siteTitle` and `siteTagline` are baked into `site.db` and picked up by the front end, so
the page rebrands itself without editing HTML.

### Environment overrides

Handy in CI, where you do not want to edit committed config per run:

| Variable | Overrides |
|---|---|
| `BOARDBOOK_CONFIG` | Path to an alternative config file |
| `BOARDBOOK_ORG_ID` | `orgId` |
| `BOARDBOOK_USER_AGENT` | `userAgent` |
| `BOARDBOOK_DELAY_MS` | `requestDelayMs` |
| `BOARDBOOK_ATTACHMENTS_SINCE` | `attachmentsSinceDate` |
| `BOARDBOOK_MEETINGS_SINCE` | `meetingsSinceDate` |
| `BOARDBOOK_OCR=1` | Enables OCR |
| `BOARDBOOK_DEBUG=1` | Verbose per-document logging |

## 3. Check the parsers still match

BoardBook's markup is not a contract. Before a long run:

```bash
npm test
```

The suite parses committed HTML fixtures from org 964 and asserts on exact counts (1,133
meetings, 25 agenda items, 19 attachments). If BoardBook changes their markup these fail
loudly, which is the point.

Then confirm live parsing against your district:

```bash
node src/cli/scrape.js --limit=3
npm run build
npm run stats
```

`stats` should show meetings, agenda items and attachments with non-zero text. If
attachments show `with text 0`, either the documents are scanned (see OCR below) or the
parser needs adjusting for that district.

## 4. Local OCR (optional)

A large share of scanned minutes have no text layer. To read them locally you need two
binaries on `PATH`:

```bash
# Debian / Ubuntu
sudo apt-get install poppler-utils tesseract-ocr tesseract-ocr-eng

# macOS
brew install poppler tesseract

# Windows
winget install oschwartz10612.Poppler UB-Mannheim.TesseractOCR
```

Then set `"ocr": { "enabled": true, ... }` or run with `BOARDBOOK_OCR=1`.

Without them the pipeline still works — scanned pages simply produce no text, and the log
says so. CI installs both, so a scanned document missed locally gets picked up there.

## 5. The first backfill

A full archive is the expensive part. For ISD 281: ~1,133 meetings, and with
`attachmentsSinceDate: 2021-01-01`, roughly 400 meetings' worth of attachments at ~20-40
PDFs each. At the default 1.2 s delay that is **many hours**.

It is designed to be interrupted and resumed. `data/state.json` records every document
already extracted; `data/text/` holds the text. A re-run re-fetches nothing it already has.

**On GitHub Actions** — run the `Backfill archive` workflow repeatedly. Each run takes a
bounded chunk (default 5 hours, under the 6-hour job limit), commits what it got, and tells
you whether to run again. Repeat until it reports "No new documents."

**Locally** — same idea, in a loop:

```bash
# repeat until "documents: fetched=0"
node src/cli/scrape.js --max-seconds=3600
```

**Start with a slice.** `--months=N` limits a run to recent meetings, which is the sane way
to prove the pipeline works before committing hours to it:

```bash
node src/cli/scrape.js --months=6 --dry-run   # what would this cost?
node src/cli/scrape.js --months=6             # ~10 min on ISD 281
npm run build && npm run serve
```

Nothing is wasted by starting small. The text cache is additive, so widening the window
later only fetches what is genuinely new.

**Want something usable today?** Index metadata for everything first, then deepen:

```bash
node src/cli/scrape.js --skip-documents    # ~43 min: every meeting, agenda items only
npm run build                              # a small, immediately useful index
node src/cli/scrape.js --max-seconds=3600  # then backfill PDFs in chunks
```

Measured on ISD 281 at the default 1.2 s delay:

| Scope | Meetings | Estimated time |
|---|---|---|
| `--months=6` | 30 | ~10 min |
| `--months=18` | 116 | ~29 min |
| `--skip-documents` (all years, metadata only) | 1,133 | ~43 min |
| Full archive, attachments back to 2021 | 1,133 | ~3h 10m |

`--dry-run` prints this estimate for whatever scope you give it, using the attachment
density it has actually observed for your org.

> Do not lower `requestDelayMs` to speed this up. The backfill is slow on purpose.

## 6. Deploy

### GitHub Pages (default)

The workflows are written for it and need no external accounts.

1. Push the repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write** (the workflows
   commit the refreshed text cache).
4. Run `Backfill archive` until complete.
5. Run `Update index and deploy`, or wait for the Monday cron.

The site lands at `https://<user>.github.io/<repo>/`.

Note the repository must be public for Pages on a free account, which means the text cache
under `data/text/` is public too. That is fine — it is extracted from public documents —
but be deliberate about it.

### Cloudflare Pages / Netlify

Both work; you just supply the build.

- **Build command:** `npm ci && npm run build`
- **Output directory:** `dist`
- **Node version:** 22

Add a step to assemble `dist` (the GitHub workflow does this inline):

```bash
mkdir -p dist && cp -r site/. dist/ && cp data/site.db dist/site.db
```

Because `data/text/` is committed, the host rebuilds `site.db` from the repo without
scraping. Keep scraping in GitHub Actions and let the host rebuild on push.

Cloudflare Pages is the better choice if `site.db` gets large — its free tier has no
practical bandwidth cap, whereas Netlify's free tier is metered.

### Serving `site.db` well

- **Compression matters.** SQLite files compress well: measured on this corpus, gzip takes
  `site.db` to about a third of its size on disk (6.8 MB → 2.2 MB). All three hosts
  compress `application/octet-stream` automatically. Verify with
  `curl -sI -H 'Accept-Encoding: br,gzip' <url>/site.db | grep -i content-encoding`.
- **Cache headers.** The file changes weekly. A long `max-age` with revalidation is right;
  the defaults on all three hosts are acceptable.
- **The SQLite runtime is served from your own origin.** `site/vendor/` holds
  `index.mjs` and `sqlite3.wasm` (~1.5 MB together, cached after first load). They are
  copied out of `node_modules` by `npm run vendor`, which `npm run build`, `npm run serve`
  and `postinstall` all invoke — so you should never need to run it by hand. The directory
  is gitignored; it is a build artefact, not source.

### Expected index size

Measured on ISD 281 (40 meetings of 2026, attachments included):

| `attachmentsSinceDate` | Meetings with full text | `site.db` on disk | Over the wire |
|---|---|---|---|
| `2021-01-01` | ~310 | ~53 MB | ~17 MB |
| `2023-01-01` | ~165 | ~28 MB | ~9 MB |
| `2025-01-01` | ~90 | ~15 MB | ~5 MB |

Agenda-item metadata for all 1,133 meetings adds only a few MB on top. If the first-load
cost matters more to you than depth of history, move the date later; you can always move it
earlier again later, because the text cache is never discarded.

## 7. Keeping it running

`update.yml` runs Mondays at 06:20 UTC. To change that, edit the `cron` expression.

Match it to your board's cadence — a run the morning after a regular meeting picks up the
agenda and packet while people are still looking for them. Approved minutes typically
appear a meeting or two later and get picked up by a subsequent run.

Watch for:

- **Test failures in CI** — BoardBook changed their markup. Update the parser and the
  fixtures together.
- **`stats` showing a growing `site.db`** — tighten `attachmentsSinceDate`, or move to a
  server-side index (see below).
- **A scrape that fetches everything every run** — the incremental cache is not persisting.
  Confirm `data/state.json` and `data/text/` are being committed.

## 8. When to outgrow this design

The browser-side approach holds up while `site.db` stays small enough to download. Once it
becomes uncomfortable — a rough rule is somewhere past 50-100 MB compressed — the fix is to
move only the *query* stage server-side:

- A small API (Cloudflare Worker + D1, or any host with SQLite) running the same FTS5
  queries against the same schema, or
- A hosted search engine such as Meilisearch or Typesense fed from the same `documents`
  table.

The scraper, the extraction pipeline, `data/text/` and the schema are all unchanged. Only
`site/app.js` swaps its local SQLite calls for `fetch` calls. That upgrade path is why the schema
keeps text and index separate rather than baking everything into one blob.

## 9. Troubleshooting

**"Parsed 0 meetings from the organization page"**
The org id is wrong, the page requires a login, or the markup changed. Open
`https://meetings.boardbook.org/Public/Organization/<id>` in a browser and confirm you see
meetings while logged out.

**Attachments all show `with text 0`**
The PDFs are scanned. Install poppler + tesseract and enable OCR (step 4).

**`better-sqlite3` fails to install**
It needs a prebuilt binary for your Node version. Node 20 or 22 is safest; on an unusual
platform you may need build tools (`python3`, a C++ toolchain).

**The page says "Search is unavailable"**
Open the browser console. Usually `site.db` is not next to `index.html`, or the host is
serving it with the wrong content type. Confirm `<site>/site.db` downloads directly.

**Search finds nothing that should match**
Check `npm run stats` first — if the document has no text, the problem is extraction, not
search. Remember that FTS5 treats `-` and other punctuation as separators; quote phrases.
