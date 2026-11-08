// src/bot/commands/log.ts
import { Context, InlineKeyboard } from "grammy"
import { LogFlow, LogFlowResult, ConfirmChoice } from "../conversations/log-flow"
import { ConversationsRepository } from "../../db/repositories/conversations"
import { UsersRepository } from "../../db/repositories/users"
import type { MacroKey, Totals } from "../../macros"
import { getTodayInTimezone, getYesterdayInTimezone, formatDate, DEFAULT_TIMEZONE } from "../../utils/dates"
import { encodeLogCallback, encodeFoodsCallback, parseLogCallback, LogAction } from "../utils/callback-data"
import { stripKeyboard, answerCallback } from "../utils/keyboard"
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

export function parseDateArg(arg: string, timezone: string): string | null {
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

const SEPARATOR = /^[\s:,\-–—]+|[\s:,\-–—]+$/g

/**
 * Splits `/log` arguments into a date and the food to log. The whole argument
 * may be a date (`/log yesterday`), or a date may lead the food
 * (`/log yesterday: 2 eggs`); anything else is all food, logged to today.
 */
export function parseLogArgs(args: string, timezone: string): { targetDate: string; food: string } {
  const trimmed = args.trim()
  const whole = parseDateArg(trimmed, timezone)
  if (whole) return { targetDate: whole, food: "" }

  const words = trimmed.split(/\s+/)
  // Longest prefix first, so "jan 31 pizza" is not read as "jan" + "31 pizza".
  for (const size of [2, 1]) {
    if (words.length <= size) continue
    const prefix = words.slice(0, size).join(" ").replace(SEPARATOR, "")
    // parseDateArg reads "" as today; a bare separator is not a date.
    if (prefix === "") continue
    const date = parseDateArg(prefix, timezone)
    if (!date) continue
    const food = words.slice(size).join(" ").replace(SEPARATOR, "")
    if (food) return { targetDate: date, food }
  }

  return { targetDate: getTodayInTimezone(timezone), food: trimmed }
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

    // Everything after "/log" or "/log@Bot", line breaks included.
    const text = ctx.message?.text ?? ""
    const args = text.replace(/^\/\S+\s*/, "")

    const { targetDate, food } = parseLogArgs(args, timezone)

    if (food) {
      const result = await logFlow.startWithFood(userId, chatId, targetDate, food, provider)
      await replyWithResult(ctx, userId, result)
      return
    }

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
  confirm: { token: string; totals: Totals; macros: readonly MacroKey[] }
): InlineKeyboard {
  const data = (action: LogAction) => encodeLogCallback({ action, ownerId, token: confirm.token })
  // Calories and protein only: a longer label does not fit on a button.
  const protein = confirm.macros.includes("protein") ? ` · ${confirm.totals.protein} g` : ""
  return new InlineKeyboard()
    .text(`✅ Log ${confirm.totals.calories} cal${protein}`, data("ok"))
    .row()
    .text("✏️ Change", data("chg"))
    .text("✖️ Cancel", data("cxl"))
}

/** On a "Logged" message when the food library is on. */
export function saveToFoodsKeyboard(ownerId: number, logId: number): InlineKeyboard {
  return new InlineKeyboard().text("Save to my foods", encodeFoodsCallback({ action: "log", ownerId, logId }))
}

async function replyWithResult(ctx: Context, ownerId: number, result: LogFlowResult): Promise<void> {
  const options: NonNullable<Parameters<Context["reply"]>[1]> = {}
  if (result.parseMode) options.parse_mode = result.parseMode
  if (result.confirm) options.reply_markup = buildLogConfirmKeyboard(ownerId, result.confirm)
  if (result.saveOffer) options.reply_markup = saveToFoodsKeyboard(ownerId, result.saveOffer.logId)
  await smartReply(ctx, result.message, options)
}

export function createLogCallbackHandler(logFlow: LogFlow) {
  return async (ctx: Context) => {
    const presserId = ctx.from?.id
    const chatId = ctx.chat?.id
    if (!presserId || !chatId) {
      await answerCallback(ctx)
      return
    }

    const parsed = parseLogCallback(ctx.callbackQuery?.data ?? "")
    if (!parsed) {
      await answerCallback(ctx, "That button has expired.")
      await stripKeyboard(ctx)
      return
    }

    // Owner check first, so a non-owner learns nothing about the owner's state.
    if (parsed.ownerId !== presserId) {
      await answerCallback(ctx, "Only the person who started this can confirm it.")
      return
    }

    const outcome = logFlow.resolveConfirmation(presserId, chatId, parsed.token, LOG_CHOICES[parsed.action])
    if (outcome.stale) {
      await answerCallback(ctx, "That entry is no longer pending.")
      await stripKeyboard(ctx)
      return
    }

    // Answer before editing so the client's spinner stops even if the edit fails.
    await answerCallback(ctx, outcome.toast)
    const options = {
      parse_mode: "HTML" as const,
      ...(outcome.saveOffer ? { reply_markup: saveToFoodsKeyboard(presserId, outcome.saveOffer.logId) } : {}),
    }
    try {
      await smartEdit(ctx, outcome.edit, options)
    } catch (error) {
      console.error("Failed to edit log confirmation:", error)
      await smartReply(ctx, outcome.edit, options)
    }

    if (outcome.followUp) {
      await smartReply(ctx, outcome.followUp)
    }
  }
}
