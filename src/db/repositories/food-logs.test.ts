import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { FoodLogsRepository, FoodItem } from "./food-logs"

describe("FoodLogsRepository", () => {
  let db: Database
  let repo: FoodLogsRepository

  beforeEach(() => {
    db = createTestDb()
    repo = new FoodLogsRepository(db)
    db.run("INSERT INTO users (telegram_id) VALUES (1), (123)")
  })

  test("creates log with items", () => {
    const items: FoodItem[] = [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 120, protein_g: 4, emoji: "🍞" },
    ]
    const log = repo.create(123, 456, "2026-01-31", items)
    expect(log.id).toBeDefined()
    expect(log.items.length).toBe(2)
    expect(log.items[0].protein_g).toBe(12)
  })

  test("stores null protein when an item has none", () => {
    const log = repo.create(123, 456, "2026-01-31", [{ description: "Eggs", calories: 180, emoji: "🍳" }])
    expect(log.items[0].protein_g).toBeNull()
    expect(repo.getByDate(123, "2026-01-31")[0].items[0].protein_g).toBeNull()
  })

  test("gets entries for a specific date", () => {
    const items = [{ description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" }]
    repo.create(123, 456, "2026-01-31", items)
    repo.create(123, 456, "2026-01-30", items)

    const entries = repo.getByDate(123, "2026-01-31")
    expect(entries.length).toBe(1)
    expect(entries[0].items[0].protein_g).toBe(12)
  })

  test("getTotals sums calories and protein, skipping null protein", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 120, protein_g: 4, emoji: "🍞" },
      { description: "Mystery", calories: 50, protein_g: null },
    ])
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 350, protein: 16 })
  })

  test("getTotals returns zeros for an empty day", () => {
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 0, protein: 0 })
  })

  test("gets daily totals for date range", () => {
    repo.create(123, 456, "2026-01-30", [{ description: "Food", calories: 1000, protein_g: 60, emoji: "🍕" }])
    repo.create(123, 456, "2026-01-31", [{ description: "Food", calories: 1500, protein_g: null, emoji: "🍕" }])

    const totals = repo.getDailyTotals(123, "2026-01-25", "2026-01-31")
    expect(totals["2026-01-30"]).toEqual({ calories: 1000, protein: 60 })
    expect(totals["2026-01-31"]).toEqual({ calories: 1500, protein: 0 })
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

  test("updates calories, protein and description independently", () => {
    const log = repo.create(123, 456, "2026-01-31", [{ description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" }])
    const id = log.items[0].id!

    repo.updateItem(id, { calories: 200 })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0]).toMatchObject({ calories: 200, protein_g: 12 })

    repo.updateItem(id, { protein_g: 15 })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0]).toMatchObject({ calories: 200, protein_g: 15 })

    repo.updateItem(id, { protein_g: null })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0].protein_g).toBeNull()
  })

  test("getItemForUser returns the item only for its owner", () => {
    const log = repo.create(1, 100, "2026-09-25", [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const itemId = log.items[0].id!

    expect(repo.getItemForUser(itemId, 1)).toMatchObject({
      id: itemId,
      description: "Ramen",
      calories: 520,
      protein_g: 22,
      log_id: log.id,
    })
    expect(repo.getItemForUser(itemId, 2)).toBeNull()
    expect(repo.getItemForUser(99999, 1)).toBeNull()
  })

  describe("backfill queries", () => {
    test("lists distinct descriptions missing protein, in order", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Apple", calories: 95 },
        { description: "Ramen", calories: 540 },
        { description: "Eggs", calories: 180, protein_g: 12 },
      ])
      expect(repo.listDescriptionsMissingProtein()).toEqual(["Apple", "Ramen"])
      expect(repo.countItemsMissingProtein()).toBe(3)
    })

    test("setProteinForDescription fills only null rows with that exact description", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Ramen", calories: 540 },
        { description: "ramen", calories: 500 },
        { description: "Ramen", calories: 600, protein_g: 30 },
      ])

      expect(repo.setProteinForDescription("Ramen", 22)).toBe(2)

      const items = repo.getItemsByDate(1, "2026-09-25")
      expect(items.map((i) => i.protein_g)).toEqual([22, 22, null, 30])
      expect(repo.listDescriptionsMissingProtein()).toEqual(["ramen"])
    })
  })
})
