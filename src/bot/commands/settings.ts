// src/bot/commands/settings.ts
import { Context, InlineKeyboard } from "grammy"
import { UsersRepository } from "../../db/repositories/users"
import { AIService } from "../../ai/service"

// Track users waiting for goal/reminder input
const pendingSettings = new Map<number, "goal" | "reminder">()

function createMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Change Provider", "settings:provider")
    .text("Set Daily Goal", "settings:goal")
    .row()
    .text("Set Reminder", "settings:reminder")
    .text("Close", "settings:close")
}

function createProviderKeyboard(currentProvider: string, availableProviders: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard()

  for (const provider of availableProviders) {
    const label = provider === currentProvider ? `${provider} ✓` : provider
    keyboard.text(label, `settings:provider:${provider}`)
  }

  keyboard.row().text("← Back", "settings:back")
  return keyboard
}

function formatSettings(user: {
  ai_provider: string
  daily_goal: number | null
  reminder_time: string | null
  reminder_mention: boolean
}): string {
  const provider = user.ai_provider.charAt(0).toUpperCase() + user.ai_provider.slice(1)
  const goal = user.daily_goal ? `${user.daily_goal.toLocaleString()} cal` : "Not set"
  const reminder = user.reminder_time
    ? `${user.reminder_time} (mention: ${user.reminder_mention ? "on" : "off"})`
    : "Off"

  return (
    `⚙️ Your Settings\n\n` +
    `AI Provider: ${provider}\n` +
    `Daily Goal: ${goal}\n` +
    `Reminder: ${reminder}`
  )
}

export function createSettingsCommand(usersRepo: UsersRepository, aiService: AIService) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const user = usersRepo.findById(userId)
    if (!user) {
      await ctx.reply("Please use /start first.")
      return
    }

    await ctx.reply(formatSettings(user), {
      reply_markup: createMainKeyboard(),
    })
  }
}

export function createSettingsCallbackHandler(usersRepo: UsersRepository, aiService: AIService) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const data = ctx.callbackQuery?.data
    if (!data?.startsWith("settings:")) return

    const user = usersRepo.findById(userId)
    if (!user) {
      await ctx.answerCallbackQuery("Please use /start first.")
      return
    }

    const action = data.replace("settings:", "")

    switch (action) {
      case "provider": {
        const available = aiService.getAvailableProviders()
        if (available.length === 0) {
          await ctx.answerCallbackQuery("No AI providers configured.")
          return
        }

        await ctx.editMessageText("⚙️ Select AI Provider", {
          reply_markup: createProviderKeyboard(user.ai_provider, available),
        })
        await ctx.answerCallbackQuery()
        break
      }

      case "goal": {
        pendingSettings.set(userId, "goal")
        await ctx.editMessageText(
          "⚙️ Set Daily Goal\n\n" +
            "Enter your daily calorie goal (e.g., 2000), or 'off' to clear it."
        )
        await ctx.answerCallbackQuery()
        break
      }

      case "reminder": {
        pendingSettings.set(userId, "reminder")
        await ctx.editMessageText(
          "⏰ Reminder Settings\n\n" +
            "When should I remind you to log?\n" +
            `Enter a time (e.g., "8pm", "20:00"), or "off" to disable.`
        )
        await ctx.answerCallbackQuery()
        break
      }

      case "back": {
        await ctx.editMessageText(formatSettings(user), {
          reply_markup: createMainKeyboard(),
        })
        await ctx.answerCallbackQuery()
        break
      }

      case "close": {
        await ctx.deleteMessage()
        await ctx.answerCallbackQuery()
        break
      }

      default: {
        // Handle provider selection: settings:provider:openai
        if (action.startsWith("provider:")) {
          const provider = action.replace("provider:", "")
          if (aiService.hasProvider(provider)) {
            usersRepo.updateSettings(userId, { ai_provider: provider })
            const updatedUser = usersRepo.findById(userId)!
            await ctx.editMessageText(formatSettings(updatedUser), {
              reply_markup: createMainKeyboard(),
            })
            await ctx.answerCallbackQuery(`Switched to ${provider}`)
          } else {
            await ctx.answerCallbackQuery("Provider not available")
          }
        }
        break
      }
    }
  }
}

export function createSettingsMessageHandler(usersRepo: UsersRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    const pending = pendingSettings.get(userId)
    if (!pending) return

    const text = ctx.message?.text?.trim()
    if (!text) return

    // Skip commands
    if (text.startsWith("/")) {
      pendingSettings.delete(userId)
      return
    }

    const lower = text.toLowerCase()

    if (pending === "goal") {
      if (lower === "off" || lower === "clear") {
        usersRepo.updateSettings(userId, { daily_goal: null })
        pendingSettings.delete(userId)
        await ctx.reply("Daily goal cleared. Use /settings to view settings.")
        return
      }

      const goal = parseInt(text, 10)
      if (isNaN(goal) || goal < 100 || goal > 10000) {
        await ctx.reply("Please enter a number between 100 and 10000, or 'off' to clear.")
        return
      }

      usersRepo.updateSettings(userId, { daily_goal: goal })
      pendingSettings.delete(userId)
      await ctx.reply(`Daily goal set to ${goal.toLocaleString()} cal. Use /settings to view settings.`)
      return
    }

    if (pending === "reminder") {
      if (lower === "off" || lower === "disable") {
        usersRepo.updateSettings(userId, { reminder_time: null })
        pendingSettings.delete(userId)
        await ctx.reply("Reminder disabled. Use /settings to view settings.")
        return
      }

      const time = parseTime(text)
      if (!time) {
        await ctx.reply(`Please enter a valid time (e.g., "8pm", "20:00"), or "off" to disable.`)
        return
      }

      usersRepo.updateSettings(userId, { reminder_time: time })
      pendingSettings.delete(userId)
      await ctx.reply(`Reminder set for ${time}. Use /settings to view settings.`)
      return
    }
  }
}

function parseTime(input: string): string | null {
  const lower = input.toLowerCase().trim()

  // Handle 24h format: 20:00
  const match24 = lower.match(/^(\d{1,2}):(\d{2})$/)
  if (match24) {
    const hours = parseInt(match24[1], 10)
    const minutes = parseInt(match24[2], 10)
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`
    }
    return null
  }

  // Handle 12h format: 8pm, 8:30pm, 8 pm
  const match12 = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (match12) {
    let hours = parseInt(match12[1], 10)
    const minutes = match12[2] ? parseInt(match12[2], 10) : 0
    const period = match12[3]

    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
      return null
    }

    if (period === "pm" && hours !== 12) {
      hours += 12
    } else if (period === "am" && hours === 12) {
      hours = 0
    }

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`
  }

  return null
}

export function hasPendingSettings(userId: number): boolean {
  return pendingSettings.has(userId)
}

export function clearPendingSettings(userId: number): void {
  pendingSettings.delete(userId)
}
