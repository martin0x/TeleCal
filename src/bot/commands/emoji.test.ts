// src/bot/commands/emoji.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { GroupBadgesRepository } from "../../db/repositories/group-badges"
import { userBadge } from "../utils/smart-reply"
import { createEmojiCommand, parseBadgeEmoji } from "./emoji"

describe("parseBadgeEmoji", () => {
  test("accepts one emoji, including skin tones, ZWJ sequences, flags and keycaps", () => {
    for (const emoji of ["🦊", "👍🏽", "👩‍💻", "🇵🇭", "1️⃣", "❤️"]) {
      expect(parseBadgeEmoji(` ${emoji} `)).toBe(emoji)
    }
  })

  test("refuses text, bare digits, and more than one emoji", () => {
    for (const input of ["", "a", "fox", "1", "#", "🦊🐼", "🦊 fox"]) {
      expect(parseBadgeEmoji(input)).toBeNull()
    }
  })
})

const GROUP = -100

let repo: GroupBadgesRepository

beforeEach(() => {
  repo = new GroupBadgesRepository(createTestDb())
})

function fakeCtx(text: string, opts: { chatType?: string; userId?: number; groupBadge?: string | null } = {}) {
  const chatType = opts.chatType ?? "group"
  return {
    from: { id: opts.userId ?? 42, first_name: "Maria" },
    chat: { id: chatType === "private" ? 42 : GROUP, type: chatType },
    message: { message_id: 7, text },
    groupBadge: opts.groupBadge,
    reply: mock(() => Promise.resolve()),
  }
}

async function run(text: string, opts?: Parameters<typeof fakeCtx>[1]) {
  const ctx = fakeCtx(text, opts)
  await createEmojiCommand(repo)(ctx as unknown as Context)
  const [sent] = ctx.reply.mock.calls[0] as unknown as [string]
  return { ctx, sent }
}

describe("createEmojiCommand", () => {
  test("sets the badge and confirms under it", async () => {
    const { sent } = await run("/emoji 🦊")
    expect(repo.get(GROUP, 42)).toBe("🦊")
    expect(sent).toBe("🦊 <b>Maria</b>\nYour badge in this group is now 🦊.")
  })

  test("works with the bot's @name", async () => {
    await run("/emoji@TeleCalBot 🐼")
    expect(repo.get(GROUP, 42)).toBe("🐼")
  })

  test("refuses an emoji another member has", async () => {
    repo.set(GROUP, 43, "🦊")
    const { sent } = await run("/emoji 🦊")
    expect(repo.get(GROUP, 42)).toBeNull()
    expect(sent).toContain("🦊 is already another member's badge in this group.")
  })

  test("refuses anything that isn't one emoji", async () => {
    const { sent } = await run("/emoji fox")
    expect(repo.get(GROUP, 42)).toBeNull()
    expect(sent).toContain("Send one emoji, like /emoji 🦊")
  })

  test("reset goes back to the default badge", async () => {
    repo.set(GROUP, 42, "🦊")
    const { sent } = await run("/emoji reset", { groupBadge: "🦊" })
    expect(repo.get(GROUP, 42)).toBeNull()
    expect(sent).toBe(`${userBadge(42)} <b>Maria</b>\nBack to the default badge in this group.`)
  })

  test("with no argument, shows the current badge", async () => {
    const { sent } = await run("/emoji", { groupBadge: "🦊" })
    expect(sent).toContain("Your badge in this group is 🦊.")
    const fresh = await run("/emoji")
    expect(fresh.sent).toContain("You have the default badge in this group.")
  })

  test("in a private chat, explains badges are per group and stores nothing", async () => {
    const { sent } = await run("/emoji 🦊", { chatType: "private" })
    expect(sent).toBe("Badges are per group. Send /emoji 🦊 in a group to pick yours there.")
    expect(repo.get(42, 42)).toBeNull()
  })
})
