// src/bot/commands/stats.ts
import { Context } from "grammy"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getToday, getDateRange, formatDateForDisplay, getDayOfWeek } from "../../utils/dates"
import { config } from "../../config"

export function createWeekCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    await sendStatsMessage(ctx, userId, 7, "Week", foodLogsRepo, usersRepo)
  }
}

export function createMonthCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    await sendStatsMessage(ctx, userId, 30, "Month", foodLogsRepo, usersRepo)
  }
}

async function sendStatsMessage(
  ctx: Context,
  userId: number,
  days: number,
  period: string,
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  const isPrivateChat = ctx.chat?.type === "private"
  const today = getToday()
  const dateRange = getDateRange(days, today)
  const startDate = dateRange[0]
  const endDate = dateRange[dateRange.length - 1]

  const dailyTotals = foodLogsRepo.getDailyTotals(userId, startDate, endDate)
  const user = usersRepo.findById(userId)
  const dailyGoal = user?.daily_goal

  // Calculate stats
  const daysWithData = Object.keys(dailyTotals).length
  const totalCalories = Object.values(dailyTotals).reduce((sum, cal) => sum + cal, 0)
  const avgCalories = daysWithData > 0 ? Math.round(totalCalories / daysWithData) : 0

  let message = `📊 ${period} Summary\n`
  message += `${formatDateForDisplay(startDate)} - ${formatDateForDisplay(endDate)}\n\n`

  if (daysWithData === 0) {
    message += "No data logged for this period.\n\n"
    message += "Use /log to start tracking!"
    await ctx.reply(message, isPrivateChat ? {
      reply_markup: {
        inline_keyboard: [[
          { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
        ]]
      }
    } : {})
    return
  }

  // Show daily breakdown (last 7 days for week, summary for month)
  if (days <= 7) {
    for (const date of dateRange) {
      const calories = dailyTotals[date] || 0
      const dayName = getDayOfWeek(date).slice(0, 3)
      const bar = createMiniBar(calories, dailyGoal || avgCalories * 1.2)

      if (calories > 0) {
        message += `${dayName}: ${bar} ${calories} cal\n`
      } else {
        message += `${dayName}: ░░░░░ —\n`
      }
    }
  } else {
    // For month, show weekly breakdown
    const weeks = splitIntoWeeks(dateRange, dailyTotals)
    for (let i = 0; i < weeks.length; i++) {
      const weekTotal = weeks[i]
      const weekAvg = Math.round(weekTotal / 7)
      message += `Week ${i + 1}: ${weekTotal} cal (avg: ${weekAvg}/day)\n`
    }
  }

  message += `\n━━━━━━━━━━━━━━━━━━\n`
  message += `📈 Total: ${totalCalories} cal\n`
  message += `📊 Daily avg: ${avgCalories} cal\n`
  message += `📅 Days tracked: ${daysWithData}/${days}`

  if (dailyGoal) {
    const daysUnderGoal = Object.values(dailyTotals).filter((cal) => cal <= dailyGoal).length
    const percentage = Math.round((daysUnderGoal / daysWithData) * 100)
    message += `\n🎯 Under goal: ${daysUnderGoal}/${daysWithData} days (${percentage}%)`
  }

  await ctx.reply(message, isPrivateChat ? {
    reply_markup: {
      inline_keyboard: [[
        { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
      ]]
    }
  } : {})
}

function createMiniBar(value: number, max: number): string {
  const percentage = Math.min(value / max, 1)
  const filled = Math.round(percentage * 5)
  const empty = 5 - filled
  return "█".repeat(filled) + "░".repeat(empty)
}

function splitIntoWeeks(dateRange: string[], dailyTotals: Record<string, number>): number[] {
  const weeks: number[] = []
  let weekTotal = 0

  for (let i = 0; i < dateRange.length; i++) {
    weekTotal += dailyTotals[dateRange[i]] || 0
    if ((i + 1) % 7 === 0) {
      weeks.push(weekTotal)
      weekTotal = 0
    }
  }

  // Add remaining days
  if (weekTotal > 0 || dateRange.length % 7 !== 0) {
    weeks.push(weekTotal)
  }

  return weeks
}
