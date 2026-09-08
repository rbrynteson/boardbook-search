# Legal and ethical notes

**Read this before you deploy anything publicly.** It is not legal advice. It sets out
what this project does, what the relevant rules appear to say, and which decisions are
yours (or your district's) to make.

---

## 1. The most important thing on this page

BoardBook's Terms and Conditions of Use contain a clause that covers this activity
directly. Under "In connection with your use of the Site you may NOT", the terms state
that you may not:

> "Copy or distribute any content from the Site in any manner (including, but not limited
> to through the use of any manual process, device, or any robot, spider, or other
> automatic process), **other than permissible copying from a subscriber's account or as
> authorized by Supplier**."

— [BoardBook Terms and Conditions of Use](https://www.boardbook.org/boardbook-terms-and-conditions-of-use?rname=termsofuse)
(emphasis added; retrieved 2026-09-08)

Read plainly, automated copying and republication of BoardBook content is prohibited by
default, and permitted in two situations:

1. copying that is permissible **from a subscriber's account**, or
2. copying that is **authorized by the Supplier** (BoardBook / TASB).

Your district is a BoardBook subscriber. That means the sanctioned path for this tool is
not "scrape quietly and hope" — it is to run it **with your district's knowledge and
authorization as the subscriber**, and/or with written permission from BoardBook.

**Do not deploy this publicly until you have settled that question.** Running it locally
against your own district's public page to evaluate it is a much smaller step than
standing up a public index; treat those as two separate decisions.

## 2. Why this is still a reasonable project

None of the above means the underlying material is secret or off-limits.

- **The records are public records.** In Minnesota, school board meeting materials are
  government data under the [Minnesota Government Data Practices Act](https://www.revisor.mn.gov/statutes/cite/13)
  (Minn. Stat. ch. 13), and meetings are governed by the
  [Open Meeting Law](https://www.revisor.mn.gov/statutes/cite/13D) (Minn. Stat. ch. 13D).
  Agendas, packets and minutes published for public meetings are public by design.
- **The responsible authority is the district, not the vendor.** BoardBook hosts the
  records; the district owns them and is the entity that must provide public data on
  request. A vendor's terms of use govern access to the vendor's website; they do not
  make public records non-public.
- **Nothing here touches private material.** The scraper only reads the unauthenticated
  public view. It performs no login, holds no credentials, and never attempts to reach
  member-only, closed-session or otherwise restricted content.

So the tension is not "public vs. secret". It is "the right way to obtain a copy of public
records" — and the cleanest answers route through the district rather than around the
vendor.

## 3. Paths that resolve the tension

Roughly in order of how clean they are:

1. **District-authorized use.** The district, as the BoardBook subscriber, sanctions the
   index. This fits the "permissible copying from a subscriber's account" carve-out most
   directly. It also means the tool becomes a district-supported service rather than a
   third-party surprise.
2. **Written authorization from BoardBook / TASB.** Ask. A vendor asked politely about a
   public-records search tool for one of its own customers may simply say yes, and that
   removes the ambiguity entirely.
3. **Get the records from the district instead of the site.** A Data Practices request, or
   a routine export from district staff, produces the same documents through the front
   door. The extraction, indexing and front-end stages of this repo work unchanged on
   locally supplied PDFs — only the scraper stage becomes unnecessary.
4. **Keep it private.** Run the pipeline locally and use the index yourself. Most of the
   value for a board member (finding a decision from three years ago in seconds) does not
   require a public deployment.

## 4. An additional note if you are a sitting board member

You flagged this yourself, and it is worth stating plainly in the repo. A board member
publishing a third-party index of their own district's records raises questions that have
nothing to do with software:

- Colleagues and staff should hear about it **before** it appears, not after.
- Anything that looks like an official district service should either be one, or be
  unmistakably labelled as not one. The front end and this repo both carry that
  disclaimer; keep it.
- If the tool is ever perceived as advancing a position rather than improving access, that
  perception will attach to you. Neutral framing, complete coverage, and links back to the
  authoritative originals all help.
- Check your district's policies on use of district data and on board member communication
  before publishing.

## 5. What the scraper does to be a good citizen

These are enforced in code, not just documented:

| Practice | Where |
|---|---|
| One request at a time, never parallel | `src/lib/http.js` |
| Minimum delay between requests (default 1200 ms) | `config/org.json` → `requestDelayMs` |
| Identifiable User-Agent with a contact URL | `config/org.json` → `userAgent` |
| Bounded retries with exponential backoff, honours `Retry-After` | `src/lib/http.js` |
| Incremental by default — unchanged meetings are never re-fetched | `src/lib/store.js`, `src/cli/scrape.js` |
| Wall-clock budget so a run cannot spin indefinitely | `--max-seconds` |
| Size cap per document | `config/org.json` → `maxAttachmentBytes` |
| Reads only the public, unauthenticated view | no auth code exists in this repo |

At the default settings a full weekly update is a few thousand requests spread over hours
— far less load than a handful of people browsing the site normally. **Do not lower
`requestDelayMs` to speed up a backfill.** The backfill is designed to be slow and
resumable precisely so that it stays courteous.

`meetings.boardbook.org` served no `robots.txt` when checked (HTTP 404), so there is no
machine-readable crawl policy to honour. Absence of a `robots.txt` is not permission; the
Terms of Use quoted above are the governing statement.

## 6. Data exposure

The entire `site.db` downloads to every visitor's browser. Whatever is in it is fully
public, permanently, to anyone who loads the page.

- Only index the public view. Never point this tool at authenticated content.
- Board packets sometimes contain material that is public-by-default but sensitive in
  aggregate — names of students or staff, addresses, personnel matters that were published
  in error. Full-text search makes such material dramatically easier to find than the
  original site does. That is the point of the tool, and it is also its main risk.
- Before a public deployment, spot-check the index for personal data, and agree with the
  district on a removal process for anything that should not have been published. A
  document removed from BoardBook will disappear from this index at the next run, but only
  if you actually run it.

## 7. Attribution and framing

- This is an independent, open-source project. It is not affiliated with, endorsed by, or
  supported by BoardBook, TASB, or any school district.
- Search results link back to the original documents on BoardBook. The originals are
  authoritative; the index is a finding aid and may be stale, incomplete, or wrong.
- Extracted text — especially OCR of scanned minutes — contains errors. Never quote this
  index as the record. Quote the document.

## 8. Licence

The code in this repository is MIT licensed. That licence covers the software only. It
grants no rights in the meeting documents, which remain public records of the relevant
district, subject to the terms discussed above.
