// src/db/repositories/cache.ts
import { Database } from "bun:sqlite"
import type { EstimationResult, CachedEstimation } from "../../ai/types"

export class CacheRepository {
  constructor(private db: Database) {}

  get(normalizedFood: string): EstimationResult | null {
    const stmt = this.db.prepare(
      "SELECT result_json FROM estimation_cache WHERE normalized_food = ?"
    )
    const row = stmt.get(normalizedFood) as CachedEstimation | null
    return row ? (JSON.parse(row.result_json) as EstimationResult) : null
  }

  set(normalizedFood: string, result: EstimationResult): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO estimation_cache (normalized_food, result_json, created_at)
      VALUES (?, ?, datetime('now'))
    `)
    stmt.run(normalizedFood, JSON.stringify(result))
  }
}
