// src/bot/utils/smart-reply.test.ts
import { describe, test, expect, mock } from "bun:test"
import type { Context } from "grammy"
import { personalizeMessage, smartReply, smartEdit } from "./smart-reply"

describe("personalizeMessage", () => {
  test("adds name before question mark", () => {
    const result = personalizeMessage("What did you eat?", "Raymart")
    expect(result).toBe("What did you eat, Raymart?")
  })

  test("adds name before period", () => {
    const result = personalizeMessage("Logged 500 calories.", "Raymart")
    expect(result).toBe("Logged 500 calories, Raymart.")
  })

  test("adds name before colon", () => {
    const result = personalizeMessage("Here's what I'll log:", "Raymart")
    expect(result).toBe("Here's what I'll log, Raymart:")
  })

  test("adds name before exclamation mark", () => {
    const result = personalizeMessage("Great choice!", "Raymart")
    expect(result).toBe("Great choice, Raymart!")
  })

  test("adds name at end when no punctuation", () => {
    const result = personalizeMessage("Cancelled", "Raymart")
    expect(result).toBe("Cancelled, Raymart")
  })

  test("only personalizes first line of multi-line message", () => {
    const input = "Here's what I'll log:\n🍕 Pizza — 300 cal"
    const result = personalizeMessage(input, "Raymart")
    expect(result).toBe("Here's what I'll log, Raymart:\n🍕 Pizza — 300 cal")
  })

  test("handles empty name by using 'friend'", () => {
    const result = personalizeMessage("What did you eat?", "")
    expect(result).toBe("What did you eat, friend?")
  })

  test("handles undefined name by using 'friend'", () => {
    const result = personalizeMessage("What did you eat?", undefined)
    expect(result).toBe("What did you eat, friend?")
  })

  test("returns empty string unchanged", () => {
    const result = personalizeMessage("", "Raymart")
    expect(result).toBe("")
  })

  test("handles first line with only whitespace", () => {
    const result = personalizeMessage("   \nActual content", "Raymart")
    expect(result).toBe("   \nActual content")
  })
})

function fakeCtx(chatType: "private" | "group" | "supergroup", firstName: string) {
  return {
    chat: { id: 1, type: chatType },
    from: { id: 42, first_name: firstName },
    reply: mock(() => Promise.resolve()),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

describe("smartReply", () => {
  test("escapes the inserted name when sending HTML", async () => {
    const ctx = fakeCtx("group", "Tom & Jerry")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log, Tom &amp; Jerry:", { parse_mode: "HTML" })
  })

  test("inserts the name unescaped for plain text", async () => {
    const ctx = fakeCtx("group", "Tom & Jerry")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:")
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log, Tom & Jerry:", undefined)
  })

  test("leaves private-chat messages unchanged", async () => {
    const ctx = fakeCtx("private", "Tom & Jerry")
    await smartReply(ctx as unknown as Context, "Here's what I'll log:", { parse_mode: "HTML" })
    expect(ctx.reply).toHaveBeenCalledWith("Here's what I'll log:", { parse_mode: "HTML" })
  })
})

describe("smartEdit", () => {
  test("edits with the same personalization as smartReply", async () => {
    const ctx = fakeCtx("supergroup", "Maria")
    await smartEdit(ctx as unknown as Context, "✅ Logged to Fri, Sep 25:", { parse_mode: "HTML" })
    expect(ctx.editMessageText).toHaveBeenCalledWith("✅ Logged to Fri, Sep 25, Maria:", { parse_mode: "HTML" })
  })
})
