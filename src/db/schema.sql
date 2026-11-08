-- src/db/schema.sql

-- Allowed users (access control)
CREATE TABLE IF NOT EXISTS allowed_users (
  telegram_id INTEGER PRIMARY KEY,
  added_by INTEGER,
  added_at TEXT DEFAULT (datetime('now'))
);

-- Access requests from non-allowlisted users (deep link from the landing page)
CREATE TABLE IF NOT EXISTS access_requests (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | declined
  requested_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER
);

-- One row per user per one-off announcement (e.g. a privacy notice), so a
-- broadcast can be re-run without messaging anyone twice
CREATE TABLE IF NOT EXISTS announcements_sent (
  announcement TEXT NOT NULL,
  telegram_id INTEGER NOT NULL,
  sent_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (announcement, telegram_id)
);

-- Users and their preferences
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  ai_provider TEXT DEFAULT 'gemini',
  daily_goal INTEGER,
  daily_protein_goal INTEGER,
  reminder_time TEXT,
  reminder_mention INTEGER DEFAULT 1,
  timezone TEXT DEFAULT 'Asia/Manila',
  -- 0 = keep meal text (prompts, AI replies, error messages) out of PostHog (/settings)
  analytics_content INTEGER DEFAULT 1,
  -- comma list of macro keys shown beside calories (/settings → Macros); '' = none
  tracked_macros TEXT DEFAULT 'protein',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Food log entries (one per /log session)
CREATE TABLE IF NOT EXISTS food_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  logged_at TEXT DEFAULT (datetime('now')),
  target_date TEXT NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Individual food items within a log
CREATE TABLE IF NOT EXISTS food_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  calories INTEGER NOT NULL,
  protein_g INTEGER,            -- whole grams; null = not yet estimated
  fat_g INTEGER,                -- whole grams; null = not yet estimated
  fiber_g INTEGER,              -- whole grams; null = not yet estimated
  added_sugar_g INTEGER,        -- whole grams; null = not yet estimated
  emoji TEXT,
  -- The saved food this item came from (food_library.id); null = not from the library.
  -- No foreign key: values are copied at log time, so a deleted food leaves a harmless dangling id.
  saved_food_id INTEGER,
  FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
);

-- A user's saved foods: label values per serving (/foods, Mini App Foods tab)
CREATE TABLE IF NOT EXISTS food_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,   -- normalizeFoodName(name); matching and duplicates
  serving TEXT NOT NULL,           -- the label's wording, e.g. '1/2 cup (40 g)'
  serving_amount REAL,             -- 40; null when the label gives no amount
  serving_unit TEXT,               -- 'g' | 'ml'; null exactly when serving_amount is
  calories INTEGER NOT NULL,       -- per serving
  protein_g REAL,                  -- per serving; null = not on the label
  fat_g REAL,
  fiber_g REAL,
  added_sugar_g REAL,
  source TEXT NOT NULL,            -- import | single | log
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (telegram_id, normalized_name)
);

-- Active conversations for /log flow
CREATE TABLE IF NOT EXISTS conversation_state (
  telegram_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  pending_food TEXT,
  pending_items TEXT,
  context TEXT,
  target_date TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Entries waiting for AI processing
CREATE TABLE IF NOT EXISTS pending_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  food_text TEXT NOT NULL,
  submitted_at TEXT DEFAULT (datetime('now')),
  target_date TEXT NOT NULL,
  retry_count INTEGER DEFAULT 0,
  last_retry_at TEXT
);

-- Cache for AI estimations
CREATE TABLE IF NOT EXISTS estimation_cache (
  normalized_food TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Per-call AI usage and cost accounting
-- No FK to users: usage history must outlive the user record it describes.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL,
  chat_id INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  -- Subset of input_tokens billed at the cached rate. Null when unreported.
  cached_input_tokens INTEGER,
  -- Subset of input_tokens written to cache. Recorded, not separately priced.
  cache_write_tokens INTEGER,
  output_tokens INTEGER NOT NULL,
  -- Subset of output_tokens, NEVER added to it. Billed as output. OpenAI only.
  reasoning_tokens INTEGER,
  cost_usd REAL NOT NULL,
  call_type TEXT NOT NULL,      -- estimate | clarify | edit | retry | backfill | import
  status TEXT NOT NULL,         -- ok | parse_error | no_usage
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date
  ON ai_usage(telegram_id, created_at);
