// src/jobs/reminders.ts
import { Bot } from "grammy"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository, DayTotals } from "../db/repositories/food-logs"
import { getTodayInTimezone, getCurrentTimeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { redactUserId } from "../utils/logging"
import { config } from "../config"

// Track the last date each user was reminded (per-user timezone aware)
const lastRemindedDate = new Map<number, string>()

export function formatReminderMessage(
  username: string | null,
  mention: boolean,
  totals: DayTotals,
  dailyGoal: number | null,
  proteinGoal: number | null,
  hasLogs: boolean
): string {
  const namePrefix = mention && username ? `@${username} ` : ""
  const n = (value: number) => value.toLocaleString("en-US")

  if (!hasLogs) {
    const goalText = dailyGoal ? `Goal: ${n(dailyGoal)} cal` : ""
    return (
      `${namePrefix}Haven't seen any logs today! 🍽️\n` +
      `Current: 0 cal${goalText ? ` | ${goalText}` : ""}\n\n` +
      `Use /log to track what you've eaten.`
    )
  }

  const proteinLine = proteinGoal
    ? `Protein: ${n(totals.protein)} / ${n(proteinGoal)} g (${Math.round((totals.protein / proteinGoal) * 100)}%)`
    : `Protein: ${n(totals.protein)} g`

  if (dailyGoal) {
    const percent = Math.round((totals.calories / dailyGoal) * 100)
    const remaining = dailyGoal - totals.calories
    const closing = remaining > 0 ? `${n(remaining)} cal remaining — keep it up!` : `You've reached your goal for today!`

    return (
      `${namePrefix}Daily check-in 🍽️\n` +
      `Current: ${n(totals.calories)} / ${n(dailyGoal)} cal (${percent}%)\n` +
      `${proteinLine}\n` +
      closing
    )
  }

  return (
    `${namePrefix}Daily check-in 🍽️\n` +
    `Today's total: ${n(totals.calories)} cal\n` +
    proteinLine
  )
}

export function createReminderJob(
  bot: Bot,
  usersRepo: UsersRepository,
  foodLogsRepo: FoodLogsRepository
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
          hasLogs
        )

        // Send to user's DM (telegram_id is also the chat_id for DMs)
        await bot.api.sendMessage(user.telegram_id, message)
        lastRemindedDate.set(user.telegram_id, userToday)

        console.log(`Sent reminder to user ${redactUserId(user.telegram_id)}`)
      } catch (error) {
        console.error(`Failed to send reminder to user ${redactUserId(user.telegram_id)}:`, error)
      }
    }
  }
}

export function startReminderJob(
  bot: Bot,
  usersRepo: UsersRepository,
  foodLogsRepo: FoodLogsRepository
): NodeJS.Timeout {
  const job = createReminderJob(bot, usersRepo, foodLogsRepo)

  // Run immediately on start
  job().catch(console.error)

  // Then run every minute
  const interval = setInterval(() => {
    job().catch(console.error)
  }, config.timing.reminderCheckInterval)

  console.log("Reminder job started")
  return interval
}
