// src/jobs/reminders.test.ts
import { describe, test, expect, spyOn } from "bun:test"
import { GrammyError } from "grammy"
import { createTestDb } from "../db/test-helpers"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { FakeAnalytics } from "../analytics/test-helpers"
import { getCurrentTimeInTimezone } from "../utils/dates"
import { createReminderJob, formatReminderMessage } from "./reminders"

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

describe("createReminderJob error reporting", () => {
  /** A user whose reminder is due right now, and a job whose send always fails with `error`. */
  function setup(telegramId: number, error: unknown) {
    const db = createTestDb()
    const usersRepo = new UsersRepository(db)
    usersRepo.upsert(telegramId, "ray")
    usersRepo.updateSettings(telegramId, { timezone: "Asia/Manila", reminder_time: getCurrentTimeInTimezone("Asia/Manila") })
    const analytics = new FakeAnalytics()
    const bot = { api: { sendMessage: () => Promise.reject(error) } }
    const job = createReminderJob(bot as any, usersRepo, new FoodLogsRepository(db), analytics)
    return { job, analytics }
  }

  test("a failed reminder is reported", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const error = new Error("SQLITE_BUSY")
    const { job, analytics } = setup(9001, error)

    await job()

    expect(analytics.exceptions).toEqual([{ error, telegramId: 9001, properties: { source: "reminders" } }])
    errorLog.mockRestore()
  })

  test("a user who blocked the bot is logged, not reported", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const blocked = new GrammyError("(403)", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {})
    const { job, analytics } = setup(9002, blocked)

    await job()

    expect(analytics.exceptions).toEqual([])
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })
})
