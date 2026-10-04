// src/web/api.ts
// Every change here is additive: Telegram webviews cache app.html, so a stale
// page must keep working against this server. Never rename or reshape a field.
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository, FoodLog } from "../db/repositories/food-logs"
import { getTodayInTimezone, getDateRangeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { sumTotals } from "../utils/format"

export interface ApiDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
}

function dayPayload(date: string, entries: FoodLog[]) {
  const items = entries.flatMap((log) =>
    log.items.map((item) => ({
      id: item.id,
      description: item.description,
      calories: item.calories,
      protein_g: item.protein_g ?? null,
      emoji: item.emoji,
    }))
  )
  const totals = sumTotals(items)
  return { date, total: totals.calories, protein: totals.protein, items }
}

export function createApiHandlers(deps: ApiDeps) {
  const { usersRepo, foodLogsRepo } = deps

  return {
    getUser(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      return {
        daily_goal: user?.daily_goal ?? null,
        daily_protein_goal: user?.daily_protein_goal ?? null,
        username: user?.username ?? null,
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
      for (const date of dateRange) {
        daily[date] = dailyTotals[date]?.calories ?? 0
        dailyProtein[date] = dailyTotals[date]?.protein ?? 0
      }

      return {
        start: startDate,
        end: endDate,
        daily,
        dailyProtein,
      }
    },

    getDay(telegramId: number, date: string) {
      return dayPayload(date, foodLogsRepo.getByDate(telegramId, date))
    },
  }
}
