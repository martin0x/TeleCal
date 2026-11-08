// src/web/api.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { FoodLibraryRepository } from "../db/repositories/food-library"
import { getTodayInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { hashTelegramId } from "../analytics"
import { createApiHandlers } from "./api"

const USER = 42
let api: ReturnType<typeof createApiHandlers>
let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository
let today: string

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(USER, "maria")
  today = getTodayInTimezone(DEFAULT_TIMEZONE)
  api = createApiHandlers({ usersRepo, foodLogsRepo })
})

describe("getUser", () => {
  test("adds daily_protein_goal beside daily_goal", () => {
    usersRepo.updateSettings(USER, { daily_goal: 2000, daily_protein_goal: 120 })
    expect(api.getUser(USER)).toEqual({
      daily_goal: 2000,
      daily_protein_goal: 120,
      tracked_macros: ["protein"],
      username: "maria",
      analytics_id: null,
      food_library: false,
    })
  })

  test("analytics_id is the hashed Telegram ID when analytics is on", () => {
    const withAnalytics = createApiHandlers({ usersRepo, foodLogsRepo, analyticsIdSecret: "s3cret" })
    expect(withAnalytics.getUser(USER).analytics_id).toBe(hashTelegramId(USER, "s3cret"))
  })

  test("analytics_id is null when analytics is off", () => {
    expect(api.getUser(USER).analytics_id).toBeNull()
  })

  test("tracked_macros follows /settings, in registry order", () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["added_sugar", "fat"] })
    expect(api.getUser(USER).tracked_macros).toEqual(["fat", "added_sugar"])
  })
})

describe("getToday / getDay", () => {
  test("keep total and add protein, with protein_g on each item", () => {
    foodLogsRepo.create(USER, 1, today, [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 150, protein_g: null, emoji: "🍞" },
    ])

    const result = api.getToday(USER)

    expect(result.date).toBe(today)
    expect(result.total).toBe(330)
    expect(result.protein).toBe(12)
    expect(result.items).toEqual([
      { id: expect.any(Number), description: "Eggs", calories: 180, protein_g: 12, fat_g: null, fiber_g: null, added_sugar_g: null, emoji: "🍳" },
      { id: expect.any(Number), description: "Toast", calories: 150, protein_g: null, fat_g: null, fiber_g: null, added_sugar_g: null, emoji: "🍞" },
    ])
    expect(api.getDay(USER, today)).toEqual(result)
  })

  test("add every macro's day total and per-item value", () => {
    foodLogsRepo.create(USER, 1, today, [
      { description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" },
      { description: "Rice", calories: 205, protein_g: 4, fat_g: 0, fiber_g: 1, added_sugar_g: 0, emoji: "🍚" },
    ])

    const result = api.getToday(USER)

    expect(result.total).toBe(625)
    expect(result.protein).toBe(42)
    expect(result.macros).toEqual({ protein: 42, fat: 24, fiber: 2, added_sugar: 2 })
    expect(result.items[0]).toMatchObject({ fat_g: 24, fiber_g: 1, added_sugar_g: 2 })
  })
})

