// src/web/connector-tools.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { getTodayInTimezone, addDays } from "../utils/dates"
import { createConnectorTools, ToolInputError, MAX_RANGE_DAYS, DEFAULT_RANGE_DAYS, type ConnectorTools } from "./connector-tools"

const USER = 42
const OTHER = 99
let tools: ConnectorTools
let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(USER, "maria")
  usersRepo.upsert(OTHER, "someone")
  tools = createConnectorTools({ usersRepo, foodLogsRepo })
})

describe("getProfile", () => {
  test("gives goals, the user's today and the span of their log", () => {
    usersRepo.updateSettings(USER, { daily_goal: 2000, daily_protein_goal: 120, timezone: "America/New_York" })
    foodLogsRepo.create(USER, 1, "2026-01-05", [{ description: "Eggs", calories: 180 }])
    foodLogsRepo.create(USER, 1, "2026-03-01", [{ description: "Toast", calories: 120 }])

    expect(tools.getProfile(USER)).toEqual({
      today: getTodayInTimezone("America/New_York"),
      timezone: "America/New_York",
      daily_calorie_goal: 2000,
      daily_protein_goal_g: 120,
      first_logged_date: "2026-01-05",
      last_logged_date: "2026-03-01",
    })
  })

  test("nulls for a user with no goals and nothing logged", () => {
    const profile = tools.getProfile(USER)
    expect(profile.daily_calorie_goal).toBeNull()
    expect(profile.daily_protein_goal_g).toBeNull()
    expect(profile.first_logged_date).toBeNull()
  })
})

describe("getDailyTotals", () => {
  test("lists every date, marking unlogged ones rather than calling them zero", () => {
    foodLogsRepo.create(USER, 1, "2026-01-01", [{ description: "Eggs", calories: 180, protein_g: 12 }])
    foodLogsRepo.create(USER, 1, "2026-01-01", [{ description: "Rice", calories: 200, protein_g: null }])
    foodLogsRepo.create(USER, 1, "2026-01-03", [{ description: "Toast", calories: 120, protein_g: 4 }])

    const result = tools.getDailyTotals(USER, { start_date: "2026-01-01", end_date: "2026-01-03" })

    expect(result.start_date).toBe("2026-01-01")
    expect(result.end_date).toBe("2026-01-03")
    expect(result.days).toEqual([
      { date: "2026-01-01", logged: true, calories: 380, protein_g: 12 },
      { date: "2026-01-02", logged: false, calories: 0, protein_g: 0 },
      { date: "2026-01-03", logged: true, calories: 120, protein_g: 4 },
    ])
  })

  test("defaults to the last 30 days ending on the user's today", () => {
    const today = getTodayInTimezone("Asia/Manila")
    const result = tools.getDailyTotals(USER, {})

    expect(result.end_date).toBe(today)
    expect(result.start_date).toBe(addDays(today, -(DEFAULT_RANGE_DAYS - 1)))
    expect(result.days).toHaveLength(DEFAULT_RANGE_DAYS)
  })

  test("returns only the caller's data", () => {
    foodLogsRepo.create(OTHER, 1, "2026-01-01", [{ description: "Pizza", calories: 800 }])

    const result = tools.getDailyTotals(USER, { start_date: "2026-01-01", end_date: "2026-01-01" })
    expect(result.days[0]).toEqual({ date: "2026-01-01", logged: false, calories: 0, protein_g: 0 })
  })

  test("rejects malformed and impossible dates", () => {
    expect(() => tools.getDailyTotals(USER, { start_date: "yesterday" })).toThrow(ToolInputError)
    expect(() => tools.getDailyTotals(USER, { start_date: "2026-02-30", end_date: "2026-03-01" })).toThrow(
      "start_date must be a date in YYYY-MM-DD form"
    )
  })

  test("rejects a reversed range", () => {
    expect(() => tools.getDailyTotals(USER, { start_date: "2026-02-01", end_date: "2026-01-01" })).toThrow(
      "start_date 2026-02-01 is after end_date 2026-01-01"
    )
  })

  test(`allows exactly ${MAX_RANGE_DAYS} days and no more`, () => {
    const end = "2026-12-31"
    const longest = tools.getDailyTotals(USER, { start_date: addDays(end, -(MAX_RANGE_DAYS - 1)), end_date: end })
    expect(longest.days).toHaveLength(MAX_RANGE_DAYS)

    expect(() => tools.getDailyTotals(USER, { start_date: addDays(end, -MAX_RANGE_DAYS), end_date: end })).toThrow(
      `at most ${MAX_RANGE_DAYS} days`
    )
  })
})

describe("getDay", () => {
  test("lists items with totals, keeping unknown protein as null", () => {
    foodLogsRepo.create(USER, 1, "2026-01-01", [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Rice", calories: 200 },
    ])
    foodLogsRepo.create(OTHER, 1, "2026-01-01", [{ description: "Pizza", calories: 800 }])

    expect(tools.getDay(USER, "2026-01-01")).toEqual({
      date: "2026-01-01",
      calories: 380,
      protein_g: 12,
      items: [
        { description: "Eggs", calories: 180, protein_g: 12 },
        { description: "Rice", calories: 200, protein_g: null },
      ],
    })
  })

  test("an empty day has no items", () => {
    expect(tools.getDay(USER, "2026-01-01")).toEqual({ date: "2026-01-01", calories: 0, protein_g: 0, items: [] })
  })

  test("rejects a bad date", () => {
    expect(() => tools.getDay(USER, "2026-1-1")).toThrow(ToolInputError)
  })
})

describe("getSummary", () => {
  test("averages over logged days and counts days against the goals", () => {
    usersRepo.updateSettings(USER, { daily_goal: 2000, daily_protein_goal: 100 })
    foodLogsRepo.create(USER, 1, "2026-01-01", [{ description: "Coffee", calories: 1500, protein_g: 120 }])
    foodLogsRepo.create(USER, 1, "2026-01-02", [{ description: "coffee", calories: 2500, protein_g: 80 }])
    foodLogsRepo.create(USER, 1, "2026-01-04", [{ description: "Pizza", calories: 2001, protein_g: 100 }])

    expect(tools.getSummary(USER, { start_date: "2026-01-01", end_date: "2026-01-07" })).toEqual({
      start_date: "2026-01-01",
      end_date: "2026-01-07",
      days_in_range: 7,
      days_logged: 3,
      average_calories: 2000,
      average_protein_g: 100,
      daily_calorie_goal: 2000,
      days_over_calorie_goal: 2,
      daily_protein_goal_g: 100,
      days_meeting_protein_goal: 2,
      lowest_day: { date: "2026-01-01", calories: 1500 },
      highest_day: { date: "2026-01-02", calories: 2500 },
      top_foods: [
        { description: "Coffee", times: 2, calories: 4000 },
        { description: "Pizza", times: 1, calories: 2001 },
      ],
    })
  })

  test("nulls rather than zeros when there is nothing to measure", () => {
    const summary = tools.getSummary(USER, { start_date: "2026-01-01", end_date: "2026-01-07" })

    expect(summary.days_logged).toBe(0)
    expect(summary.average_calories).toBeNull()
    expect(summary.days_over_calorie_goal).toBeNull()
    expect(summary.days_meeting_protein_goal).toBeNull()
    expect(summary.lowest_day).toBeNull()
    expect(summary.top_foods).toEqual([])
  })

  test("validates its range like getDailyTotals", () => {
    expect(() => tools.getSummary(USER, { start_date: "2026-02-01", end_date: "2026-01-01" })).toThrow(ToolInputError)
  })
})
