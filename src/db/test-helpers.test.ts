// src/db/test-helpers.test.ts
import { describe, test, expect } from "bun:test"
import { createTestDb } from "./test-helpers"

describe("createTestDb", () => {
  test("applies the production schema", () => {
    const db = createTestDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)

    expect(names).toContain("users")
    expect(names).toContain("food_logs")
    expect(names).toContain("estimation_cache")
    expect(names).toContain("ai_usage")
  })

  test("ai_usage has every column the usage repository writes", () => {
    const db = createTestDb()
    const columns = db.prepare("PRAGMA table_info(ai_usage)").all() as { name: string }[]
    const names = columns.map((c) => c.name)

    expect(names).toEqual([
      "id",
      "telegram_id",
      "chat_id",
      "provider",
      "model",
      "input_tokens",
      "cached_input_tokens",
      "cache_write_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cost_usd",
      "call_type",
      "status",
      "created_at",
    ])
  })

  test("each call returns an isolated database", () => {
    const a = createTestDb()
    const b = createTestDb()
    a.run("INSERT INTO users (telegram_id) VALUES (1)")

    expect(b.prepare("SELECT COUNT(*) as n FROM users").get()).toEqual({ n: 0 })
  })

  test("food_items and users carry the protein columns", () => {
    const db = createTestDb()
    const names = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

    expect(names("food_items")).toContain("protein_g")
    expect(names("users")).toContain("daily_protein_goal")
  })
})
