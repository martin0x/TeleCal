// src/process-errors.test.ts
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { FakeAnalytics } from "./analytics/test-helpers"
import { createProcessErrorHandlers } from "./process-errors"

let errorLog: ReturnType<typeof spyOn>
beforeEach(() => {
  errorLog = spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  errorLog.mockRestore()
})

describe("createProcessErrorHandlers", () => {
  test("an unhandled rejection is logged and reported, and the process keeps running", () => {
    const analytics = new FakeAnalytics()
    const exits: number[] = []
    const handlers = createProcessErrorHandlers({ analytics, exit: (code) => exits.push(code) })
    const reason = new Error("forgot an await")

    handlers.onUnhandledRejection(reason)

    expect(analytics.exceptions).toEqual([{ error: reason, telegramId: undefined, properties: { source: "unhandledRejection" } }])
    expect(exits).toEqual([])
  })

  test("an uncaught exception is reported, flushed, then the process exits with 1", async () => {
    const order: string[] = []
    const analytics = new FakeAnalytics()
    analytics.shutdown = async () => {
      order.push("flushed")
    }
    const handlers = createProcessErrorHandlers({ analytics, exit: (code) => order.push(`exit ${code}`) })
    const error = new Error("boom")

    await handlers.onUncaughtException(error)

    expect(analytics.exceptions).toEqual([{ error, telegramId: undefined, properties: { source: "uncaughtException" } }])
    expect(order).toEqual(["flushed", "exit 1"])
  })
})
