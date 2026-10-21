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
  latencyMs?: number | null
  /** Set on request_failed rows; see describeFailure. */
  error?: string | null
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

export interface ProviderHealthRow {
  provider: string
  /** Calls in the window, failed ones included. */
  calls: number
  failures: number
  /** Median latency of the calls that got a reply, in the window. */
  p50LatencyMs: number | null
  /** All time, not just the window. SQLite UTC datetimes. */
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
}

/** Rows for calls that got no reply. Kept out of cost and call totals. */
const FAILED = "'request_failed'"

const TOTALS_COLUMNS = `
  COUNT(*) AS calls,
  COALESCE(SUM(input_tokens), 0) AS inputTokens,
  COALESCE(SUM(output_tokens), 0) AS outputTokens,
  COALESCE(SUM(cost_usd), 0) AS costUsd
`

/**
 * Builds the time-window predicate, to follow an existing WHERE. sinceDays of
 * 0 (or less) means all time.
 * The value is coerced to a non-negative integer before interpolation, since
 * SQLite cannot parameterise the modifier string of datetime().
 */
function windowClause(sinceDays: number): string {
  const days = Math.max(0, Math.floor(sinceDays))
  if (days === 0) return ""
  return ` AND created_at >= datetime('now', '-${days} days')`
}

export class UsageRepository {
  constructor(private db: Database) {}

  record(entry: UsageEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO ai_usage (
        telegram_id, chat_id, provider, model,
        input_tokens, cached_input_tokens, cache_write_tokens,
        output_tokens, reasoning_tokens,
        cost_usd, call_type, status, latency_ms, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      entry.status,
      entry.latencyMs == null ? null : Math.round(entry.latencyMs),
      entry.error ?? null
    )
  }

  getUserTotals(telegramId: number, sinceDays: number): UsageTotals {
    const stmt = this.db.prepare(`
      SELECT ${TOTALS_COLUMNS}
      FROM ai_usage
      WHERE telegram_id = ? AND status != ${FAILED}${windowClause(sinceDays)}
    `)
    return stmt.get(telegramId) as UsageTotals
  }

  getAllUserTotals(sinceDays: number): UserUsageRow[] {
    // Both ai_usage and users have telegram_id and created_at columns, so the
    // window predicate must be qualified with the ai_usage alias.
    const window = windowClause(sinceDays).replace("created_at", "u.created_at")
    const stmt = this.db.prepare(`
      SELECT
        u.telegram_id AS telegramId,
        users.username AS username,
        ${TOTALS_COLUMNS}
      FROM ai_usage u
      LEFT JOIN users ON users.telegram_id = u.telegram_id
      WHERE u.status != ${FAILED}${window}
      GROUP BY u.telegram_id, users.username
      ORDER BY costUsd DESC
    `)
    return stmt.all() as UserUsageRow[]
  }

  getModelBreakdown(sinceDays: number): ModelUsageRow[] {
    const stmt = this.db.prepare(`
      SELECT model, ${TOTALS_COLUMNS}
      FROM ai_usage
      WHERE status != ${FAILED}${windowClause(sinceDays)}
      GROUP BY model
      ORDER BY costUsd DESC
    `)
    return stmt.all() as ModelUsageRow[]
  }

  /** Per-provider health over the last sinceHours, for /admin providers. */
  getProviderHealth(sinceHours: number): ProviderHealthRow[] {
    const hours = Math.max(1, Math.floor(sinceHours))
    const since = `datetime('now', '-${hours} hours')`

    const lastSeen = this.db
      .prepare(`
        SELECT
          provider,
          MAX(CASE WHEN status != ${FAILED} THEN created_at END) AS lastSuccessAt,
          MAX(CASE WHEN status = ${FAILED} THEN created_at END) AS lastFailureAt
        FROM ai_usage
        GROUP BY provider
        ORDER BY provider
      `)
      .all() as { provider: string; lastSuccessAt: string | null; lastFailureAt: string | null }[]

    const windowed = this.db.prepare(`
      SELECT COUNT(*) AS calls, COALESCE(SUM(status = ${FAILED}), 0) AS failures
      FROM ai_usage
      WHERE provider = ? AND created_at >= ${since}
    `)
    const latencies = this.db.prepare(`
      SELECT latency_ms AS ms FROM ai_usage
      WHERE provider = ? AND status != ${FAILED} AND latency_ms IS NOT NULL AND created_at >= ${since}
      ORDER BY latency_ms
    `)
    const lastError = this.db.prepare(`
      SELECT error FROM ai_usage
      WHERE provider = ? AND status = ${FAILED}
      ORDER BY id DESC LIMIT 1
    `)

    return lastSeen.map((row) => {
      const counts = windowed.get(row.provider) as { calls: number; failures: number }
      const ms = (latencies.all(row.provider) as { ms: number }[]).map((r) => r.ms)
      const error = lastError.get(row.provider) as { error: string | null } | null
      return {
        ...row,
        ...counts,
        p50LatencyMs: ms.length > 0 ? ms[Math.floor((ms.length - 1) / 2)] : null,
        lastError: error?.error ?? null,
      }
    })
  }
}
