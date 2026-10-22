// src/index.ts
import { config } from "./config"
import { initializeDatabase } from "./db"
import { createBot } from "./bot"
import { startReminderJob } from "./jobs/reminders"
import { startRetryPendingJob } from "./jobs/retry-pending"
import { startWebServer } from "./web/server"
import { createAnalytics } from "./analytics"
import { createShutdown } from "./shutdown"
import { createProcessErrorHandlers } from "./process-errors"

console.log("TeleCal starting...")

// Throws on a key without POSTHOG_ID_SECRET, before anything could be sent.
const analytics = createAnalytics(config.posthog)
const processErrors = createProcessErrorHandlers({ analytics, exit: (code) => process.exit(code) })
process.on("unhandledRejection", processErrors.onUnhandledRejection)
process.on("uncaughtException", (error) => void processErrors.onUncaughtException(error))

initializeDatabase()
console.log("Database initialized")

// userAnalytics applies each user's /settings meal text choice; anything that
// reports for a user goes through it.
const { bot, allowedUsersRepo, apiTokensRepo, usersRepo, foodLogsRepo, pendingRepo, aiService, analytics: userAnalytics } =
  createBot(analytics)

// Fetches the bot's own username (getMe) for the landing page's t.me links.
// bot.start() below reuses it instead of calling getMe again.
await bot.init()

// Start web server
const webServer = startWebServer({
  usersRepo,
  foodLogsRepo,
  botUsername: bot.botInfo.username,
  baseUrl: config.web.baseUrl,
  // Only what the browser may see: never pass config.posthog whole, it holds the ID secret.
  analytics: config.posthog.apiKey
    ? { apiKey: config.posthog.apiKey, host: config.posthog.host, environment: config.posthog.environment }
    : undefined,
  analyticsIdSecret: config.posthog.apiKey ? config.posthog.idSecret : undefined,
  // The Claude connector; the same gate as the bot's allowlist middleware.
  mcp: {
    apiTokensRepo,
    isAllowed: (id) => config.adminUsers.includes(id) || allowedUsersRepo.isAllowed(id),
    analytics: userAnalytics,
  },
})
console.log(`Web server running on port ${config.web.port}`)

// Start background jobs
let reminderInterval: NodeJS.Timeout
let retryInterval: NodeJS.Timeout

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} started`)

    // Start background jobs after bot is running
    reminderInterval = startReminderJob(bot, usersRepo, foodLogsRepo, userAnalytics)
    retryInterval = startRetryPendingJob(bot, pendingRepo, foodLogsRepo, usersRepo, aiService, userAnalytics)
  },
})

// Railway sends SIGTERM on every redeploy; SIGINT is Ctrl-C locally.
const shutdown = createShutdown({
  stop: () => {
    clearInterval(reminderInterval)
    clearInterval(retryInterval)
    webServer.stop()
    bot.stop()
  },
  analytics,
  exit: (code) => process.exit(code),
})
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
