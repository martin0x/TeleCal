// src/db/repositories/usage.ts
import { Database } from "bun:sqlite"
import type { CallType, UsageStatus } from "../../ai/types"

export interface UsageEntry {
  telegramId: number
  chatId: number | null
  provider: string
  model: string
  inputTokens: number
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number
  reasoningTokens: number | null
  costUsd: number
  callType: CallType
  status: UsageStatus
}

export interface UsageTotals {
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface UserUsageRow extends UsageTotals {
  telegramId: number
  username: string | null
}

export interface ModelUsageRow extends UsageTotals {
  model: string
}

const TOTALS_COLUMNS = `
  COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cost_usd), 0) AS costUsd
`

/**
 * Builds the time-window predicate. sinceDays of 0 (or less) means all time.
 * The value is coerced to a non-negative integer before interpolation, since
 * SQLite cannot parameterise the modifier string of datetime().
 */
function windowClause(sinceDays: number, prefix: "WHERE" | "AND"): string {
  const days = Math.max(0, Math.floor(sinceDays))
  if (days === 0) return ""
  return ` ${prefix} created_at >= datetime('now', '-${days} days')`
}

export class UsageRepository {
  constructor(private db: Database) {}

  record(entry: UsageEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO ai_usage (
        telegram_id, chat_id, provider, model,
        input_tokens, cached_input_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens,
        cost_usd, call_type, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      entry.telegramId,
      entry.chatId,
      entry.provider,
      entry.model,
      entry.inputTokens,
      entry.cachedInputTokens,
      entry.cacheWriteTokens,
      entry.outputTokens,
      entry.reasoningTokens,
      entry.costUsd,
      entry.callType,
      entry.status
    )
  }

  getUserTotals(telegramId: number, sinceDays: number): UsageTotals {
    const stmt = this.db.prepare(`
      SELECT ${TOTALS_COLUMNS}
      FROM ai_usage
      WHERE telegram_id = ?${windowClause(sinceDays, "AND")}
    `)
    return stmt.get(telegramId) as UsageTotals
  }

  getAllUserTotals(sinceDays: number): UserUsageRow[] {
    // Both ai_usage and users have telegram_id and created_at columns, so the
    // window predicate must be qualified with the ai_usage alias.
    const window = windowClause(sinceDays, "WHERE").replace("created_at", "u.created_at")
    const stmt = this.db.prepare(`
      SELECT
        u.telegram_id AS telegramId,
        users.username AS username,
        ${TOTALS_COLUMNS}
      FROM ai_usage u
      LEFT JOIN users ON users.telegram_id = u.telegram_id
      ${window}
      GROUP BY u.telegram_id, users.username
      ORDER BY costUsd DESC
    `)
    return stmt.all() as UserUsageRow[]
  }

  getModelBreakdown(sinceDays: number): ModelUsageRow[] {
    const stmt = this.db.prepare(`
      SELECT model, ${TOTALS_COLUMNS}
      FROM ai_usage
      ${windowClause(sinceDays, "WHERE")}
      GROUP BY model
      ORDER BY costUsd DESC
    `)
    return stmt.all() as ModelUsageRow[]
  }
}
