// src/web/api.ts
// Every change here is additive: Telegram webviews cache app.html, so a stale
// page must keep working against this server. Never rename or reshape a field.
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository, FoodLog } from "../db/repositories/food-logs"
import { getTodayInTimezone, getDateRangeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { sumTotals } from "../utils/format"
import { hashTelegramId } from "../analytics"
import { MACROS, DEFAULT_MACROS, macroValuesOf, type MacroKey } from "../macros"

export interface ApiDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
  /** POSTHOG_ID_SECRET, only when analytics is on. Server-side only: the browser gets the hash. */
  analyticsIdSecret?: string
}

function dayPayload(date: string, entries: FoodLog[]) {
  const items = entries.flatMap((log) =>
    log.items.map((item) => ({
      id: item.id,
      description: item.description,
      calories: item.calories,
      ...macroValuesOf(item),
      emoji: item.emoji,
    }))
  )
  const { calories, ...macros } = sumTotals(items)
  return { date, total: calories, protein: macros.protein, macros, items }
}

export function createApiHandlers(deps: ApiDeps) {
  const { usersRepo, foodLogsRepo, analyticsIdSecret } = deps

  return {
    getUser(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      return {
        daily_goal: user?.daily_goal ?? null,
        daily_protein_goal: user?.daily_protein_goal ?? null,
        // Registry order. A Telegram-cached page that predates this ignores it.
        tracked_macros: user?.tracked_macros ?? [...DEFAULT_MACROS],
        username: user?.username ?? null,
        // The same distinct ID as this user's server-side events; null means no analytics.
        analytics_id: analyticsIdSecret ? hashTelegramId(telegramId, analyticsIdSecret) : null,
      }
    },

    getToday(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      return dayPayload(today, foodLogsRepo.getByDate(telegramId, today))
    },

    getStats(telegramId: number, period: "week" | "month") {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      const days = period === "week" ? 7 : 30
      const dateRange = getDateRangeInTimezone(days, today, timezone)
      const startDate = dateRange[0]
      const endDate = dateRange[dateRange.length - 1]

      const dailyTotals = foodLogsRepo.getDailyTotals(telegramId, startDate, endDate)

      // Fill in missing days with 0
      const daily: Record<string, number> = {}
      const dailyProtein: Record<string, number> = {}
      const dailyMacros = Object.fromEntries(MACROS.map((m) => [m.key, {}])) as Record<MacroKey, Record<string, number>>
      for (const date of dateRange) {
        const day = dailyTotals[date]
        daily[date] = day?.calories ?? 0
        dailyProtein[date] = day?.protein ?? 0
        for (const m of MACROS) dailyMacros[m.key][date] = day?.[m.key] ?? 0
      }

      return {
        start: startDate,
        end: endDate,
        daily,
        dailyProtein,
        dailyMacros,
      }
    },

    getDay(telegramId: number, date: string) {
      return dayPayload(date, foodLogsRepo.getByDate(telegramId, date))
    },
  }
}
