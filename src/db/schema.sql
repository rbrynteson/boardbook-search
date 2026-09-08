-- BoardBook search index.
--
-- The whole file downloads to every visitor's browser, so it holds only text
-- that is already public on meetings.boardbook.org, and stores each document's
-- text exactly once: `documents.text` is the source of truth and `documents_fts`
-- is an external-content FTS5 index over it.

PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE meetings (
  meeting_id   TEXT PRIMARY KEY,
  date         TEXT,            -- ISO yyyy-mm-dd
  year         INTEGER,
  time         TEXT,
  title        TEXT NOT NULL,   -- full "August 3, 2026 at 7:00 PM - Business Meeting"
  name         TEXT,            -- "Business Meeting"
  meeting_type TEXT,            -- Regular / Special / Working
  body         TEXT,            -- board | committee
  cancelled    INTEGER NOT NULL DEFAULT 0,
  location     TEXT,
  notes        TEXT,
  agenda_url   TEXT,
  minutes_url  TEXT,
  packet_url   TEXT,
  item_count   INTEGER NOT NULL DEFAULT 0,
  docs_indexed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX meetings_date ON meetings(date DESC);
CREATE INDEX meetings_year ON meetings(year);

-- One row per searchable unit: an agenda item, an attachment, or the minutes.
CREATE TABLE documents (
  id          INTEGER PRIMARY KEY,
  meeting_id  TEXT NOT NULL REFERENCES meetings(meeting_id),
  kind        TEXT NOT NULL,   -- agenda_item | attachment | minutes
  item_label  TEXT,            -- "6.A.1."
  item_title  TEXT,            -- agenda item heading
  title       TEXT,            -- document name (attachments) or item title
  presenter   TEXT,
  source_url  TEXT NOT NULL,   -- link back to BoardBook
  pages       INTEGER,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX documents_meeting ON documents(meeting_id, sort_order);
CREATE INDEX documents_kind ON documents(kind);

-- Field weights are applied at query time via bm25(); keeping title, item
-- context and body text in separate columns is what makes that possible.
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  item_title,
  presenter,
  text,
  content = 'documents',
  content_rowid = 'id',
  tokenize = "unicode61 remove_diacritics 2"
);
