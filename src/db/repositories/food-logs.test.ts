// src/db/repositories/food-logs.test.ts
import { describe, test, expect, beforeEach, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { FoodLogsRepository, FoodItem } from "./food-logs"

describe("FoodLogsRepository", () => {
  let db: Database
  let repo: FoodLogsRepository

  beforeEach(() => {
    db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")
    db.run(`
      CREATE TABLE food_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        logged_at TEXT DEFAULT (datetime('now')),
        target_date TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE food_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        calories INTEGER NOT NULL,
        emoji TEXT,
        FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
      )
    `)
    repo = new FoodLogsRepository(db)
  })

  afterAll(() => {
    db.close()
  })

  test("creates log with items", () => {
    const items: FoodItem[] = [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ]
    const log = repo.create(123, 456, "2026-01-31", items)
    expect(log.id).toBeDefined()
    expect(log.items.length).toBe(2)
  })

  test("gets entries for a specific date", () => {
    const items = [{ description: "Eggs", calories: 180, emoji: "🍳" }]
    repo.create(123, 456, "2026-01-31", items)
    repo.create(123, 456, "2026-01-30", items)

    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries.length).toBe(1)
  })

  test("calculates total calories for a date", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ])
    const total = repo.getTotalCalories(123, "2026-01-31")
    expect(total).toBe(300)
  })

  test("gets daily totals for date range", () => {
    repo.create(123, 456, "2026-01-30", [
      { description: "Food", calories: 1000, emoji: "🍕" },
    ])
    repo.create(123, 456, "2026-01-31", [
      { description: "Food", calories: 1500, emoji: "🍕" },
    ])

    const totals = repo.getDailyTotals(123, "2026-01-25", "2026-01-31")
    expect(totals["2026-01-30"]).toBe(1000)
    expect(totals["2026-01-31"]).toBe(1500)
  })

  test("deletes a food item", () => {
    const log = repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 120, emoji: "🍞" },
    ])
    repo.deleteItem(log.items[0].id!)
    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries[0].items.length).toBe(1)
  })

  test("updates a food item", () => {
    const log = repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, emoji: "🍳" },
    ])
    repo.updateItem(log.items[0].id!, { calories: 200 })
    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries[0].items[0].calories).toBe(200)
  })

  test("getItemForUser returns the item only for its owner", () => {
    const log = repo.create(1, 100, "2026-09-25", [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const itemId = log.items[0].id!

    expect(repo.getItemForUser(itemId, 1)).toMatchObject({
      id: itemId,
      description: "Ramen",
      calories: 520,
      log_id: log.id,
    })
    expect(repo.getItemForUser(itemId, 2)).toBeNull()
    expect(repo.getItemForUser(99999, 1)).toBeNull()
  })
})
