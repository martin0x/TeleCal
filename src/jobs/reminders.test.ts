// src/jobs/reminders.test.ts
import { describe, test, expect } from "bun:test"
import { formatReminderMessage } from "./reminders"

describe("formatReminderMessage", () => {
  test("shows both goals with percentages", () => {
    expect(formatReminderMessage("maria", true, { calories: 1450, protein: 82 }, 2000, 120, true)).toBe(
      "@maria Daily check-in 🍽️\n\n" +
        "Current: 1,450 / 2,000 cal (73%)\n" +
        "Protein: 82 / 120 g (68%)\n\n" +
        "550 cal remaining — keep it up!"
    )
  })

  test("shows a plain protein line without a protein goal", () => {
    expect(formatReminderMessage(null, false, { calories: 2100, protein: 95 }, 2000, null, true)).toBe(
      "Daily check-in 🍽️\n\n" +
        "Current: 2,100 / 2,000 cal (105%)\n" +
        "Protein: 95 g\n\n" +
        "You've reached your goal for today!"
    )
  })

  test("shows both totals without any goal", () => {
    expect(formatReminderMessage(null, false, { calories: 900, protein: 40 }, null, null, true)).toBe(
      "Daily check-in 🍽️\n\nToday's total: 900 cal\nProtein: 40 g"
    )
  })

  test("omits the protein line when nothing is logged", () => {
    expect(formatReminderMessage(null, false, { calories: 0, protein: 0 }, 2000, 120, false)).toBe(
      "Haven't seen any logs today! 🍽️\nCurrent: 0 cal | Goal: 2,000 cal\n\nUse /log to track what you've eaten."
    )
  })
})
