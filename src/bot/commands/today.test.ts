// src/bot/commands/today.test.ts
import { describe, test, expect } from "bun:test"
import { buildTodayMessage } from "./today"
import { zeroTotals } from "../../macros"

const items = [
  { id: 1, description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" },
  { id: 2, description: "Toast", calories: 150, protein_g: null, emoji: "🍞" },
]

describe("buildTodayMessage", () => {
  test("lists items with protein and shows both goal blocks", () => {
    expect(
      buildTodayMessage({
        date: "2026-09-25",
        items,
        totals: { ...zeroTotals(), calories: 1450, protein: 82 },
        dailyGoal: 2000,
        proteinGoal: 120,
        macros: ["protein"],
      })
    ).toBe(
      "📅 Fri, Sep 25\n\n" +
        "1. 🍳 2 scrambled eggs — 180 cal · 14 g\n" +
        "2. 🍞 Toast — 150 cal · ? g\n\n" +
        "📊 Calories: 1,450 / 2,000 cal\n███████░░░ 73%\n✨ 550 cal remaining\n\n" +
        "💪 Protein: 82 / 120 g\n███████░░░ 68%\n✨ 38 g remaining"
    )
  })

  test("collapses a block to one line when that goal is not set", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { ...zeroTotals(), calories: 330, protein: 14 },
      dailyGoal: 2000,
      proteinGoal: null,
      macros: ["protein"],
    })
    expect(out).toContain("📊 Calories: 330 / 2,000 cal\n")
    expect(out.endsWith("\n\n💪 Protein: 14 g")).toBe(true)
  })

  test("shows plain totals with no goals at all", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { ...zeroTotals(), calories: 330, protein: 14 },
      dailyGoal: undefined,
      proteinGoal: undefined,
      macros: ["protein"],
    })
    expect(out.endsWith("📊 Calories: 330 cal\n\n💪 Protein: 14 g")).toBe(true)
  })

  test("extra macros get one line each, no emoji, under the protein block", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items: [{ id: 1, description: "Chicken adobo", calories: 420, protein_g: 38, fat_g: 24, fiber_g: 1, added_sugar_g: 2, emoji: "🍗" }],
      totals: { calories: 1050, protein: 50, fat: 36, fiber: 1, added_sugar: 2 },
      dailyGoal: 2000,
      proteinGoal: 120,
      macros: ["protein", "fat", "fiber", "added_sugar"],
    })
    expect(out).toBe(
      "📅 Fri, Sep 25\n\n" +
        "1. 🍗 Chicken adobo — 420 cal · 38 g · 24 g fat · 1 g fiber · 2 g sugar\n\n" +
        "📊 Calories: 1,050 / 2,000 cal\n█████░░░░░ 53%\n✨ 950 cal remaining\n\n" +
        "💪 Protein: 50 / 120 g\n████░░░░░░ 42%\n✨ 70 g remaining\n\n" +
        "Fat: 36 g\nFiber: 1 g\nAdded sugar: 2 g"
    )
  })

  test("with protein off, the extra lines follow the calorie block", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { calories: 330, protein: 14, fat: 9, fiber: 0, added_sugar: 0 },
      dailyGoal: undefined,
      proteinGoal: 120,
      macros: ["fat"],
    })
    expect(out.endsWith("📊 Calories: 330 cal\n\nFat: 9 g")).toBe(true)
    expect(out).not.toContain("Protein")
  })

  test("with no macros, only the calorie block", () => {
    const out = buildTodayMessage({ date: "2026-09-25", items, totals: { ...zeroTotals(), calories: 330 }, dailyGoal: undefined, proteinGoal: 120, macros: [] })
    expect(out.endsWith("2. 🍞 Toast — 150 cal\n\n📊 Calories: 330 cal")).toBe(true)
  })
})
