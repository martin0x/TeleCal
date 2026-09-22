// src/bot/commands/usage.ts
import { Context } from "grammy"
import { UsageRepository, type UsageTotals } from "../../db/repositories/usage"
import { formatTokens } from "../../utils/format"
import { smartReply } from "../utils/smart-reply"

const WINDOW_DAYS = 30

/**
 * Deliberately shows no cost. Dollar figures are admin-only — see the
 * design doc's Decisions table.
 */
export function formatUserUsage(totals: UsageTotals, days: number): string {
  if (totals.calls === 0) {
    return `📊 No AI usage recorded in the last ${days} days.`
  }

  return (
    `📊 Your AI usage — last ${days} days\n` +
    `${totals.calls} calls · ${formatTokens(totals.inputTokens)} in / ` +
    `${formatTokens(totals.outputTokens)} out tokens`
  )
}

export function createUsageCommand(usageRepo: UsageRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const totals = usageRepo.getUserTotals(userId, WINDOW_DAYS)
    await smartReply(ctx, formatUserUsage(totals, WINDOW_DAYS))
  }
}
