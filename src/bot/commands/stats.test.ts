// src/bot/commands/stats.test.ts
import { describe, test, expect } from "bun:test"
import { buildStatsMessage } from "./stats"

// Mon 2026-09-21 .. Sun 2026-09-27
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]

describe("buildStatsMessage (week)", () => {
  const dailyTotals = {
    "2026-09-21": { calories: 1450, protein: 82 },
    "2026-09-22": { calories: 2100, protein: 130 },
    "2026-09-25": { calories: 1800, protein: 100 },
  }

  test("renders daily rows with protein, both totals, and both goal lines", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals, dailyGoal: 2000, proteinGoal: 120 })

    expect(out).toContain("📊 Week Summary\nMon, Sep 21 - Sun, Sep 27\n\n")
    expect(out).toContain("Mon: ████░ 1,450 cal · 82 g\n")
    expect(out).toContain("Tue: █████ 2,100 cal · 130 g\n")
    expect(out).toContain("Wed: ░░░░░ —\n")
    expect(out).toContain("\n📈 Total: 5,350 cal · 312 g protein\n")
    expect(out).toContain("📊 Daily avg: 1,783 cal · 104 g protein\n")
    expect(out).toContain("📅 Days tracked: 3/7")
    expect(out).toContain("\n🎯 Under calorie goal: 2/3 days (67%)")
    expect(out).toContain("\n💪 Protein goal met: 1/3 days (33%)")
  })

  test("counts protein at the goal as met", () => {
    const out = buildStatsMessage({
      period: "Week",
      days: 7,
      dateRange: WEEK,
      dailyTotals: { "2026-09-21": { calories: 1000, protein: 120 } },
      dailyGoal: null,
      proteinGoal: 120,
    })
    expect(out).toContain("💪 Protein goal met: 1/1 days (100%)")
    expect(out).not.toContain("Under calorie goal")
  })

  test("omits goal lines when no goals are set", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals, dailyGoal: undefined, proteinGoal: undefined })
    expect(out).not.toContain("goal")
  })

  test("says so when nothing was logged", () => {
    const out = buildStatsMessage({ period: "Week", days: 7, dateRange: WEEK, dailyTotals: {}, dailyGoal: 2000, proteinGoal: 120 })
    expect(out).toBe("📊 Week Summary\nMon, Sep 21 - Sun, Sep 27\n\nNo data logged for this period.\n\nUse /log to start tracking!")
  })
})

describe("buildStatsMessage (month)", () => {
  test("renders weekly rows with both units and per-day averages", () => {
    const dateRange: string[] = []
    for (let d = 1; d <= 30; d++) dateRange.push(`2026-09-${String(d).padStart(2, "0")}`)
    const dailyTotals: Record<string, { calories: number; protein: number }> = {
      "2026-09-01": { calories: 9800, protein: 520 }, // all of week 1 on one day
      "2026-09-10": { calories: 1400, protein: 70 },
    }

    const out = buildStatsMessage({ period: "Month", days: 30, dateRange, dailyTotals, dailyGoal: null, proteinGoal: null })

    expect(out).toContain("Week 1: 9,800 cal · 520 g protein (avg 1,400 cal · 74 g/day)\n")
    expect(out).toContain("Week 2: 1,400 cal · 70 g protein (avg 200 cal · 10 g/day)\n")
    expect(out).toContain("Week 3: 0 cal · 0 g protein (avg 0 cal · 0 g/day)\n")
    expect(out).toContain("📅 Days tracked: 2/30")
  })
})
