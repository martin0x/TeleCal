// src/jobs/reminders.ts
import { Bot } from "grammy"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { getTodayInTimezone, getCurrentTimeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { redactUserId } from "../utils/logging"
import { config } from "../config"

// Track the last date each user was reminded (per-user timezone aware)
const lastRemindedDate = new Map<number, string>()

function formatReminderMessage(
  username: string | null,
  mention: boolean,
  currentCalories: number,
  dailyGoal: number | null,
  hasLogs: boolean
): string {
  const namePrefix = mention && username ? `@${username} ` : ""

  if (!hasLogs) {
    const goalText = dailyGoal ? `Goal: ${dailyGoal.toLocaleString()} cal` : ""
    return (
      `${namePrefix}Haven't seen any logs today! 🍽️\n` +
      `Current: 0 cal${goalText ? ` | ${goalText}` : ""}\n\n` +
      `Use /log to track what you've eaten.`
    )
  }

  if (dailyGoal) {
    const percent = Math.round((currentCalories / dailyGoal) * 100)
    const remaining = dailyGoal - currentCalories

    if (remaining > 0) {
      return (
        `${namePrefix}Daily check-in 🍽️\n` +
        `Current: ${currentCalories.toLocaleString()} / ${dailyGoal.toLocaleString()} cal (${percent}%)\n` +
        `${remaining.toLocaleString()} cal remaining — keep it up!`
      )
    } else {
      return (
        `${namePrefix}Daily check-in 🍽️\n` +
        `Current: ${currentCalories.toLocaleString()} / ${dailyGoal.toLocaleString()} cal (${percent}%)\n` +
        `You've reached your goal for today!`
      )
    }
  }

  return (
    `${namePrefix}Daily check-in 🍽️\n` +
    `Today's total: ${currentCalories.toLocaleString()} cal`
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
        const totalCalories = foodLogsRepo.getTotals(user.telegram_id, userToday).calories
        const logs = foodLogsRepo.getByDate(user.telegram_id, userToday)
        const hasLogs = logs.length > 0

        const message = formatReminderMessage(
          user.username,
          user.reminder_mention,
          totalCalories,
          user.daily_goal,
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
