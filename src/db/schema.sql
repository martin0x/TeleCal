-- src/db/schema.sql

-- Allowed users (access control)
CREATE TABLE IF NOT EXISTS allowed_users (
  telegram_id INTEGER PRIMARY KEY,
  added_by INTEGER,
  added_at TEXT DEFAULT (datetime('now'))
);

-- Users and their preferences
CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  ai_provider TEXT DEFAULT 'openai',
  daily_goal INTEGER,
  reminder_time TEXT,
  reminder_mention INTEGER DEFAULT 1,
  timezone TEXT DEFAULT 'Asia/Manila',
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
