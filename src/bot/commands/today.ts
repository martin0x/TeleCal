// src/bot/commands/today.ts
import { Context } from "grammy"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getToday, formatDateForDisplay } from "../../utils/dates"
import { config } from "../../config"

export function createTodayCommand(
  foodLogsRepo: FoodLogsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const isPrivateChat = ctx.chat?.type === "private"
    const today = getToday()
    const entries = foodLogsRepo.getByDate(userId, today)
    const totalCalories = foodLogsRepo.getTotalCalories(userId, today)
    const user = usersRepo.findById(userId)
    const dailyGoal = user?.daily_goal

    if (entries.length === 0) {
      await ctx.reply(
        `📅 ${formatDateForDisplay(today)}\n\n` +
          "No food logged yet today.\n\n" +
          "Use /log to add your first entry!",
        isPrivateChat ? {
          reply_markup: {
            inline_keyboard: [[
              { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
            ]]
          }
        } : {}
      )
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

    message += `\n━━━━━━━━━━━━━━━━━━\n`
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

    await ctx.reply(message, isPrivateChat ? {
      reply_markup: {
        inline_keyboard: [[
          { text: "📈 View Charts", web_app: { url: config.web.appUrl } }
        ]]
      }
    } : {})
  }
}

function createProgressBar(percentage: number): string {
  const filled = Math.min(Math.round(percentage / 10), 10)
  const empty = 10 - filled
  return "█".repeat(filled) + "░".repeat(empty)
}
