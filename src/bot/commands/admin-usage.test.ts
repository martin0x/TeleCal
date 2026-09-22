// src/bot/commands/admin-usage.test.ts
import { describe, test, expect } from "bun:test"
import { formatAdminUsage, parseUsageWindow } from "./admin"
import type { UserUsageRow, ModelUsageRow } from "../../db/repositories/usage"

function user(over: Partial<UserUsageRow>): UserUsageRow {
  return {
    telegramId: 1,
    username: null,
    calls: 10,
    inputTokens: 1000,
    outputTokens: 100,
    costUsd: 0.01,
    ...over,
  }
}

describe("parseUsageWindow", () => {
  test("defaults to 30 days", () => {
    expect(parseUsageWindow(undefined)).toBe(30)
  })

  test("accepts 7d, 30d and all", () => {
    expect(parseUsageWindow("7d")).toBe(7)
    expect(parseUsageWindow("30d")).toBe(30)
    expect(parseUsageWindow("all")).toBe(0)
  })

  test("falls back to 30 days for anything else", () => {
    expect(parseUsageWindow("banana")).toBe(30)
  })
})

describe("formatAdminUsage", () => {
  const models: ModelUsageRow[] = [
    { model: "gpt-5.6-luna", calls: 320, inputTokens: 100, outputTokens: 10, costUsd: 1.12 },
  ]

  test("shows totals, per-user rows with dollars, and the model breakdown", () => {
    const users = [
      user({ telegramId: 123456789, username: "ray", costUsd: 0.91, calls: 205 }),
      user({ telegramId: 987654321, costUsd: 0.63, calls: 140 }),
    ]

    const message = formatAdminUsage(users, models, 30)

    expect(message).toContain("last 30 days")
    expect(message).toContain("$1.54")            // 0.91 + 0.63
    expect(message).toContain("345 calls")        // 205 + 140
    expect(message).toContain("123456789 (@ray)")
    expect(message).toContain("987654321")
    expect(message).toContain("gpt-5.6-luna")
  })

  test("caps the user list at ten and summarises the remainder", () => {
    const users = Array.from({ length: 13 }, (_, i) =>
      user({ telegramId: i + 1, costUsd: (13 - i) / 100 })
    )

    const message = formatAdminUsage(users, models, 30)
    const bulletCount = (message.match(/^• /gm) ?? []).length

    expect(bulletCount).toBe(11)                   // 10 users + 1 model row
    expect(message).toContain("and 3 more")
  })

  test("shows an empty state when nothing is recorded", () => {
    expect(formatAdminUsage([], [], 30).toLowerCase()).toContain("no ai usage")
  })

  test("labels the all-time window", () => {
    expect(formatAdminUsage([user({})], models, 0)).toContain("all time")
  })
})
