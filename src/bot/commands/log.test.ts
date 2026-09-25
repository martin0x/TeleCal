// src/bot/commands/log.test.ts
import { describe, test, expect, mock, spyOn } from "bun:test"
import type { Context } from "grammy"
import type { LogFlow, ConfirmationOutcome } from "../conversations/log-flow"
import { buildLogConfirmKeyboard, createLogCallbackHandler } from "./log"

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

describe("buildLogConfirmKeyboard", () => {
  test("puts Log full-width above Change and Cancel", () => {
    const keyboard = buildLogConfirmKeyboard(42, { token: "abcd1234", totalCalories: 335 })
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "✅ Log 335 cal", callback_data: "log:ok:42:abcd1234" }],
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
})
