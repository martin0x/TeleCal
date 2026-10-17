// src/jobs/report.test.ts
import { describe, test, expect, spyOn } from "bun:test"
import { FakeAnalytics } from "../analytics/test-helpers"
import { reportJobFailure } from "./report"

describe("reportJobFailure", () => {
  test("logs and reports a failed job run under its source", () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const analytics = new FakeAnalytics()
    const error = new Error("SQLITE_BUSY")

    reportJobFailure(analytics, "reminders")(error)

    expect(analytics.exceptions).toEqual([{ error, telegramId: undefined, properties: { source: "reminders" } }])
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })
})
