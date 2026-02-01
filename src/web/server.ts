// src/web/server.ts
import { config } from "../config"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { validateInitData, extractAuthHeader, TelegramUser } from "./auth"
import { createApiHandlers } from "./api"

export interface WebServerDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
}

export function startWebServer(deps: WebServerDeps) {
  const { usersRepo, foodLogsRepo } = deps
  const api = createApiHandlers({ usersRepo, foodLogsRepo })

  const server = Bun.serve({
    port: config.web.port,
    fetch: async (request) => {
      const url = new URL(request.url)
      const path = url.pathname

      // Serve Mini App HTML
      if (path === "/" || path === "/index.html") {
        return serveHtml()
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

      // 404 for everything else
      return new Response("Not found", { status: 404 })
    },
  })

  return server
}

async function serveHtml(): Promise<Response> {
  const htmlPath = new URL("./views/app.html", import.meta.url).pathname
  const file = Bun.file(htmlPath)

  if (!(await file.exists())) {
    return new Response("Mini App not found", { status: 404 })
  }

  return new Response(file, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
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
