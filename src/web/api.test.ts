// src/web/api.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
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
