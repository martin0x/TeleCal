// src/db/repositories/cache.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { CacheRepository } from "./cache"
import type { EstimationResult } from "../../ai/types"

let db: Database
let repo: CacheRepository

const RESULT: EstimationResult = {
  items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
  needsClarification: false,
  confidence: "high",
}

beforeEach(() => {
  db = createTestDb()
  repo = new CacheRepository(db)
})

test("returns null for a miss", () => {
  expect(repo.get("chicken adobo")).toBeNull()
})

test("round-trips a stored estimate", () => {
  repo.set("chicken adobo", RESULT)
  expect(repo.get("chicken adobo")).toEqual(RESULT)
})

test("overwrites an existing entry for the same key", () => {
  repo.set("chicken adobo", RESULT)
  repo.set("chicken adobo", { ...RESULT, items: [{ description: "Adobo", calories: 500 }] })

  expect(repo.get("chicken adobo")!.items[0].calories).toBe(500)
  expect(db.prepare("SELECT COUNT(*) as n FROM estimation_cache").get()).toEqual({ n: 1 })
})
