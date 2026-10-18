// src/db/migrations.test.ts
import { describe, test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { runMigrations, hasColumn } from "./migrations"

/** users, food_logs and food_items exactly as they were before protein tracking. */
function preProteinDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.run(`
    CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      ai_provider TEXT DEFAULT 'gemini',
      daily_goal INTEGER,
      reminder_time TEXT,
      reminder_mention INTEGER DEFAULT 1,
      timezone TEXT DEFAULT 'Asia/Manila',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE food_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      logged_at TEXT DEFAULT (datetime('now')),
      target_date TEXT NOT NULL
    );
    CREATE TABLE food_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      calories INTEGER NOT NULL,
      emoji TEXT,
      FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
    );
  `)
  db.run("INSERT INTO users (telegram_id, username, daily_goal) VALUES (42, 'maria', 2000)")
  db.run("INSERT INTO food_logs (telegram_id, chat_id, target_date) VALUES (42, 555, '2026-09-30')")
  db.run("INSERT INTO food_items (log_id, description, calories, emoji) VALUES (1, 'Ramen', 520, '🍜')")
  return db
}

describe("runMigrations", () => {
  test("adds protein_g and daily_protein_goal to a pre-feature database", () => {
    const db = preProteinDb()
    expect(hasColumn(db, "food_items", "protein_g")).toBe(false)
    expect(hasColumn(db, "users", "daily_protein_goal")).toBe(false)

    runMigrations(db, undefined, () => {})

    expect(hasColumn(db, "food_items", "protein_g")).toBe(true)
    expect(hasColumn(db, "users", "daily_protein_goal")).toBe(true)
  })

  test("leaves existing rows intact, with null in the new columns", () => {
    const db = preProteinDb()
    runMigrations(db, undefined, () => {})

    expect(db.prepare("SELECT description, calories, protein_g FROM food_items").get()).toEqual({
      description: "Ramen",
      calories: 520,
      protein_g: null,
    })
    expect(db.prepare("SELECT daily_goal, daily_protein_goal FROM users").get()).toEqual({
      daily_goal: 2000,
      daily_protein_goal: null,
    })
  })

  test("adds users.analytics_content, on for existing users", () => {
    const db = preProteinDb()
    runMigrations(db, undefined, () => {})

    expect(db.prepare("SELECT analytics_content FROM users").get()).toEqual({ analytics_content: 1 })
  })

  test("is a no-op the second time", () => {
    const db = preProteinDb()
    runMigrations(db, undefined, () => {})

    expect(() => runMigrations(db, undefined, () => {})).not.toThrow()
    const cols = db.prepare("PRAGMA table_info(food_items)").all() as { name: string }[]
    expect(cols.filter((c) => c.name === "protein_g")).toHaveLength(1)
  })
})
