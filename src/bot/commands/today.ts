// src/bot/commands/today.ts
import { Context } from "grammy"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { config } from "../../config"
import { smartReply } from "../utils/smart-reply"

export function createTodayCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const isPrivateChat = ctx.chat?.type === "private"
    const user = usersRepo.findById(userId)
    const timezone = user?.timezone ?? DEFAULT_TIMEZONE
    const today = getTodayInTimezone(timezone)
    const entries = foodLogsRepo.getByDate(userId, today)
    const totalCalories = foodLogsRepo.getTotals(userId, today).calories
    const dailyGoal = user?.daily_goal

    if (entries.length === 0) {
      let emptyMessage = `📅 ${formatDateForDisplay(today)}\n\n` +
        "No food logged yet today.\n\n" +
        "Use /log to add your first entry!"

      if (!isPrivateChat) {
        emptyMessage += "\n\n💬 Start a chat with me to see interactive charts!"
      }

      await smartReply(ctx, emptyMessage, isPrivateChat ? {
        reply_markup: {
          inline_keyboard: [[
            { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
          ]]
        }
      } : {})

      // Try to DM the mini-app button in group chats
      if (!isPrivateChat) {
        try {
          await ctx.api.sendMessage(userId, "📈 Here's your chart view:", {
            reply_markup: {
              inline_keyboard: [[
                { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
              ]]
            }
          })
        } catch {
          // User hasn't started bot - the group note guides them
        }
      }
      return
    }

    let message = `📅 ${formatDateForDisplay(today)}\n\n`

    let itemNumber = 1
    for (const log of entries) {
      for (const item of log.items) {
        const emoji = item.emoji || "🍽️"
        message += `${itemNumber}. ${emoji} ${item.description} — ${item.calories} cal\n`
        itemNumber++
      }
    }

    message += "\n"
    message += `📊 Total: ${totalCalories} cal`

    if (dailyGoal) {
      const remaining = dailyGoal - totalCalories
      const percentage = Math.round((totalCalories / dailyGoal) * 100)
      const progressBar = createProgressBar(percentage)

      message += ` / ${dailyGoal} cal\n`
      message += `${progressBar} ${percentage}%\n`

      if (remaining > 0) {
        message += `\n✨ ${remaining} cal remaining`
      } else if (remaining < 0) {
        message += `\n⚠️ ${Math.abs(remaining)} cal over goal`
      } else {
        message += `\n🎯 Goal reached!`
      }
    }

    // Add note for group chats
    if (!isPrivateChat) {
      message += "\n\n💬 Start a chat with me to see interactive charts!"
    }

    await smartReply(ctx, message, isPrivateChat ? {
      reply_markup: {
        inline_keyboard: [[
          { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
        ]]
      }
    } : {})

    // Try to DM the mini-app button in group chats
    if (!isPrivateChat) {
      try {
        await ctx.api.sendMessage(userId, "📈 Here's your chart view:", {
          reply_markup: {
            inline_keyboard: [[
              { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
            ]]
          }
        })
      } catch {
        // User hasn't started bot - the group note guides them
      }
    }
  }
}

function createProgressBar(percentage: number): string {
  const filled = Math.min(Math.round(percentage / 10), 10)
  const empty = 10 - filled
  return "█".repeat(filled) + "░".repeat(empty)
}
