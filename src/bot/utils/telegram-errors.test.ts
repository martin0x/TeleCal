// src/bot/utils/telegram-errors.test.ts
import { describe, test, expect } from "bun:test"
import { GrammyError } from "grammy"
import { isExpectedTelegramError } from "./telegram-errors"

function telegramError(code: number, description: string) {
  return new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, "sendMessage", {})
}

describe("isExpectedTelegramError", () => {
  test("a user who blocked the bot or deleted their account is expected", () => {
    expect(isExpectedTelegramError(telegramError(403, "Forbidden: bot was blocked by the user"))).toBe(true)
    expect(isExpectedTelegramError(telegramError(403, "Forbidden: user is deactivated"))).toBe(true)
  })

  test("a chat the bot can't reach is expected", () => {
    expect(isExpectedTelegramError(telegramError(400, "Bad Request: chat not found"))).toBe(true)
  })

  test("re-editing a message to the same text is expected", () => {
    expect(isExpectedTelegramError(telegramError(400, "Bad Request: message is not modified"))).toBe(true)
  })

  test("other Telegram errors and non-Telegram errors are not", () => {
    expect(isExpectedTelegramError(telegramError(400, "Bad Request: can't parse entities"))).toBe(false)
    expect(isExpectedTelegramError(telegramError(429, "Too Many Requests: retry after 3"))).toBe(false)
    expect(isExpectedTelegramError(new Error("SQLITE_BUSY"))).toBe(false)
  })
})
