// src/bot/commands/log.test.ts
import { describe, test, expect, mock, spyOn } from "bun:test"
import type { Context } from "grammy"
import type { LogFlow, ConfirmationOutcome } from "../conversations/log-flow"
import type { ConversationsRepository } from "../../db/repositories/conversations"
import type { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, getYesterdayInTimezone } from "../../utils/dates"
import { buildLogConfirmKeyboard, createLogCallbackHandler, createLogCommand, parseLogArgs } from "./log"

function fakeCallbackCtx(data: string, fromId = 42) {
  return {
    from: { id: fromId, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    editMessageReplyMarkup: mock(() => Promise.resolve(true)),
    reply: mock(() => Promise.resolve()),
  }
}

function fakeLogFlow(outcome: ConfirmationOutcome) {
  return { resolveConfirmation: mock(() => outcome) }
}

async function press(data: string, outcome: ConfirmationOutcome, fromId = 42) {
  const ctx = fakeCallbackCtx(data, fromId)
  const logFlow = fakeLogFlow(outcome)
  await createLogCallbackHandler(logFlow as unknown as LogFlow)(ctx as unknown as Context)
  return { ctx, logFlow }
}

const LOGGED: ConfirmationOutcome = { stale: false, edit: "EDIT", toast: "Logged ✅" }

const TZ = "Asia/Manila"

describe("parseLogArgs", () => {
  const today = getTodayInTimezone(TZ)
  const yesterday = getYesterdayInTimezone(TZ)

  test("no arguments: today, no food", () => {
    expect(parseLogArgs("", TZ)).toEqual({ targetDate: today, food: "" })
  })

  test("a date alone: that date, no food", () => {
    expect(parseLogArgs("yesterday", TZ)).toEqual({ targetDate: yesterday, food: "" })
    expect(parseLogArgs("2026-01-31", TZ)).toEqual({ targetDate: "2026-01-31", food: "" })
  })

  test("food alone: today, all of it", () => {
    expect(parseLogArgs("2 eggs and toast", TZ)).toEqual({ targetDate: today, food: "2 eggs and toast" })
  })

  test("a leading date, with or without a separator", () => {
    expect(parseLogArgs("yesterday 2 eggs", TZ)).toEqual({ targetDate: yesterday, food: "2 eggs" })
    expect(parseLogArgs("yesterday: 2 eggs", TZ)).toEqual({ targetDate: yesterday, food: "2 eggs" })
    expect(parseLogArgs("2026-01-31 - pizza", TZ)).toEqual({ targetDate: "2026-01-31", food: "pizza" })
    expect(parseLogArgs("today, rice", TZ)).toEqual({ targetDate: today, food: "rice" })
  })

  test("a leading month and day", () => {
    const { targetDate, food } = parseLogArgs("jan 31 chicken adobo", TZ)
    expect(targetDate).toEndWith("-01-31")
    expect(food).toBe("chicken adobo")
  })

  test("a word that only looks like a month is food", () => {
    expect(parseLogArgs("mar bars", TZ)).toEqual({ targetDate: today, food: "mar bars" })
  })
})

function fakeCommandCtx(text: string) {
  return {
    from: { id: 42, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    message: { message_id: 1, text },
    reply: mock(() => Promise.resolve()),
  }
}

function commandDeps() {
  const logFlow = {
    start: mock(() => Promise.resolve({ message: "What did you eat?", action: "prompt" })),
    startWithFood: mock(() =>
      Promise.resolve({
        message: "Here's what I'll log:",
        action: "prompt",
        parseMode: "HTML",
        confirm: { token: "abcd1234", totals: { calories: 300, protein: 12 } },
      })
    ),
  }
  const usersRepo = { findById: mock(() => ({ ai_provider: "anthropic", timezone: TZ })) }
  const handler = createLogCommand(
    logFlow as unknown as LogFlow,
    {} as ConversationsRepository,
    usersRepo as unknown as UsersRepository
  )
  return { logFlow, handler }
}

describe("createLogCommand", () => {
  test("/log alone asks what you ate", async () => {
    const { logFlow, handler } = commandDeps()
    const ctx = fakeCommandCtx("/log")
    await handler(ctx as unknown as Context)
    expect(logFlow.start).toHaveBeenCalledWith(42, 555, getTodayInTimezone(TZ), "anthropic")
    expect(logFlow.startWithFood).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith("What did you eat?", undefined)
  })

  test("/log with food estimates it and shows the confirm buttons", async () => {
    const { logFlow, handler } = commandDeps()
    const ctx = fakeCommandCtx("/log@TeleCalBot yesterday: 2 eggs\nand toast")
    await handler(ctx as unknown as Context)
    expect(logFlow.start).not.toHaveBeenCalled()
    expect(logFlow.startWithFood).toHaveBeenCalledWith(42, 555, getYesterdayInTimezone(TZ), "2 eggs and toast", "anthropic")
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log:", {
      parse_mode: "HTML",
      reply_markup: buildLogConfirmKeyboard(42, { token: "abcd1234", totals: { calories: 300, protein: 12 } }),
    })
  })
})

