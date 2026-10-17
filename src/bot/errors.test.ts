// src/bot/errors.test.ts
import { describe, test, expect, spyOn } from "bun:test"
import { BotError } from "grammy"
import { FakeAnalytics } from "../analytics/test-helpers"
import { createBotErrorHandler } from "./errors"

function botError(error: unknown, update: Record<string, unknown>, fromId?: number) {
  const ctx = { update, from: fromId === undefined ? undefined : { id: fromId } }
  return new BotError(error, ctx as any)
}

describe("createBotErrorHandler", () => {
  test("logs and reports the error with the user and the update's id and type", () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const analytics = new FakeAnalytics()
    const error = new Error("boom")

    createBotErrorHandler(analytics)(botError(error, { update_id: 9, message: { text: "/log" } }, 42))

    expect(analytics.exceptions).toEqual([
      { error, telegramId: 42, properties: { source: "bot", update_id: 9, update_type: "message" } },
    ])
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })

  test("an expected Telegram error is logged but not reported", () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const analytics = new FakeAnalytics()
    const { GrammyError } = require("grammy")
    const blocked = new GrammyError("(403)", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {})

    createBotErrorHandler(analytics)(botError(blocked, { update_id: 9, message: {} }, 42))

    expect(analytics.exceptions).toEqual([])
    errorLog.mockRestore()
  })
})
