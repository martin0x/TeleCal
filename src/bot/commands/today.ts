// src/bot/commands/today.ts
import { Context } from "grammy"
import { FoodLogsRepository, FoodItem, DayTotals } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, formatDateForDisplay, DEFAULT_TIMEZONE } from "../../utils/dates"
import { formatItemLine, formatGoalProgress } from "../../utils/format"
import { MACROS, DEFAULT_MACROS, type MacroKey } from "../../macros"
import { config } from "../../config"
import { smartReply } from "../utils/smart-reply"

/**
 * The /today body: numbered item lines, the calorie block, the protein block
 * when protein is tracked, then one line per other tracked macro. Pure, so the
 * layout is testable without a bot.
 */
export function buildTodayMessage(opts: {
  date: string
  items: FoodItem[]
  totals: DayTotals
  dailyGoal: number | null | undefined
  proteinGoal: number | null | undefined
  macros: readonly MacroKey[]
}): string {
  const { macros } = opts
  let message = `📅 ${formatDateForDisplay(opts.date)}\n\n`
  opts.items.forEach((item, i) => {
    message += `${i + 1}. ${formatItemLine(item, macros)}\n`
  })
  message += "\n"
  message += formatGoalProgress({ emoji: "📊", label: "Calories", current: opts.totals.calories, goal: opts.dailyGoal, unit: "cal" })
  if (macros.includes("protein")) {
    message += "\n\n"
    message += formatGoalProgress({ emoji: "💪", label: "Protein", current: opts.totals.protein, goal: opts.proteinGoal, unit: "g" })
  }
  const others = MACROS.filter((m) => m.key !== "protein" && macros.includes(m.key))
  if (others.length > 0) {
    message += "\n\n"
    message += others.map((m) => formatGoalProgress({ label: m.name, current: opts.totals[m.key], goal: null, unit: "g" })).join("\n")
  }
  return message
}

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

    let message: string
    if (entries.length === 0) {
      message =
        `📅 ${formatDateForDisplay(today)}\n\n` +
        "No food logged yet today.\n\n" +
        "Use /log to add your first entry!"
    } else {
      message = buildTodayMessage({
        date: today,
        items: entries.flatMap((log) => log.items),
        totals: foodLogsRepo.getTotals(userId, today),
        dailyGoal: user?.daily_goal,
        proteinGoal: user?.daily_protein_goal,
        macros: user?.tracked_macros ?? DEFAULT_MACROS,
      })
    }

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
}
