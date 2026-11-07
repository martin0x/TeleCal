import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { FoodLogsRepository, FoodItem } from "./food-logs"
import { MACROS, zeroTotals } from "../../macros"

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

  test("items read back carry every macro column, null when unknown", () => {
    repo.create(123, 456, "2026-01-31", [{ description: "Eggs", calories: 180 }])
    const item = repo.getByDate(123, "2026-01-31")[0].items[0] as Record<string, unknown>
    for (const m of MACROS) expect(item[m.column]).toBeNull()
  })

  test("getTotals sums calories and protein, skipping null protein", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 120, protein_g: 4, emoji: "🍞" },
      { description: "Mystery", calories: 50, protein_g: null },
    ])
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ ...zeroTotals(), calories: 350, protein: 16 })
  })

  test("getTotals returns zeros for an empty day", () => {
    expect(repo.getTotals(123, "2026-01-31")).toEqual(zeroTotals())
  })

  test("gets daily totals for date range", () => {
    repo.create(123, 456, "2026-01-30", [{ description: "Food", calories: 1000, protein_g: 60, emoji: "🍕" }])
    repo.create(123, 456, "2026-01-31", [{ description: "Food", calories: 1500, protein_g: null, emoji: "🍕" }])

    const totals = repo.getDailyTotals(123, "2026-01-25", "2026-01-31")
    expect(totals["2026-01-30"]).toEqual({ ...zeroTotals(), calories: 1000, protein: 60 })
    expect(totals["2026-01-31"]).toEqual({ ...zeroTotals(), calories: 1500, protein: 0 })
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

  test("stores and sums fat, fiber and added sugar", () => {
    repo.create(123, 456, "2026-01-31", [
      { description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2 },
      { description: "Rice", calories: 205, protein_g: 4, fat_g: 0, fiber_g: 1, added_sugar_g: 0 },
      { description: "Mystery", calories: 50 },
    ])
    const items = repo.getByDate(123, "2026-01-31")[0].items
    expect(items[0]).toMatchObject({ fat_g: 24, fiber_g: 1, added_sugar_g: 2 })
    expect(items[2]).toMatchObject({ fat_g: null, fiber_g: null, added_sugar_g: null })
    expect(repo.getTotals(123, "2026-01-31")).toEqual({ calories: 675, protein: 42, fat: 24, fiber: 2, added_sugar: 2 })
  })

  test("updateItem sets one new macro alone", () => {
    const id = repo.create(123, 456, "2026-01-31", [{ description: "Adobo", calories: 420, protein_g: 38 }]).items[0].id!
    repo.updateItem(id, { added_sugar_g: 3 })
    expect(repo.getByDate(123, "2026-01-31")[0].items[0]).toMatchObject({ protein_g: 38, added_sugar_g: 3, fat_g: null })
  })

  test("fillMissingMacros fills the new columns and leaves protein alone", () => {
    repo.create(1, 100, "2026-09-25", [{ description: "Adobo", calories: 420, protein_g: 38 }])
    expect(repo.listDescriptionsMissingMacros()).toEqual(["Adobo"])

    expect(repo.fillMissingMacros("Adobo", { protein_g: 30, fat_g: 24, fiber_g: 1, added_sugar_g: 2 })).toBe(1)

    expect(repo.getItemsByDate(1, "2026-09-25")[0]).toMatchObject({ protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2 })
    expect(repo.listDescriptionsMissingMacros()).toEqual([])
  })

  describe("backfill queries", () => {
    /** Every macro known, so the item has no gap. */
    const complete = Object.fromEntries(MACROS.map((m) => [m.column, 12]))

    test("lists distinct descriptions with any macro missing, in order", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Apple", calories: 95 },
        { description: "Ramen", calories: 540 },
        { description: "Eggs", calories: 180, ...complete },
      ])
      expect(repo.listDescriptionsMissingMacros()).toEqual(["Apple", "Ramen"])
      expect(repo.countItemsMissingMacros()).toBe(3)
    })

    test("fillMissingMacros fills only null cells of rows with that exact description", () => {
      repo.create(1, 100, "2026-09-25", [
        { description: "Ramen", calories: 520 },
        { description: "Ramen", calories: 540 },
        { description: "ramen", calories: 500 },
        { description: "Ramen", calories: 600, protein_g: 30 },
      ])

      expect(repo.fillMissingMacros("Ramen", { protein_g: 22 })).toBe(2)

      const items = repo.getItemsByDate(1, "2026-09-25")
      expect(items.map((i) => i.protein_g)).toEqual([22, 22, null, 30])
    })

    test("fillMissingMacros with no values changes nothing", () => {
      repo.create(1, 100, "2026-09-25", [{ description: "Ramen", calories: 520 }])
      expect(repo.fillMissingMacros("Ramen", {})).toBe(0)
    })
  })
})