describe("getStats", () => {
  test("keeps daily as calories and adds dailyProtein", () => {
    foodLogsRepo.create(USER, 1, today, [{ description: "Eggs", calories: 180, protein_g: 12 }])

    const stats = api.getStats(USER, "week")

    expect(Object.keys(stats.daily)).toHaveLength(7)
    expect(Object.keys(stats.dailyProtein)).toEqual(Object.keys(stats.daily))
    expect(stats.daily[today]).toBe(180)
    expect(stats.dailyProtein[today]).toBe(12)
    const yesterday = Object.keys(stats.daily).sort()[5]
    expect(stats.daily[yesterday]).toBe(0)
    expect(stats.dailyProtein[yesterday]).toBe(0)
  })

  test("adds dailyMacros per macro, aligned with daily", () => {
    foodLogsRepo.create(USER, 1, today, [{ description: "Adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2 }])

    const stats = api.getStats(USER, "week")

    expect(Object.keys(stats.dailyMacros)).toEqual(["protein", "fat", "fiber", "added_sugar"])
    for (const series of Object.values(stats.dailyMacros)) expect(Object.keys(series)).toEqual(Object.keys(stats.daily))
    expect(stats.dailyMacros.added_sugar[today]).toBe(2)
    expect(stats.dailyMacros.fat[Object.keys(stats.daily).sort()[5]]).toBe(0)
  })
})

describe("food library", () => {
  const OATS = { name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g" as const, calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }
  let library: FoodLibraryRepository
  let foodsApi: ReturnType<typeof createApiHandlers>

  beforeEach(() => {
    const db = createTestDb()
    library = new FoodLibraryRepository(db)
    const users = new UsersRepository(db)
    users.upsert(USER, "maria")
    foodsApi = createApiHandlers({ usersRepo: users, foodLogsRepo: new FoodLogsRepository(db), foodLibrary: library, foodLibraryEnabled: true })
    library.upsertMany(USER, [OATS, { ...OATS, name: "Skyflakes", calories: 110 }], "import")
  })

  test("getUser says whether the library is on", () => {
    expect(foodsApi.getUser(USER).food_library).toBe(true)
    expect(api.getUser(USER).food_library).toBe(false)
  })

  test("off: every foods route is 404", () => {
    const off = createApiHandlers({ usersRepo, foodLogsRepo, foodLibrary: library, foodLibraryEnabled: false })
    expect(off.listFoods(USER).status).toBe(404)
    expect(off.updateFood(USER, 1, {}).status).toBe(404)
    expect(off.deleteFoods(USER, { ids: [1] }).status).toBe(404)
  })

  test("listFoods: A–Z, every field", () => {
    const result = foodsApi.listFoods(USER)
    expect(result.status).toBe(200)
    const foods = (result.body as { foods: any[] }).foods
    expect(foods.map((f) => f.name)).toEqual(["Quaker Oats", "Skyflakes"])
    expect(foods[0]).toEqual({ id: foods[0].id, ...OATS })
    expect(foodsApi.listFoods(999).body).toEqual({ foods: [] })
  })

  test("updateFood: changes only the fields sent, validated", () => {
    const id = library.listByUser(USER)[0].id
    const ok = foodsApi.updateFood(USER, id, { calories: 160, fiber_g: null, unknown_field: 1 })
    expect(ok.status).toBe(200)
    expect((ok.body as any).food).toMatchObject({ name: "Quaker Oats", calories: 160, fiber_g: null, protein_g: 5 })

    expect(foodsApi.updateFood(USER, id, { calories: 9999 })).toEqual({ status: 400, body: { error: "calories out of range" } })
    expect(foodsApi.updateFood(USER, id, "nope").status).toBe(400)
    expect(foodsApi.updateFood(999, id, { calories: 1 }).status).toBe(404)
    expect(foodsApi.updateFood(USER, id, { name: "skyflakes" })).toEqual({
      status: 409,
      body: { error: "You already have a food called skyflakes" },
    })
  })

  test("deleteFoods: all or nothing, ids checked", () => {
    const [oats, sky] = library.listByUser(USER)
    expect(foodsApi.deleteFoods(USER, { ids: [] }).status).toBe(400)
    expect(foodsApi.deleteFoods(USER, { ids: ["1"] }).status).toBe(400)
    expect(foodsApi.deleteFoods(USER, null).status).toBe(400)
    expect(foodsApi.deleteFoods(USER, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }).status).toBe(400)
    expect(foodsApi.deleteFoods(999, { ids: [oats.id] }).status).toBe(404)
    expect(library.count(USER)).toBe(2)
    expect(foodsApi.deleteFoods(USER, { ids: [oats.id, sky.id] })).toEqual({ status: 200, body: { deleted: 2 } })
    expect(library.count(USER)).toBe(0)
  })
})
