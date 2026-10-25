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
  emoji TEXT,
  FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
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
  call_type TEXT NOT NULL,      -- estimate | clarify | edit | retry | backfill
  status TEXT NOT NULL,         -- ok | parse_error | no_usage
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date
  ON ai_usage(telegram_id, created_at);

-- The emoji a member chose to head their replies in one group (/emoji).
-- Unique per chat, so no two members of a group share a badge.
CREATE TABLE IF NOT EXISTS group_badges (
  chat_id INTEGER NOT NULL,
  telegram_id INTEGER NOT NULL,
  emoji TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, telegram_id),
  UNIQUE (chat_id, emoji)
);
