// src/jobs/reminders.ts
import { Bot } from "grammy"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { getToday } from "../utils/dates"
import { config } from "../config"

// Track which users we've reminded today to avoid duplicates
const remindedToday = new Set<number>()
let lastResetDate = getToday()

function resetIfNewDay(): void {
  const today = getToday()
  if (today !== lastResetDate) {
    remindedToday.clear()
    lastResetDate = today
  }
}

function getCurrentTime(): string {
  const now = new Date()
  const hours = now.getHours().toString().padStart(2, "0")
  const minutes = now.getMinutes().toString().padStart(2, "0")
  return `${hours}:${minutes}`
}

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
    resetIfNewDay()

    const currentTime = getCurrentTime()
    const users = usersRepo.getUsersWithReminders()

    for (const user of users) {
      // Skip if already reminded today
      if (remindedToday.has(user.telegram_id)) {
        continue
      }

      // Check if it's time to remind (within the same minute)
      if (user.reminder_time !== currentTime) {
        continue
      }

      try {
        const today = getToday()
        const totalCalories = foodLogsRepo.getTotalCalories(user.telegram_id, today)
        const logs = foodLogsRepo.getByDate(user.telegram_id, today)
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
        remindedToday.add(user.telegram_id)

        console.log(`Sent reminder to user ${user.telegram_id}`)
      } catch (error) {
        console.error(`Failed to send reminder to user ${user.telegram_id}:`, error)
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
