// src/bot/commands/today.test.ts
import { describe, test, expect } from "bun:test"
import { buildTodayMessage } from "./today"

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
        totals: { calories: 1450, protein: 82 },
        dailyGoal: 2000,
        proteinGoal: 120,
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
      totals: { calories: 330, protein: 14 },
      dailyGoal: 2000,
      proteinGoal: null,
    })
    expect(out).toContain("📊 Calories: 330 / 2,000 cal\n")
    expect(out.endsWith("\n\n💪 Protein: 14 g")).toBe(true)
  })

  test("shows plain totals with no goals at all", () => {
    const out = buildTodayMessage({
      date: "2026-09-25",
      items,
      totals: { calories: 330, protein: 14 },
      dailyGoal: undefined,
      proteinGoal: undefined,
    })
    expect(out.endsWith("📊 Calories: 330 cal\n\n💪 Protein: 14 g")).toBe(true)
  })
})
