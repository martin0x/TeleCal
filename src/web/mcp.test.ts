// src/web/mcp.test.ts
// End to end through the web server's fetch handler, speaking MCP's JSON-RPC
// the way a client like Claude does.
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { ApiTokensRepository } from "../db/repositories/api-tokens"
import { FakeAnalytics } from "../analytics/test-helpers"
import { createFetchHandler } from "./server"

const USER = 42
const OTHER = 99
let handle: (request: Request) => Promise<Response>
let apiTokensRepo: ApiTokensRepository
let foodLogsRepo: FoodLogsRepository
let allowed: Set<number>
let analytics: FakeAnalytics
let token: string

beforeEach(() => {
  const db = createTestDb()
  const usersRepo = new UsersRepository(db)
  foodLogsRepo = new FoodLogsRepository(db)
  apiTokensRepo = new ApiTokensRepository(db)
  usersRepo.upsert(USER, "maria")
  usersRepo.upsert(OTHER, "someone")
  allowed = new Set([USER, OTHER])
  analytics = new FakeAnalytics()
  handle = createFetchHandler({
    usersRepo,
    foodLogsRepo,
    botUsername: "TeleCalTestBot",
    baseUrl: "https://telecal.example",
    mcp: { apiTokensRepo, isAllowed: (id) => allowed.has(id), analytics },
  })
  token = apiTokensRepo.issue(USER)
})

let nextId = 1
function rpc(method: string, params: object = {}, path = `/mcp/${token}`) {
  return handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    })
  )
}

async function callTool(name: string, args: object = {}) {
  const res = await rpc("tools/call", { name, arguments: args })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: { isError?: boolean; content: { type: string; text: string }[] } }
  return body.result
}

describe("MCP connector", () => {
  test("initializes with TeleCal's instructions", async () => {
    const res = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string; capabilities: object } }
    expect(body.result.serverInfo.name).toBe("telecal")
    expect(body.result.instructions).toContain("logged: false")
    expect(body.result.capabilities).toHaveProperty("tools")
  })

  test("lists the four read-only tools", async () => {
    const res = await rpc("tools/list")
    const body = (await res.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }

    expect(body.result.tools.map((t) => t.name).sort()).toEqual(["get_daily_totals", "get_day", "get_profile", "get_summary"])
    expect(body.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true)
  })

  test("a tool call returns the token owner's data as JSON", async () => {
    foodLogsRepo.create(USER, 1, "2026-01-01", [{ description: "Eggs", calories: 180, protein_g: 12 }])
    foodLogsRepo.create(OTHER, 1, "2026-01-01", [{ description: "Pizza", calories: 800 }])

    const result = await callTool("get_day", { date: "2026-01-01" })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text)).toEqual({
      date: "2026-01-01",
      calories: 180,
      protein_g: 12,
      items: [{ description: "Eggs", calories: 180, protein_g: 12 }],
    })
  })

  test("bad input comes back as a tool error Claude can read", async () => {
    const result = await callTool("get_daily_totals", { start_date: "2026-02-01", end_date: "2026-01-01" })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("is after end_date")
  })

  test("sends the tool name to analytics, and no arguments or data", async () => {
    await callTool("get_day", { date: "2026-01-01" })

    expect(analytics.events).toEqual([{ telegramId: USER, event: "claude_tool_called", properties: { tool: "get_day" } }])
  })

  test("only POST: no SSE stream or session to open or end", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handle(new Request(`http://localhost/mcp/${token}`, { method }))
      expect(res.status).toBe(405)
      expect(res.headers.get("Allow")).toBe("POST")
    }
  })

  test("an unknown token is 404 with no data", async () => {
    const res = await rpc("tools/list", {}, "/mcp/not-a-real-token")
    expect(res.status).toBe(404)
  })

  test("a revoked token stops working", async () => {
    apiTokensRepo.revoke(USER)
    expect((await rpc("tools/list")).status).toBe(404)
  })

  test("a token stops working when its user loses access", async () => {
    allowed.delete(USER)
    expect((await rpc("tools/list")).status).toBe(404)
  })

  test("without the connector configured, /mcp paths are 404", async () => {
    const plain = createFetchHandler({
      usersRepo: new UsersRepository(createTestDb()),
      foodLogsRepo: new FoodLogsRepository(createTestDb()),
      botUsername: "TeleCalTestBot",
      baseUrl: "https://telecal.example",
    })
    expect((await plain(new Request(`http://localhost/mcp/${token}`, { method: "POST" }))).status).toBe(404)
  })
})
