// src/bot/commands/log.ts
import { Context } from "grammy"
import { LogFlow } from "../conversations/log-flow"
import { ConversationsRepository } from "../../db/repositories/conversations"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, getYesterdayInTimezone, formatDate, DEFAULT_TIMEZONE } from "../../utils/dates"
import { smartReply } from "../utils/smart-reply"

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
      await smartReply(ctx, result.message)
      return
    }

    const result = await logFlow.processInput(userId, chatId, text, provider)
    await smartReply(ctx, result.message)
  }
}
