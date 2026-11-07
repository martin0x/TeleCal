// src/jobs/reminders.ts
import { Bot } from "grammy"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository, DayTotals } from "../db/repositories/food-logs"
import { getTodayInTimezone, getCurrentTimeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { formatNumber } from "../utils/format"
import { MACROS, type MacroKey } from "../macros"
import { redactUserId } from "../utils/logging"
import { config } from "../config"
import { noopAnalytics, type Analytics } from "../analytics"
import { isExpectedTelegramError } from "../bot/utils/telegram-errors"
import { reportJobFailure } from "./report"

// Track the last date each user was reminded (per-user timezone aware)
const lastRemindedDate = new Map<number, string>()

const n = formatNumber

export function formatReminderMessage(
  username: string | null,
  mention: boolean,
  totals: DayTotals,
  dailyGoal: number | null,
  proteinGoal: number | null,
  hasLogs: boolean,
  macros: readonly MacroKey[]
): string {
  const namePrefix = mention && username ? `@${username} ` : ""

  if (!hasLogs) {
    const goalText = dailyGoal ? `Goal: ${n(dailyGoal)} cal` : ""
    return (
      `${namePrefix}Haven't seen any logs today! 🍽️\n` +
      `Current: 0 cal${goalText ? ` | ${goalText}` : ""}\n\n` +
      `Use /log to track what you've eaten.`
    )
  }

  const macroLines: string[] = []
  if (macros.includes("protein")) {
    macroLines.push(
      proteinGoal
        ? `Protein: ${n(totals.protein)} / ${n(proteinGoal)} g (${Math.round((totals.protein / proteinGoal) * 100)}%)`
        : `Protein: ${n(totals.protein)} g`
    )
  }
  for (const m of MACROS) {
    if (m.key !== "protein" && macros.includes(m.key)) macroLines.push(`${m.name}: ${n(totals[m.key])} g`)
  }

  if (dailyGoal) {
    const percent = Math.round((totals.calories / dailyGoal) * 100)
    const remaining = dailyGoal - totals.calories
    const closing = remaining > 0 ? `${n(remaining)} cal remaining — keep it up!` : `You've reached your goal for today!`
    const lines = [`Current: ${n(totals.calories)} / ${n(dailyGoal)} cal (${percent}%)`, ...macroLines]
    return `${namePrefix}Daily check-in 🍽️\n\n${lines.join("\n")}\n\n${closing}`
  }

  const lines = [`Today's total: ${n(totals.calories)} cal`, ...macroLines]
  return `${namePrefix}Daily check-in 🍽️\n\n${lines.join("\n")}`
}

export function createReminderJob(
  bot: Bot,
  usersRepo: UsersRepository,
  foodLogsRepo: FoodLogsRepository,
  analytics: Analytics = noopAnalytics
) {
  return async (): Promise<void> => {
    const users = usersRepo.getUsersWithReminders()

    for (const user of users) {
      const timezone = user.timezone ?? DEFAULT_TIMEZONE
      const userToday = getTodayInTimezone(timezone)
      const currentTime = getCurrentTimeInTimezone(timezone)

      // Skip if already reminded today in user's timezone
      if (lastRemindedDate.get(user.telegram_id) === userToday) {
        continue
      }

      // Check if it's time to remind (within the same minute)
      if (user.reminder_time !== currentTime) {
        continue
      }

      try {
        const totals = foodLogsRepo.getTotals(user.telegram_id, userToday)
        const logs = foodLogsRepo.getByDate(user.telegram_id, userToday)
        const hasLogs = logs.length > 0

        const message = formatReminderMessage(
          user.username,
          user.reminder_mention,
          totals,
          user.daily_goal,
          user.daily_protein_goal,
          hasLogs,
          user.tracked_macros
        )

        // Send to user's DM (telegram_id is also the chat_id for DMs)
        await bot.api.sendMessage(user.telegram_id, message)
        lastRemindedDate.set(user.telegram_id, userToday)

        console.log(`Sent reminder to user ${redactUserId(user.telegram_id)}`)
      } catch (error) {
        console.error(`Failed to send reminder to user ${redactUserId(user.telegram_id)}:`, error)
        if (!isExpectedTelegramError(error)) {
          analytics.captureException(error, user.telegram_id, { source: "reminders" })
        }
      }
    }
  }
}

export function startReminderJob(
  bot: Bot,
  usersRepo: UsersRepository,
  foodLogsRepo: FoodLogsRepository,
  analytics: Analytics = noopAnalytics
): NodeJS.Timeout {
  const job = createReminderJob(bot, usersRepo, foodLogsRepo, analytics)
  const onFailure = reportJobFailure(analytics, "reminders")

  // Run immediately on start
  job().catch(onFailure)

  // Then run every minute
  const interval = setInterval(() => {
    job().catch(onFailure)
  }, config.timing.reminderCheckInterval)

  console.log("Reminder job started")
  return interval
}
