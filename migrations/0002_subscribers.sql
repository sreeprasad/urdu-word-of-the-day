-- Email subscribers. Practice sentences now live in each visitor's browser,
-- so the old practice table is no longer used (left in place, harmless).
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,                 -- used in confirm/unsubscribe links
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | active | unsubscribed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirm_sent_date TEXT,                     -- YYYY-MM-DD the last confirmation email went out
  confirmed_at TEXT,
  last_sent_date TEXT                         -- YYYY-MM-DD the last daily word went out
);

CREATE INDEX IF NOT EXISTS subscribers_status ON subscribers (status, last_sent_date);
CREATE INDEX IF NOT EXISTS subscribers_confirm ON subscribers (confirm_sent_date);
