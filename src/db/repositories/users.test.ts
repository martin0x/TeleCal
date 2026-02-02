// src/db/repositories/users.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { UsersRepository, User } from "./users"

describe("UsersRepository", () => {
  let db: Database
  let repo: UsersRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        ai_provider TEXT DEFAULT 'openai',
        daily_goal INTEGER,
        reminder_time TEXT,
        reminder_mention INTEGER DEFAULT 1,
        timezone TEXT DEFAULT 'Asia/Manila',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
    repo = new UsersRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates a new user", () => {
    const user = repo.upsert(123, "john")
    expect(user.telegram_id).toBe(123)
    expect(user.username).toBe("john")
    expect(user.ai_provider).toBe("openai")
  })

  test("updates existing user", () => {
    repo.upsert(123, "john")
    const user = repo.upsert(123, "johnny")
    expect(user.username).toBe("johnny")
  })

  test("finds user by telegram_id", () => {
    repo.upsert(123, "john")
    const user = repo.findById(123)
    expect(user?.username).toBe("john")
  })

  test("returns null for non-existent user", () => {
    const user = repo.findById(999)
    expect(user).toBeNull()
  })

  test("updates user settings", () => {
    repo.upsert(123, "john")
    repo.updateSettings(123, { daily_goal: 2000, ai_provider: "anthropic" })
    const user = repo.findById(123)
    expect(user?.daily_goal).toBe(2000)
    expect(user?.ai_provider).toBe("anthropic")
  })

  test("user has default timezone", () => {
    const user = repo.upsert(123, "john")
    expect(user.timezone).toBe("Asia/Manila")
  })

  test("updates user timezone", () => {
    repo.upsert(123, "john")
    repo.updateSettings(123, { timezone: "America/New_York" })
    const user = repo.findById(123)
    expect(user?.timezone).toBe("America/New_York")
  })
})
