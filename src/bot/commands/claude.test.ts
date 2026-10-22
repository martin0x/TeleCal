// src/bot/commands/claude.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { ApiTokensRepository } from "../../db/repositories/api-tokens"
import { FakeAnalytics } from "../../analytics/test-helpers"
import { createClaudeCommand, connectorMessage, PRIVATE_ONLY, REVOKED, NOTHING_TO_REVOKE, USAGE } from "./claude"

const USER = 42
let apiTokensRepo: ApiTokensRepository
let analytics: FakeAnalytics
let command: (ctx: Context) => Promise<void>

beforeEach(() => {
  apiTokensRepo = new ApiTokensRepository(createTestDb())
  analytics = new FakeAnalytics()
  command = createClaudeCommand({ apiTokensRepo, baseUrl: "https://telecal.example", analytics })
})

function fakeCtx(match: string, chatType = "private") {
  const replies: { text: string; options?: Record<string, unknown> }[] = []
  const ctx = {
    from: { id: USER, first_name: "Maria" },
    chat: { id: USER, type: chatType },
    match,
    reply: async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options })
    },
  } as unknown as Context
  return { ctx, replies }
}

const tokenIn = (text: string) => text.match(/\/mcp\/([A-Za-z0-9_-]+)</)?.[1] ?? ""

describe("/claude", () => {
  test("sends a working connector link as tap-to-copy HTML with no preview", async () => {
    const { ctx, replies } = fakeCtx("")
    await command(ctx)

    expect(replies).toHaveLength(1)
    expect(replies[0].text).toContain("<code>https://telecal.example/mcp/")
    expect(replies[0].options).toEqual({ parse_mode: "HTML", link_preview_options: { is_disabled: true } })
    expect(apiTokensRepo.findUser(tokenIn(replies[0].text))).toBe(USER)
    expect(analytics.events).toEqual([{ telegramId: USER, event: "claude_connector_created", properties: undefined }])
  })

  test("a second /claude replaces the first link", async () => {
    const first = fakeCtx("")
    await command(first.ctx)
    const second = fakeCtx("")
    await command(second.ctx)

    expect(apiTokensRepo.findUser(tokenIn(first.replies[0].text))).toBeNull()
    expect(apiTokensRepo.findUser(tokenIn(second.replies[0].text))).toBe(USER)
  })

  test("never sends the link outside a private chat", async () => {
    const { ctx, replies } = fakeCtx("", "group")
    await command(ctx)

    expect(replies).toHaveLength(1)
    expect(replies[0].text).toStartWith(PRIVATE_ONLY.split(".")[0])
    expect(replies[0].text).not.toContain("/mcp/")
    expect(apiTokensRepo.revoke(USER)).toBe(false)
  })

  test("revoke turns the link off", async () => {
    const created = fakeCtx("")
    await command(created.ctx)
    const { ctx, replies } = fakeCtx("revoke")
    await command(ctx)

    expect(replies[0].text).toBe(REVOKED)
    expect(apiTokensRepo.findUser(tokenIn(created.replies[0].text))).toBeNull()
    expect(analytics.events.map((e) => e.event)).toEqual(["claude_connector_created", "claude_connector_revoked"])
  })

  test("revoke with no link says so", async () => {
    const { ctx, replies } = fakeCtx(" Revoke ")
    await command(ctx)

    expect(replies[0].text).toBe(NOTHING_TO_REVOKE)
    expect(analytics.events).toEqual([])
  })

  test("any other argument shows usage and issues nothing", async () => {
    const { ctx, replies } = fakeCtx("please")
    await command(ctx)

    expect(replies[0].text).toBe(USAGE)
    expect(apiTokensRepo.revoke(USER)).toBe(false)
  })
})

describe("connectorMessage", () => {
  test("explains setup, what Anthropic sees, and that the link is a secret", () => {
    const text = connectorMessage("https://telecal.example/mcp/abc")

    expect(text).toContain("<code>https://telecal.example/mcp/abc</code>")
    expect(text).toContain("Settings → Connectors → Add custom connector")
    expect(text).toContain("goes to Anthropic")
    expect(text).toContain("/claude revoke")
  })
})
