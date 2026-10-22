// src/web/mcp.ts
// The Claude connector: a stateless MCP server (Streamable HTTP) at
// /mcp/<token>. The token comes from /claude in the bot and is the only
// credential, so this file must never log a request URL or path.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import { ApiTokensRepository } from "../db/repositories/api-tokens"
import { noopAnalytics, type Analytics } from "../analytics"
import { createConnectorTools, ToolInputError, MAX_RANGE_DAYS, DEFAULT_RANGE_DAYS, type ConnectorToolsDeps, type ConnectorTools } from "./connector-tools"

export interface McpDeps extends ConnectorToolsDeps {
  apiTokensRepo: ApiTokensRepository
  /** Allowlisted or admin. A token outlives access otherwise. */
  isAllowed: (telegramId: number) => boolean
  /** The per-user Analytics from createBot; only tool names are sent, never data. */
  analytics?: Analytics
}

/** base64url, as ApiTokensRepository.issue makes them. */
export const MCP_PATH = /^\/mcp\/([A-Za-z0-9_-]+)\/?$/

const INSTRUCTIONS =
  "TeleCal is the user's calorie and protein log, kept through a Telegram bot. " +
  "Calories are kcal, protein is whole grams, and dates are YYYY-MM-DD in the user's own timezone. " +
  "Call get_profile first for today's date, goals and how far back the log goes. " +
  "A day marked logged: false means nothing was recorded, not that the user ate nothing; leave such days out of averages. " +
  "Protein can undercount: items logged before protein tracking may have no protein value. " +
  "The data is read-only; changes are made in the Telegram bot."

const dateArg = z.string().describe("YYYY-MM-DD")
const rangeArgs = {
  start_date: dateArg.optional().describe(`First day, YYYY-MM-DD. Defaults to ${DEFAULT_RANGE_DAYS} days before end_date.`),
  end_date: dateArg.optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to the user's today."),
}
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function buildServer(telegramId: number, tools: ConnectorTools, analytics: Analytics): McpServer {
  const server = new McpServer({ name: "telecal", version: "1.0.0" }, { instructions: INSTRUCTIONS })

  // Every tool answers with its result as JSON text; bad input becomes a tool
  // error Claude can read and correct, anything else is reported and hidden.
  const run = (tool: string, compute: () => unknown) => {
    analytics.capture(telegramId, "claude_tool_called", { tool })
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(compute()) }] }
    } catch (error) {
      if (error instanceof ToolInputError) {
        return { isError: true, content: [{ type: "text" as const, text: error.message }] }
      }
      analytics.captureException(error, telegramId, { source: "claude_connector", tool })
      return { isError: true, content: [{ type: "text" as const, text: "TeleCal could not read the log. Try again later." }] }
    }
  }

  server.registerTool(
    "get_profile",
    {
      title: "Profile",
      description: "The user's today's date, timezone, daily calorie and protein goals, and the first and last dates in their log.",
      annotations: READ_ONLY,
    },
    async () => run("get_profile", () => tools.getProfile(telegramId))
  )

  server.registerTool(
    "get_daily_totals",
    {
      title: "Daily totals",
      description:
        `Calories and protein for every day in a range (at most ${MAX_RANGE_DAYS} days), ` +
        "each marked logged true or false. Use this for trends, charts and goal tracking.",
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async (args) => run("get_daily_totals", () => tools.getDailyTotals(telegramId, args))
  )

  server.registerTool(
    "get_day",
    {
      title: "One day's food",
      description: "Every food item logged on one date, with its calories and protein.",
      inputSchema: { date: dateArg },
      annotations: READ_ONLY,
    },
    async ({ date }) => run("get_day", () => tools.getDay(telegramId, date))
  )

  server.registerTool(
    "get_summary",
    {
      title: "Summary",
      description:
        `Averages over logged days, days over the calorie goal, days meeting the protein goal, lowest and highest days, ` +
        `and the most often logged foods for a range (at most ${MAX_RANGE_DAYS} days).`,
      inputSchema: rangeArgs,
      annotations: READ_ONLY,
    },
    async (args) => run("get_summary", () => tools.getSummary(telegramId, args))
  )

  return server
}

export function createMcpHandler(deps: McpDeps) {
  const tools = createConnectorTools(deps)
  const analytics = deps.analytics ?? noopAnalytics

  return async (request: Request, token: string): Promise<Response> => {
    const telegramId = deps.apiTokensRepo.findUser(token)
    // Same answer for an unknown token and a user who lost access: nothing to probe.
    if (telegramId === null || !deps.isAllowed(telegramId)) {
      return new Response("Not found", { status: 404 })
    }

    // Stateless, so no SSE stream to open (GET) or session to end (DELETE).
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } })
    }

    // A fresh server per request, answering with plain JSON.
    const server = buildServer(telegramId, tools, analytics)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
}
