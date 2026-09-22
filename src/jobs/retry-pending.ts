// src/jobs/retry-pending.ts
import { Bot } from "grammy"
import { PendingRepository, PendingEntry } from "../db/repositories/pending"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { AIService } from "../ai/service"
import { config } from "../config"
import { formatDateForDisplay } from "../utils/dates"
import { redactUserId } from "../utils/logging"

const MAX_RETRIES = 10
const BATCH_SIZE = 5

function formatConfirmationMessage(
  items: { description: string; calories: number; emoji?: string }[],
  targetDate: string
): string {
  const itemsDisplay = items
    .map((item) => `${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal`)
    .join("\n")

  const totalCalories = items.reduce((sum, item) => sum + item.calories, 0)

  return (
    `✅ Your saved entry from ${formatDateForDisplay(targetDate)} is ready!\n\n` +
    `${itemsDisplay}\n` +
    `───────────────\n` +
    `Total: ${totalCalories} cal\n\n` +
    `Log this to ${formatDateForDisplay(targetDate)}? (yes/no)`
  )
}

export function createRetryPendingJob(
  bot: Bot,
  pendingRepo: PendingRepository,
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository,
  aiService: AIService
) {
  return async (): Promise<void> => {
    const entries = pendingRepo.getForRetry(BATCH_SIZE)

    for (const entry of entries) {
      // Skip if max retries exceeded
      if (entry.retry_count >= MAX_RETRIES) {
        console.log(`Entry ${entry.id} exceeded max retries, deleting`)
        pendingRepo.delete(entry.id)
        try {
          await bot.api.sendMessage(
            entry.telegram_id,
            `❌ Couldn't process your entry "${entry.food_text}" after multiple attempts.\n` +
              `Your AI provider may be unavailable — try switching it with /settings, ` +
              `then log the entry again with /log.`
          )
        } catch (error) {
          console.error(`Failed to notify user ${redactUserId(entry.telegram_id)}:`, error)
        }
        continue
      }

      try {
        const user = usersRepo.findById(entry.telegram_id)
        const provider = user?.ai_provider ?? "openai"

        const result = await aiService.estimate(entry.food_text, provider, {
          telegramId: entry.telegram_id,
          chatId: entry.chat_id,
          callType: "retry",
        })

        if (result.needsClarification || result.items.length === 0) {
          // Still can't estimate - increment retry and continue
          pendingRepo.incrementRetry(entry.id)
          console.log(`Entry ${entry.id} needs clarification, retry count: ${entry.retry_count + 1}`)
          continue
        }

        // Success! Create the food log
        foodLogsRepo.create(
          entry.telegram_id,
          entry.chat_id,
          entry.target_date,
          result.items
        )

        // Delete the pending entry
        pendingRepo.delete(entry.id)

        // Notify the user
        const totalCalories = result.items.reduce((sum, item) => sum + item.calories, 0)
        const itemsDisplay = result.items
          .map((item) => `${item.emoji ?? "🍽️"} ${item.description} — ${item.calories} cal`)
          .join("\n")

        await bot.api.sendMessage(
          entry.telegram_id,
          `✅ Processed your saved entry!\n\n` +
            `${itemsDisplay}\n` +
            `───────────────\n` +
            `Total: ${totalCalories} cal\n\n` +
            `Logged to ${formatDateForDisplay(entry.target_date)}.`
        )

        console.log(`Successfully processed entry ${entry.id} for user ${redactUserId(entry.telegram_id)}`)
      } catch (error) {
        // AI still unavailable - increment retry
        pendingRepo.incrementRetry(entry.id)
        console.error(`Failed to process entry ${entry.id}:`, error)
      }
    }
  }
}

export function startRetryPendingJob(
  bot: Bot,
  pendingRepo: PendingRepository,
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository,
  aiService: AIService
): NodeJS.Timeout {
  const job = createRetryPendingJob(bot, pendingRepo, foodLogsRepo, usersRepo, aiService)

  // Run every 5 minutes (configurable)
  const interval = setInterval(() => {
    job().catch(console.error)
  }, config.timing.pendingRetryInterval)

  console.log("Pending retry job started")
  return interval
}
