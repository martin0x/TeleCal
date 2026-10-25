// src/bot/utils/smart-reply.test.ts
import { describe, test, expect, mock } from "bun:test"
import type { Context } from "grammy"
import { smartReply, smartEdit } from "./smart-reply"

type ChatType = "private" | "group" | "supergroup"

/** A text message from user 42. */
function messageCtx(chatType: ChatType, firstName = "Maria") {
  return {
    chat: { id: 1, type: chatType },
    from: { id: 42, first_name: firstName },
    message: { message_id: 7, text: "hi" },
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

/**
 * A button press by user 42 on a bot message that quoted `original`, or
 * quoted nothing.
 */
function pressCtx(chatType: ChatType, original?: { message_id: number; from: { id: number } }, firstName = "Maria") {
  return {
    chat: { id: 1, type: chatType },
    from: { id: 42, first_name: firstName },
    callbackQuery: { data: "x", message: { message_id: 8, reply_to_message: original } },
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

const QUOTE = (id: number) => ({ message_id: id, allow_sending_without_reply: true })

describe("smartReply", () => {
  test("in a group, quotes the user's message and leaves the text alone", async () => {
    const ctx = messageCtx("group")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log:", { parse_mode: "HTML", reply_parameters: QUOTE(7) })
  })

  test("keeps the caller's other options", async () => {
    const ctx = messageCtx("supergroup")
    const reply_markup = { inline_keyboard: [] }
    await smartReply(ctx as unknown as Context, "Pick one:", { reply_markup })
    expect(ctx.reply).toHaveBeenCalledWith("Pick one:", { reply_markup, reply_parameters: QUOTE(7) })
  })

  test("after a button press, quotes the presser's message the button's message answered", async () => {
    const ctx = pressCtx("group", { message_id: 5, from: { id: 42 } })
    await smartReply(ctx as unknown as Context, "What did you eat?")
    expect(ctx.reply).toHaveBeenCalledWith("What did you eat?", { reply_parameters: QUOTE(5) })
  })

  test("with nothing of the user's to quote, starts with their name", async () => {
    const ctx = pressCtx("group", undefined, "Fish & Chips")
    await smartReply(ctx as unknown as Context, "Is <this> it?")
    expect(ctx.reply).toHaveBeenCalledWith("<b>Fish &amp; Chips</b>\nIs &lt;this&gt; it?", { parse_mode: "HTML" })
  })

  test("never quotes someone else's message as the presser's", async () => {
    const ctx = pressCtx("group", { message_id: 5, from: { id: 99 } })
    await smartReply(ctx as unknown as Context, "Done.", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("<b>Maria</b>\nDone.", { parse_mode: "HTML" })
  })

  test("falls back to 'friend' without a name", async () => {
    const ctx = pressCtx("group", undefined, " ")
    await smartReply(ctx as unknown as Context, "Done.")
    expect(ctx.reply).toHaveBeenCalledWith("<b>friend</b>\nDone.", { parse_mode: "HTML" })
  })

  test("leaves private-chat messages unchanged", async () => {
    const ctx = messageCtx("private")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log:", { parse_mode: "HTML" })
  })
})

describe("smartEdit", () => {
  test("in a group, leaves a message that already quotes the user alone", async () => {
    const ctx = pressCtx("supergroup", { message_id: 5, from: { id: 42 } })
    await smartEdit(ctx as unknown as Context, "✅ Logged to Fri, Sep 25:", { parse_mode: "HTML" })
    expect(ctx.editMessageText).toHaveBeenCalledWith("✅ Logged to Fri, Sep 25:", { parse_mode: "HTML" })
  })

  test("in a group, names the user on a message that quotes nothing", async () => {
    const ctx = pressCtx("group")
    await smartEdit(ctx as unknown as Context, "Done.")
    expect(ctx.editMessageText).toHaveBeenCalledWith("<b>Maria</b>\nDone.", { parse_mode: "HTML" })
  })

  test("leaves private-chat edits unchanged", async () => {
    const ctx = pressCtx("private")
    await smartEdit(ctx as unknown as Context, "Done.")
    expect(ctx.editMessageText).toHaveBeenCalledWith("Done.", undefined)
  })
})
