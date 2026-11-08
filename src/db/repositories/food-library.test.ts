import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../test-helpers"
import { FoodLibraryRepository } from "./food-library"
import type { FoodFields } from "../../library/types"

const USER = 42
const OTHER = 99

function fields(overrides: Partial<FoodFields> = {}): FoodFields {
  return {
    name: "Quaker Oats",
    serving: "1/2 cup (40 g)",
    serving_amount: 40,
    serving_unit: "g",
    calories: 150,
    protein_g: 5,
    fat_g: 3,
    fiber_g: 4,
    added_sugar_g: null,
    ...overrides,
  }
}

let repo: FoodLibraryRepository

beforeEach(() => {
  repo = new FoodLibraryRepository(createTestDb())
})

describe("FoodLibraryRepository", () => {
  test("upsertMany adds foods and lists them A–Z ignoring case", () => {
    const result = repo.upsertMany(
      USER,
      [fields({ name: "skyflakes" }), fields({ name: "Quaker Oats" }), fields({ name: "banana" })],
      "import"
    )
    expect(result).toEqual({ added: 3, replaced: 0 })
    const foods = repo.listByUser(USER)
    expect(foods.map((f) => f.name)).toEqual(["banana", "Quaker Oats", "skyflakes"])
    expect(foods[1]).toMatchObject({ ...fields(), telegram_id: USER, source: "import" })
    expect(repo.count(USER)).toBe(3)
  })

  test("a name that matches ignoring case and punctuation replaces the saved food", () => {
    repo.upsertMany(USER, [fields()], "import")
    const result = repo.upsertMany(USER, [fields({ name: "quaker oats!", calories: 160 })], "single")
    expect(result).toEqual({ added: 0, replaced: 1 })
    const [only, ...rest] = repo.listByUser(USER)
    expect(rest).toHaveLength(0)
    expect(only).toMatchObject({ name: "quaker oats!", calories: 160, source: "single" })
  })

  test("keeps decimal macros", () => {
    repo.upsertMany(USER, [fields({ fat_g: 0.5 })], "import")
    expect(repo.listByUser(USER)[0].fat_g).toBe(0.5)
  })

  test("everything is scoped to its owner", () => {
    repo.upsertMany(USER, [fields()], "import")
    const id = repo.listByUser(USER)[0].id
    expect(repo.listByUser(OTHER)).toEqual([])
    expect(repo.count(OTHER)).toBe(0)
    expect(repo.get(OTHER, id)).toBeNull()
    expect(repo.get(USER, id)?.name).toBe("Quaker Oats")
  })

  test("update changes a food, refuses another user's, and refuses a name already taken", () => {
    repo.upsertMany(USER, [fields(), fields({ name: "Skyflakes", calories: 110 })], "import")
    const [oats, skyflakes] = repo.listByUser(USER)

    expect(repo.update(USER, oats.id, fields({ calories: 160 }))).toBe("ok")
    expect(repo.get(USER, oats.id)?.calories).toBe(160)

    expect(repo.update(OTHER, oats.id, fields({ calories: 1 }))).toBe("not_found")
    expect(repo.update(USER, skyflakes.id, fields({ name: "QUAKER OATS" }))).toBe("name_taken")
    expect(repo.get(USER, skyflakes.id)?.name).toBe("Skyflakes")
  })

  test("deleteMany deletes the user's foods, all or nothing", () => {
    repo.upsertMany(USER, [fields(), fields({ name: "Skyflakes" })], "import")
    repo.upsertMany(OTHER, [fields({ name: "Banana" })], "import")
    const [oats, skyflakes] = repo.listByUser(USER)
    const banana = repo.listByUser(OTHER)[0]

    expect(repo.deleteMany(USER, [oats.id, banana.id])).toBe("not_found")
    expect(repo.count(USER)).toBe(2)
    expect(repo.count(OTHER)).toBe(1)

    expect(repo.deleteMany(USER, [oats.id, oats.id, skyflakes.id])).toBe(2)
    expect(repo.count(USER)).toBe(0)
    expect(repo.deleteMany(USER, [])).toBe(0)
  })
})
