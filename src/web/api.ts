// src/web/api.ts
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { getTodayInTimezone, getDateRangeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"

export interface ApiDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
}

export function createApiHandlers(deps: ApiDeps) {
  const { usersRepo, foodLogsRepo } = deps

  return {
    getUser(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      return {
        daily_goal: user?.daily_goal ?? null,
        username: user?.username ?? null,
      }
    },

    getToday(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      const entries = foodLogsRepo.getByDate(telegramId, today)
      const items = entries.flatMap((log) =>
        log.items.map((item) => ({
          id: item.id,
          description: item.description,
          calories: item.calories,
          emoji: item.emoji,
        }))
      )
      const total = items.reduce((sum, item) => sum + item.calories, 0)

      return {
        date: today,
        total,
        items,
      }
    },

    getStats(telegramId: number, period: "week" | "month") {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      const days = period === "week" ? 7 : 30
      const dateRange = getDateRangeInTimezone(days, today, timezone)
      const startDate = dateRange[0]
      const endDate = dateRange[dateRange.length - 1]

      const dailyTotals = foodLogsRepo.getDailyTotals(
        telegramId,
        startDate,
        endDate
      )

      // Fill in missing days with 0
      const daily: Record<string, number> = {}
      for (const date of dateRange) {
        daily[date] = dailyTotals[date]?.calories ?? 0
      }

      return {
        start: startDate,
        end: endDate,
        daily,
      }
    },

    getDay(telegramId: number, date: string) {
      const entries = foodLogsRepo.getByDate(telegramId, date)
      const items = entries.flatMap((log) =>
        log.items.map((item) => ({
          id: item.id,
          description: item.description,
          calories: item.calories,
          emoji: item.emoji,
        }))
      )
      const total = items.reduce((sum, item) => sum + item.calories, 0)

      return {
        date,
        total,
        items,
      }
    },
  }
}
