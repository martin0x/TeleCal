// src/web/api.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { getTodayInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
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
    expect(api.getUser(USER)).toEqual({ daily_goal: 2000, daily_protein_goal: 120, username: "maria" })
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
      { id: expect.any(Number), description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { id: expect.any(Number), description: "Toast", calories: 150, protein_g: null, emoji: "🍞" },
    ])
    expect(api.getDay(USER, today)).toEqual(result)
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
})
