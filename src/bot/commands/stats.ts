// src/bot/commands/stats.ts
import { Context } from "grammy"
import { FoodLogsRepository, DayTotals } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, getDateRangeInTimezone, formatDateForDisplay, getDayOfWeek, DEFAULT_TIMEZONE } from "../../utils/dates"
import { formatTotals, formatNumber } from "../../utils/format"
import { DEFAULT_MACROS, zeroTotals, addTotals, averageTotals } from "../../macros"
import { config } from "../../config"
import { smartReply } from "../utils/smart-reply"

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

const n = formatNumber

/**
 * The /week and /month body. Calories are a ceiling and protein a floor, so the
 * goal lines read "Under calorie goal" and "Protein goal met" (at or above).
 */
export function buildStatsMessage(opts: {
  period: string
  days: number
  dateRange: string[]
  dailyTotals: Record<string, DayTotals>
  dailyGoal: number | null | undefined
  proteinGoal: number | null | undefined
}): string {
  const { period, days, dateRange, dailyTotals, dailyGoal, proteinGoal } = opts
  const startDate = dateRange[0]
  const endDate = dateRange[dateRange.length - 1]
  const loggedDays = Object.values(dailyTotals)
  const daysWithData = loggedDays.length

  let message = `📊 ${period} Summary\n`
  message += `${formatDateForDisplay(startDate)} - ${formatDateForDisplay(endDate)}\n\n`

  if (daysWithData === 0) {
    message += "No data logged for this period.\n\n"
    message += "Use /log to start tracking!"
    return message
  }

  const total = loggedDays.reduce(addTotals, zeroTotals())
  const avg = averageTotals(total, daysWithData)

  if (days <= 7) {
    for (const date of dateRange) {
      const day = dailyTotals[date]
      const dayName = getDayOfWeek(date).slice(0, 3)
      if (day && day.calories > 0) {
        const bar = createMiniBar(day.calories, dailyGoal || avg.calories * 1.2)
        message += `${dayName}: ${bar} ${n(day.calories)} cal · ${n(day.protein)} g\n`
      } else {
        message += `${dayName}: ░░░░░ —\n`
      }
    }
  } else {
    const weeks = splitIntoWeeks(dateRange, dailyTotals)
    weeks.forEach((week, i) => {
      message +=
        `Week ${i + 1}: ${formatTotals(week, DEFAULT_MACROS)} ` +
        `(avg ${n(Math.round(week.calories / 7))} cal · ${n(Math.round(week.protein / 7))} g/day)\n`
    })
  }

  message += "\n"
  message += `📈 Total: ${formatTotals(total, DEFAULT_MACROS)}\n`
  message += `📊 Daily avg: ${formatTotals(avg, DEFAULT_MACROS)}\n`
  message += `📅 Days tracked: ${daysWithData}/${days}`
  if (dailyGoal || proteinGoal) message += "\n"

  if (dailyGoal) {
    const under = loggedDays.filter((d) => d.calories <= dailyGoal).length
    message += `\n🎯 Under calorie goal: ${under}/${daysWithData} days (${Math.round((under / daysWithData) * 100)}%)`
  }
  if (proteinGoal) {
    const met = loggedDays.filter((d) => d.protein >= proteinGoal).length
    message += `\n💪 Protein goal met: ${met}/${daysWithData} days (${Math.round((met / daysWithData) * 100)}%)`
  }

  return message
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
  const user = usersRepo.findById(userId)
  const timezone = user?.timezone ?? DEFAULT_TIMEZONE
  const today = getTodayInTimezone(timezone)
  const dateRange = getDateRangeInTimezone(days, today, timezone)

  let message = buildStatsMessage({
    period,
    days,
    dateRange,
    dailyTotals: foodLogsRepo.getDailyTotals(userId, dateRange[0], dateRange[dateRange.length - 1]),
    dailyGoal: user?.daily_goal,
    proteinGoal: user?.daily_protein_goal,
  })

  // Add note for group chats
  if (!isPrivateChat) {
    message += "\n\n💬 Start a chat with me to see interactive charts!"
  }

  await smartReply(ctx, message, isPrivateChat ? {
    reply_markup: {
      inline_keyboard: [[
        { text: "📈 View Charts", web_app: { url: config.web.miniAppUrl } }
      ]]
    }
  } : {})

  // Try to DM the mini-app button in group chats
  if (!isPrivateChat) {
    try {
      await ctx.api.sendMessage(userId, "📈 Here's your chart view:", {
        reply_markup: {
          inline_keyboard: [[
            { text: "📈 View Charts", web_app: { url: config.web.miniAppUrl } }
          ]]
        }
      })
    } catch {
      // User hasn't started bot - the group note guides them
    }
  }
}

function createMiniBar(value: number, max: number): string {
  const percentage = Math.min(value / max, 1)
  const filled = Math.round(percentage * 5)
  const empty = 5 - filled
  return "█".repeat(filled) + "░".repeat(empty)
}

function splitIntoWeeks(dateRange: string[], dailyTotals: Record<string, DayTotals>): DayTotals[] {
  const weeks: DayTotals[] = []
  let week = zeroTotals()

  for (let i = 0; i < dateRange.length; i++) {
    const day = dailyTotals[dateRange[i]]
    if (day) week = addTotals(week, day)
    if ((i + 1) % 7 === 0) {
      weeks.push(week)
      week = zeroTotals()
    }
  }

  // Add remaining days
  if (week.calories > 0 || dateRange.length % 7 !== 0) {
    weeks.push(week)
  }

  return weeks
}
