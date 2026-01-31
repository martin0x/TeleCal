// src/db/repositories/allowed-users.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { AllowedUsersRepository } from "./allowed-users"

describe("AllowedUsersRepository", () => {
  let db: Database
  let repo: AllowedUsersRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run(`
      CREATE TABLE allowed_users (
        telegram_id INTEGER PRIMARY KEY,
        added_by INTEGER,
        added_at TEXT DEFAULT (datetime('now'))
      )
    `)
    repo = new AllowedUsersRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("adds user to allowlist", () => {
    repo.add(123, 999)
    expect(repo.isAllowed(123)).toBe(true)
  })

  test("checks if user is allowed", () => {
    expect(repo.isAllowed(123)).toBe(false)
    repo.add(123, 999)
    expect(repo.isAllowed(123)).toBe(true)
  })

  test("removes user from allowlist", () => {
    repo.add(123, 999)
    repo.remove(123)
    expect(repo.isAllowed(123)).toBe(false)
  })

  test("lists all allowed users", () => {
    repo.add(123, 999)
    repo.add(456, 999)
    const users = repo.listAll()
    expect(users.length).toBe(2)
  })
})
