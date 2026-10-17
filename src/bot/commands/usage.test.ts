// src/bot/commands/usage.test.ts
import { describe, test, expect } from "bun:test"
import { formatUserUsage } from "./usage"

describe("formatUserUsage", () => {
  test("shows calls and tokens but never a dollar figure", () => {
    const message = formatUserUsage(
      { calls: 47, inputTokens: 21300, outputTokens: 4800, costUsd: 0.12 },
      30
    )

    expect(message).toContain("47 calls")
    expect(message).toContain("21,300")
    expect(message).toContain("4,800")
    expect(message).toContain("last 30 days")
    expect(message).not.toContain("$")
  })

  test("puts a blank line between the title and the numbers", () => {
    const message = formatUserUsage(
      { calls: 47, inputTokens: 21300, outputTokens: 4800, costUsd: 0.12 },
      30
    )

    expect(message).toBe("📊 Your AI usage — last 30 days\n\n47 calls · 21,300 in / 4,800 out tokens")
  })

  test("shows an empty state rather than a row of zeroes", () => {
    const message = formatUserUsage(
      { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      30
    )

    expect(message).not.toContain("0 calls")
    expect(message.toLowerCase()).toContain("no ai usage")
  })
})