describe("buildLogConfirmKeyboard", () => {
  test("puts Log full-width above Change and Cancel, with both totals on the button", () => {
    const keyboard = buildLogConfirmKeyboard(42, { token: "abcd1234", totals: { calories: 335, protein: 28 } })
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "✅ Log 335 cal · 28 g", callback_data: "log:ok:42:abcd1234" }],
      [
        { text: "✏️ Change", callback_data: "log:chg:42:abcd1234" },
        { text: "✖️ Cancel", callback_data: "log:cxl:42:abcd1234" },
      ],
    ])
  })
})

describe("createLogCallbackHandler", () => {
  test("a press by someone else changes nothing", async () => {
    const { ctx, logFlow } = await press("log:ok:42:abcd1234", LOGGED, 99)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can confirm it.")
    expect(logFlow.resolveConfirmation).not.toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
  })

  test("malformed data expires the button", async () => {
    const { ctx, logFlow } = await press("log:ok:42", LOGGED)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That button has expired.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(logFlow.resolveConfirmation).not.toHaveBeenCalled()
  })

  test("a stale press strips the keyboard", async () => {
    const { ctx } = await press("log:ok:42:abcd1234", { stale: true })
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That entry is no longer pending.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })

  test("Log resolves with the owner, chat and token, then edits in place", async () => {
    const { ctx, logFlow } = await press("log:ok:42:abcd1234", LOGGED)
    expect(logFlow.resolveConfirmation).toHaveBeenCalledWith(42, 555, "abcd1234", "log")
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Logged ✅")
    expect(ctx.editMessageText).toHaveBeenCalledWith("EDIT", { parse_mode: "HTML" })
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test("Change and Cancel map to their choices", async () => {
    const chg = await press("log:chg:42:abcd1234", LOGGED)
    expect(chg.logFlow.resolveConfirmation).toHaveBeenCalledWith(42, 555, "abcd1234", "change")
    const cxl = await press("log:cxl:42:abcd1234", LOGGED)
    expect(cxl.logFlow.resolveConfirmation).toHaveBeenCalledWith(42, 555, "abcd1234", "cancel")
  })

  test("a follow-up is sent as a new message", async () => {
    const { ctx } = await press("log:chg:42:abcd1234", {
      stale: false,
      edit: "EDIT",
      followUp: "Okay, let's try again. What did you eat?",
    })
    expect(ctx.reply).toHaveBeenCalledWith("Okay, let's try again. What did you eat?", undefined)
  })

  test("if the edit fails, the outcome is sent as a new message", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const ctx = fakeCallbackCtx("log:ok:42:abcd1234")
    ctx.editMessageText.mockImplementation(() => Promise.reject(new Error("message to edit not found")))
    const logFlow = fakeLogFlow(LOGGED)
    await createLogCallbackHandler(logFlow as unknown as LogFlow)(ctx as unknown as Context)
    expect(ctx.reply).toHaveBeenCalledWith("EDIT", { parse_mode: "HTML" })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("if answering the callback query fails, the message is still edited", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const ctx = fakeCallbackCtx("log:ok:42:abcd1234")
    ctx.answerCallbackQuery.mockImplementation(() => Promise.reject(new Error("query is too old")))
    const logFlow = fakeLogFlow(LOGGED)
    await createLogCallbackHandler(logFlow as unknown as LogFlow)(ctx as unknown as Context)
    expect(ctx.editMessageText).toHaveBeenCalledWith("EDIT", { parse_mode: "HTML" })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})
