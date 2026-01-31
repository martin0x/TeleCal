// src/db/repositories/conversations.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { ConversationsRepository } from "./conversations"

describe("ConversationsRepository", () => {
  let db: Database
  let repo: ConversationsRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE conversation_state (
        telegram_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        pending_food TEXT,
        pending_items TEXT,
        context TEXT,
        target_date TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `)
    repo = new ConversationsRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates conversation state", () => {
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    const state = repo.get(123)
    expect(state?.state).toBe("awaiting_input")
  })

  test("updates existing state", () => {
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    repo.upsert(123, 456, "clarifying", "2026-01-31", {
      pending_food: "chicken",
    })
    const state = repo.get(123)
    expect(state?.state).toBe("clarifying")
  })

  test("deletes conversation state", () => {
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    repo.delete(123)
    expect(repo.get(123)).toBeNull()
  })

  test("checks if conversation exists", () => {
    expect(repo.exists(123)).toBe(false)
    repo.upsert(123, 456, "awaiting_input", "2026-01-31")
    expect(repo.exists(123)).toBe(true)
  })
})
