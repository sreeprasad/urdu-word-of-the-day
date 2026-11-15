-- One row per day: the word of the day and the past word to practice.
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD in America/Los_Angeles
  word_id INTEGER NOT NULL,
  review_word_id INTEGER          -- NULL on the first day
);

-- Your practice sentences.
CREATE TABLE IF NOT EXISTS practice (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  word_id INTEGER NOT NULL,
  sentence1 TEXT NOT NULL,
  sentence2 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS practice_word ON practice (word_id);
CREATE INDEX IF NOT EXISTS practice_date ON practice (date);
