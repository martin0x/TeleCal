// src/web/server.ts
import { readFileSync } from "fs"
import { join } from "path"
import { config } from "../config"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { validateInitData, extractAuthHeader, TelegramUser } from "./auth"
import { createApiHandlers } from "./api"
import { landingAnalyticsScript, miniAppAnalyticsScript, type WebAnalyticsConfig } from "./analytics-snippet"
import { createMcpHandler, MCP_PATH, type McpDeps } from "./mcp"

export interface WebServerDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
  /** Without the @. Fills {{BOT_USERNAME}} in the landing page. */
  botUsername: string
  /** APP_URL without a trailing slash. Fills {{BASE_URL}}. */
  baseUrl: string
  /** PostHog for the web pages; omitted (no key) means no analytics script at all. */
  analytics?: WebAnalyticsConfig
  /** POSTHOG_ID_SECRET, for analytics_id in /api/user. Server-side only: never put it in a page. */
  analyticsIdSecret?: string
  /** The Claude connector at /mcp/<token>; omitted, those paths are 404. */
  mcp?: Omit<McpDeps, "usersRepo" | "foodLogsRepo">
}

const VIEWS_DIR = join(import.meta.dir, "views")
const PUBLIC_DIR = join(import.meta.dir, "public")

// The name pattern is the traversal guard: no slashes, dots only before the extension.
const ASSET_PATH = /^\/assets\/([a-z0-9-]+\.(svg|png|jpg))$/
const ASSET_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

interface LandingValues {
  botUsername: string
  baseUrl: string
  /** A complete <script> block, built by landingAnalyticsScript; not escaped. */
  analyticsScript?: string
}

export function renderLanding(template: string, values: LandingValues): string {
  return template
    .replaceAll("{{BOT_USERNAME}}", escapeAttribute(values.botUsername))
    .replaceAll("{{BASE_URL}}", escapeAttribute(values.baseUrl))
    .replace("{{ANALYTICS}}", () => values.analyticsScript ?? "")
}

/** app.html with its {{ANALYTICS}} slot filled; null if the file can't be read. */
function loadMiniApp(analyticsScript: string): string | null {
  try {
    return readFileSync(join(VIEWS_DIR, "app.html"), "utf-8").replace("{{ANALYTICS}}", () => analyticsScript)
  } catch (error) {
    console.error("[web] Mini App unavailable:", error)
    return null
  }
}

function loadLanding(values: LandingValues): string | null {
  try {
    return renderLanding(readFileSync(join(VIEWS_DIR, "landing.html"), "utf-8"), values)
  } catch (error) {
    console.error("[web] landing page unavailable:", error)
    return null
  }
}

export function createFetchHandler(deps: WebServerDeps) {
  const { usersRepo, foodLogsRepo, analyticsIdSecret } = deps
  const api = createApiHandlers({ usersRepo, foodLogsRepo, analyticsIdSecret })
  // Rendered once: the template and both values are fixed for the process lifetime.
  const landing = loadLanding({
    botUsername: deps.botUsername,
    baseUrl: deps.baseUrl,
    analyticsScript: landingAnalyticsScript(deps.analytics),
  })
  const miniApp = loadMiniApp(miniAppAnalyticsScript(deps.analytics))
  const mcp = deps.mcp ? createMcpHandler({ usersRepo, foodLogsRepo, ...deps.mcp }) : null

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/" || path === "/index.html") {
      if (landing === null) {
        return new Response("Service unavailable", { status: 503 })
      }
      return new Response(landing, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (path === "/app" || path === "/app/") {
      if (miniApp === null) {
        return new Response("Mini App not found", { status: 404 })
      }
      return new Response(miniApp, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    const asset = path.match(ASSET_PATH)
    if (asset) {
      return serveAsset(asset[1], asset[2])
    }

    // The token in the path is the credential: never log this path.
    const mcpMatch = mcp && path.match(MCP_PATH)
    if (mcpMatch) {
      return mcp(request, mcpMatch[1])
    }

    // API routes require authentication
    if (path.startsWith("/api/")) {
      const initData = extractAuthHeader(request)
      const user = initData
        ? validateInitData(initData, config.telegram.botToken)
        : null

      if (!user) {
        return jsonResponse({ error: "Unauthorized" }, 401)
      }

      return handleApiRoute(path, url, user, api)
    }

    return new Response("Not found", { status: 404 })
  }
}

export function startWebServer(deps: WebServerDeps) {
  return Bun.serve({
    port: config.web.port,
    fetch: createFetchHandler(deps),
  })
}

async function serveAsset(name: string, extension: string): Promise<Response> {
  const file = Bun.file(join(PUBLIC_DIR, name))

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": ASSET_TYPES[extension],
      "Cache-Control": "public, max-age=86400",
    },
  })
}

function handleApiRoute(
  path: string,
  url: URL,
  user: TelegramUser,
  api: ReturnType<typeof createApiHandlers>
): Response {
  // GET /api/user
  if (path === "/api/user") {
    return jsonResponse(api.getUser(user.id))
  }

  // GET /api/today
  if (path === "/api/today") {
    return jsonResponse(api.getToday(user.id))
  }

  // GET /api/stats?period=week|month
  if (path === "/api/stats") {
    const period = url.searchParams.get("period") || "week"
    if (period !== "week" && period !== "month") {
      return jsonResponse({ error: "Invalid period" }, 400)
    }
    return jsonResponse(api.getStats(user.id, period))
  }

  // GET /api/day/:date
  const dayMatch = path.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/)
  if (dayMatch) {
    const date = dayMatch[1]
    return jsonResponse(api.getDay(user.id, date))
  }

  return jsonResponse({ error: "Not found" }, 404)
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
