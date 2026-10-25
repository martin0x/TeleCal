// src/bot/utils/smart-reply.test.ts
import { describe, test, expect, mock } from "bun:test"
import type { Context } from "grammy"
import { groupHeader, userBadge, smartReply, smartEdit } from "./smart-reply"

describe("userBadge", () => {
  test("is the same for the same user", () => {
    expect(userBadge(42)).toBe(userBadge(42))
  })

  test("differs between neighbouring user IDs", () => {
    expect(userBadge(42)).not.toBe(userBadge(43))
  })
})

describe("groupHeader", () => {
  test("is the badge and the bold name", () => {
    expect(groupHeader(42, "Maria")).toBe(`${userBadge(42)} <b>Maria</b>`)
  })

  test("escapes the name", () => {
    expect(groupHeader(42, "Tom & <Jerry>")).toBe(`${userBadge(42)} <b>Tom &amp; &lt;Jerry&gt;</b>`)
  })

  test("uses the member's chosen badge when there is one", () => {
    expect(groupHeader(42, "Maria", "🦊")).toBe("🦊 <b>Maria</b>")
    expect(groupHeader(42, "Maria", null)).toBe(`${userBadge(42)} <b>Maria</b>`)
  })

  test("falls back to 'friend' without a name", () => {
    expect(groupHeader(42, undefined)).toBe(`${userBadge(42)} <b>friend</b>`)
    expect(groupHeader(42, "  ")).toBe(`${userBadge(42)} <b>friend</b>`)
  })
})

function fakeCtx(chatType: "private" | "group" | "supergroup", firstName: string, messageId?: number) {
  return {
    chat: { id: 1, type: chatType },
    from: { id: 42, first_name: firstName },
    message: messageId === undefined ? undefined : { message_id: messageId, text: "hi" },
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

const QUOTE_7 = { message_id: 7, allow_sending_without_reply: true }

describe("smartReply", () => {
  test("in a group, heads an HTML message with the user and quotes their message", async () => {
    const ctx = fakeCtx("group", "Tom & Jerry", 7)
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith(`${userBadge(42)} <b>Tom &amp; Jerry</b>\nHere's what I'll log:`, {
      parse_mode: "HTML",
      reply_parameters: QUOTE_7,
    })
  })

  test("in a group, escapes a plain-text message and sends it as HTML", async () => {
    const ctx = fakeCtx("supergroup", "Maria", 7)
    await smartReply(ctx as unknown as Context, "Fish & chips <3")
    expect(ctx.reply).toHaveBeenCalledWith(`${userBadge(42)} <b>Maria</b>\nFish &amp; chips &lt;3`, {
      parse_mode: "HTML",
      reply_parameters: QUOTE_7,
    })
  })

  test("keeps the caller's other options", async () => {
    const ctx = fakeCtx("group", "Maria", 7)
    const reply_markup = { inline_keyboard: [] }
    await smartReply(ctx as unknown as Context, "Pick one:", { reply_markup })
    expect(ctx.reply).toHaveBeenCalledWith(`${userBadge(42)} <b>Maria</b>\nPick one:`, {
      reply_markup,
      parse_mode: "HTML",
      reply_parameters: QUOTE_7,
    })
  })

  test("quotes nothing when there is no user message, as after a button press", async () => {
    const ctx = fakeCtx("group", "Maria")
    await smartReply(ctx as unknown as Context, "What did you eat?")
    expect(ctx.reply).toHaveBeenCalledWith(`${userBadge(42)} <b>Maria</b>\nWhat did you eat?`, { parse_mode: "HTML" })
  })

  test("heads the reply with the badge set on the context", async () => {
    const ctx = { ...fakeCtx("group", "Maria", 7), groupBadge: "🦊" }
    await smartReply(ctx as unknown as Context, "Done.")
    expect(ctx.reply).toHaveBeenCalledWith("🦊 <b>Maria</b>\nDone.", { parse_mode: "HTML", reply_parameters: QUOTE_7 })
  })

  test("leaves private-chat messages unchanged", async () => {
    const ctx = fakeCtx("private", "Tom & Jerry", 7)
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log:", { parse_mode: "HTML" })
  })
})

describe("smartEdit", () => {
  test("edits with the same header as smartReply", async () => {
    const ctx = fakeCtx("supergroup", "Maria")
    await smartEdit(ctx as unknown as Context, "✅ Logged to Fri, Sep 25:", { parse_mode: "HTML" })
    expect(ctx.editMessageText).toHaveBeenCalledWith(`${userBadge(42)} <b>Maria</b>\n✅ Logged to Fri, Sep 25:`, {
      parse_mode: "HTML",
    })
  })

  test("leaves private-chat edits unchanged", async () => {
    const ctx = fakeCtx("private", "Maria")
    await smartEdit(ctx as unknown as Context, "Done.")
    expect(ctx.editMessageText).toHaveBeenCalledWith("Done.", undefined)
  })
})
