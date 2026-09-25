// src/bot/commands/log.ts
import { Context, InlineKeyboard } from "grammy"
import { LogFlow, LogFlowResult, ConfirmChoice } from "../conversations/log-flow"
import { ConversationsRepository } from "../../db/repositories/conversations"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, getYesterdayInTimezone, formatDate, DEFAULT_TIMEZONE } from "../../utils/dates"
import { encodeLogCallback, parseLogCallback, LogAction } from "../utils/callback-data"
import { stripKeyboard } from "../utils/keyboard"
import { smartReply, smartEdit } from "../utils/smart-reply"

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

function parseDateArg(arg: string, timezone: string): string | null {
  const lower = arg.toLowerCase().trim()

  // Handle "today" and "yesterday"
  if (lower === "today" || lower === "") {
    return getTodayInTimezone(timezone)
  }
  if (lower === "yesterday") {
    return getYesterdayInTimezone(timezone)
  }

  // Handle ISO format: 2026-01-31
  const isoMatch = lower.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    return lower
  }

  // Handle "jan 31" or "january 31" format
  const monthDayMatch = lower.match(/^([a-z]+)\s+(\d{1,2})$/)
  if (monthDayMatch) {
    const monthStr = monthDayMatch[1]
    const day = parseInt(monthDayMatch[2], 10)
    const month = MONTHS[monthStr]

    if (month !== undefined && day >= 1 && day <= 31) {
      const today = new Date()
      let year = today.getFullYear()

      // Create the date in the current year
      const date = new Date(year, month, day)

      // If the date is in the future, use previous year
      if (date > today) {
        year -= 1
      }

      return formatDate(new Date(year, month, day))
    }
  }

  return null
}

export function createLogCommand(
  logFlow: LogFlow,
  conversationsRepo: ConversationsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (!userId || !chatId) return

    const user = usersRepo.findById(userId)
    const provider = user?.ai_provider ?? "openai"
    const timezone = user?.timezone ?? DEFAULT_TIMEZONE

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1).join(" ")

    const targetDate = parseDateArg(args, timezone) ?? getTodayInTimezone(timezone)

    const result = await logFlow.start(userId, chatId, targetDate, provider)
    await smartReply(ctx, result.message)
  }
}

export function createLogMessageHandler(
  logFlow: LogFlow,
  conversationsRepo: ConversationsRepository,
  usersRepo: UsersRepository
) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (!userId || !chatId) return

    // Only process if there's an active conversation
    const state = conversationsRepo.get(userId)
    if (!state) return

    const text = ctx.message?.text?.trim()
    if (!text) return

    // Skip if it's a command (starts with /)
    if (text.startsWith("/")) return

    const user = usersRepo.findById(userId)
    const provider = user?.ai_provider ?? "openai"

    // Handle continue/new response
    const lower = text.toLowerCase()
    if (lower === "continue" || lower === "new") {
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const result = await logFlow.continueOrStartOver(
        userId,
        chatId,
        lower as "continue" | "new",
        getTodayInTimezone(timezone)
      )
      await replyWithResult(ctx, userId, result)
      return
    }

    const result = await logFlow.processInput(userId, chatId, text, provider)
    await replyWithResult(ctx, userId, result)
  }
}

const LOG_CHOICES: Record<LogAction, ConfirmChoice> = {
  ok: "log",
  chg: "change",
  cxl: "cancel",
}

export function buildLogConfirmKeyboard(
  ownerId: number,
  confirm: { token: string; totalCalories: number }
): InlineKeyboard {
  const data = (action: LogAction) => encodeLogCallback({ action, ownerId, token: confirm.token })
  return new InlineKeyboard()
    .text(`✅ Log ${confirm.totalCalories} cal`, data("ok"))
    .row()
    .text("✏️ Change", data("chg"))
    .text("✖️ Cancel", data("cxl"))
}

async function replyWithResult(ctx: Context, ownerId: number, result: LogFlowResult): Promise<void> {
  const options: NonNullable<Parameters<Context["reply"]>[1]> = {}
  if (result.parseMode) options.parse_mode = result.parseMode
  if (result.confirm) options.reply_markup = buildLogConfirmKeyboard(ownerId, result.confirm)
  await smartReply(ctx, result.message, options)
}

export function createLogCallbackHandler(logFlow: LogFlow) {
  return async (ctx: Context) => {
    const presserId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (!presserId || !chatId) {
      await ctx.answerCallbackQuery()
      return
    }

    const parsed = parseLogCallback(ctx.callbackQuery?.data ?? "")
    if (!parsed) {
      await ctx.answerCallbackQuery("That button has expired.")
      await stripKeyboard(ctx)
      return
    }

    // Owner check first, so a non-owner learns nothing about the owner's state.
    if (parsed.ownerId !== presserId) {
      await ctx.answerCallbackQuery("Only the person who started this can confirm it.")
      return
    }

    const outcome = logFlow.resolveConfirmation(presserId, chatId, parsed.token, LOG_CHOICES[parsed.action])
    if (outcome.stale) {
      await ctx.answerCallbackQuery("That entry is no longer pending.")
      await stripKeyboard(ctx)
      return
    }

    // Answer before editing so the client's spinner stops even if the edit fails.
    await ctx.answerCallbackQuery(outcome.toast)
    try {
      await smartEdit(ctx, outcome.edit, { parse_mode: "HTML" })
    } catch (error) {
      console.error("Failed to edit log confirmation:", error)
      await smartReply(ctx, outcome.edit, { parse_mode: "HTML" })
    }

    if (outcome.followUp) {
      await smartReply(ctx, outcome.followUp)
    }
  }
}
