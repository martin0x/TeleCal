// src/db/repositories/usage.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { UsageRepository, type UsageEntry } from "./usage"

let db: Database
let repo: UsageRepository

function entry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    telegramId: 1,
    chatId: 100,
    provider: "openai",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 0,
    costUsd: 0.00008,
    callType: "estimate",
    status: "ok",
    ...over,
  }
}

beforeEach(() => {
  db = createTestDb()
  repo = new UsageRepository(db)
})

describe("record", () => {
  test("round-trips every column", () => {
    repo.record(
      entry({
        telegramId: 42,
        chatId: -1001,
        provider: "gemini",
        model: "gemini-3.1-flash-lite",
        inputTokens: 300,
        cachedInputTokens: 120,
        cacheWriteTokens: 30,
        outputTokens: 80,
        reasoningTokens: 12,
        costUsd: 0.000165,
        callType: "clarify",
        status: "parse_error",
      })
    )

    const row = db.prepare("SELECT * FROM ai_usage").get() as any
    expect(row.telegram_id).toBe(42)
    expect(row.chat_id).toBe(-1001)
    expect(row.provider).toBe("gemini")
    expect(row.model).toBe("gemini-3.1-flash-lite")
    expect(row.input_tokens).toBe(300)
    expect(row.cached_input_tokens).toBe(120)
    expect(row.cache_write_tokens).toBe(30)
    expect(row.output_tokens).toBe(80)
    expect(row.reasoning_tokens).toBe(12)
    expect(row.cost_usd).toBeCloseTo(0.000165, 10)
    expect(row.call_type).toBe("clarify")
    expect(row.status).toBe("parse_error")
    expect(row.created_at).toBeTruthy()
  })

  test("accepts null chat_id and null optional token counts", () => {
    repo.record(
      entry({ chatId: null, cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null })
    )

    const row = db.prepare("SELECT * FROM ai_usage").get() as any
    expect(row.chat_id).toBeNull()
    expect(row.cached_input_tokens).toBeNull()
    expect(row.reasoning_tokens).toBeNull()
  })
})

describe("getUserTotals", () => {
  test("sums only the requested user", () => {
    repo.record(entry({ telegramId: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.01 }))
    repo.record(entry({ telegramId: 1, inputTokens: 200, outputTokens: 20, costUsd: 0.02 }))
    repo.record(entry({ telegramId: 2, inputTokens: 900, outputTokens: 90, costUsd: 0.09 }))

    const totals = repo.getUserTotals(1, 30)
    expect(totals.calls).toBe(2)
    expect(totals.inputTokens).toBe(300)
    expect(totals.outputTokens).toBe(30)
    expect(totals.costUsd).toBeCloseTo(0.03, 10)
  })

  test("includes non-ok rows, because those tokens were still billed", () => {
    repo.record(entry({ telegramId: 1, costUsd: 0.01, status: "ok" }))
    repo.record(entry({ telegramId: 1, costUsd: 0.02, status: "parse_error" }))
    repo.record(entry({ telegramId: 1, costUsd: 0.03, status: "no_usage" }))

    const totals = repo.getUserTotals(1, 30)
    expect(totals.calls).toBe(3)
    expect(totals.costUsd).toBeCloseTo(0.06, 10)
  })

  test("returns zeroes rather than nulls for a user with no rows", () => {
    const totals = repo.getUserTotals(999, 30)
    expect(totals).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })

  test("excludes rows older than the window", () => {
    repo.record(entry({ telegramId: 1, costUsd: 0.01 }))
    db.run("UPDATE ai_usage SET created_at = datetime('now', '-40 days')")
    repo.record(entry({ telegramId: 1, costUsd: 0.02 }))

    expect(repo.getUserTotals(1, 30).calls).toBe(1)
  })

  test("sinceDays of 0 means all time", () => {
    repo.record(entry({ telegramId: 1 }))
    db.run("UPDATE ai_usage SET created_at = datetime('now', '-400 days')")
    repo.record(entry({ telegramId: 1 }))

    expect(repo.getUserTotals(1, 0).calls).toBe(2)
  })
})

describe("getAllUserTotals", () => {
  test("groups by user, ordered by cost descending", () => {
    db.run("INSERT INTO users (telegram_id, username) VALUES (1, 'ray')")
    repo.record(entry({ telegramId: 1, costUsd: 0.01 }))
    repo.record(entry({ telegramId: 2, costUsd: 0.05 }))

    const rows = repo.getAllUserTotals(30)
    expect(rows).toHaveLength(2)
    expect(rows[0].telegramId).toBe(2)
    expect(rows[0].costUsd).toBeCloseTo(0.05, 10)
    expect(rows[1].telegramId).toBe(1)
    expect(rows[1].username).toBe("ray")
  })

  test("includes users with usage but no users row", () => {
    // Admins bypass the allowlist and may never be inserted into users.
    repo.record(entry({ telegramId: 777, costUsd: 0.01 }))

    const rows = repo.getAllUserTotals(30)
    expect(rows).toHaveLength(1)
    expect(rows[0].telegramId).toBe(777)
    expect(rows[0].username).toBeNull()
  })
})

describe("getModelBreakdown", () => {
  test("groups by model, ordered by cost descending", () => {
    repo.record(entry({ model: "gpt-5.6-luna", costUsd: 0.01 }))
    repo.record(entry({ model: "gpt-5.6-luna", costUsd: 0.02 }))
    repo.record(entry({ model: "gemini-3.1-flash-lite", costUsd: 0.10 }))

    const rows = repo.getModelBreakdown(30)
    expect(rows).toHaveLength(2)
    expect(rows[0].model).toBe("gemini-3.1-flash-lite")
    expect(rows[1].model).toBe("gpt-5.6-luna")
    expect(rows[1].calls).toBe(2)
    expect(rows[1].costUsd).toBeCloseTo(0.03, 10)
  })
})
