// src/db/repositories/pending.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { PendingRepository } from "./pending"

describe("PendingRepository", () => {
  let db: Database
  let repo: PendingRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE pending_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        food_text TEXT NOT NULL,
        submitted_at TEXT DEFAULT (datetime('now')),
        target_date TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        last_retry_at TEXT
      )
    `)
    repo = new PendingRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates pending entry", () => {
    const entry = repo.create(123, 456, "chicken and rice", "2026-01-31")
    expect(entry.id).toBeDefined()
    expect(entry.food_text).toBe("chicken and rice")
  })

  test("gets pending entries for user", () => {
    repo.create(123, 456, "entry 1", "2026-01-31")
    repo.create(123, 456, "entry 2", "2026-01-31")

    const entries = repo.getByUser(123)
    expect(entries.length).toBe(2)
  })

  test("deletes entry", () => {
    const entry = repo.create(123, 456, "entry", "2026-01-31")
    repo.delete(entry.id)
    expect(repo.getByUser(123).length).toBe(0)
  })
})
