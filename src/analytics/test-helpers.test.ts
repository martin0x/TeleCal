// src/analytics/test-helpers.test.ts
import { describe, test, expect } from "bun:test"
import { FakeAnalytics } from "./test-helpers"

describe("FakeAnalytics", () => {
  test("records captures, exceptions and shutdowns with the raw Telegram ID", async () => {
    const analytics = new FakeAnalytics()
    const error = new Error("boom")

    analytics.capture(123, "something_happened", { call_type: "estimate" })
    analytics.captureException(error, 123, { update_id: 42 })
    await analytics.shutdown()

    expect(analytics.events).toEqual([{ telegramId: 123, event: "something_happened", properties: { call_type: "estimate" } }])
    expect(analytics.exceptions).toEqual([{ error, telegramId: 123, properties: { update_id: 42 } }])
    expect(analytics.shutdowns).toBe(1)
  })
})
