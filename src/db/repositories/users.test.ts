// src/db/repositories/users.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { UsersRepository, User } from "./users"
import { createTestDb } from "../test-helpers"

describe("UsersRepository", () => {
  let db: Database
  let repo: UsersRepository

  beforeEach(() => {
    db = createTestDb()
    repo = new UsersRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates a new user", () => {
    const user = repo.upsert(123, "john")
    expect(user.telegram_id).toBe(123)
    expect(user.username).toBe("john")
    expect(user.ai_provider).toBe("gemini")
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

  test("round-trips the daily protein goal", () => {
    repo.upsert(123, "john")
    expect(repo.findById(123)!.daily_protein_goal).toBeNull()

    repo.updateSettings(123, { daily_protein_goal: 120 })
    expect(repo.findById(123)!.daily_protein_goal).toBe(120)

    repo.updateSettings(123, { daily_protein_goal: null })
    expect(repo.findById(123)!.daily_protein_goal).toBeNull()
  })
})

describe("UsersRepository analytics_content", () => {
  test("is on for a new user and round-trips", () => {
    const repo = new UsersRepository(createTestDb())
    expect(repo.upsert(123, "john").analytics_content).toBe(true)

    repo.updateSettings(123, { analytics_content: false })
    expect(repo.findById(123)!.analytics_content).toBe(false)

    repo.updateSettings(123, { analytics_content: true })
    expect(repo.findById(123)!.analytics_content).toBe(true)
  })
})

describe("UsersRepository tracked_macros", () => {
  test("a new user tracks protein only", () => {
    const repo = new UsersRepository(createTestDb())
    expect(repo.upsert(123, "john").tracked_macros).toEqual(["protein"])
  })

  test("round-trips in registry order, including none", () => {
    const repo = new UsersRepository(createTestDb())
    repo.upsert(123, "john")

    repo.updateSettings(123, { tracked_macros: ["added_sugar", "protein"] })
    expect(repo.findById(123)!.tracked_macros).toEqual(["protein", "added_sugar"])

    repo.updateSettings(123, { tracked_macros: [] })
    expect(repo.findById(123)!.tracked_macros).toEqual([])
  })

  test("getUsersWithReminders carries them too", () => {
    const repo = new UsersRepository(createTestDb())
    repo.upsert(123, "john")
    repo.updateSettings(123, { reminder_time: "20:00", tracked_macros: ["fiber"] })
    expect(repo.getUsersWithReminders()[0].tracked_macros).toEqual(["fiber"])
  })
})
