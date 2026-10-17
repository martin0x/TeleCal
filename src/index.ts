// src/index.ts
import { config } from "./config"
import { initializeDatabase } from "./db"
import { createBot } from "./bot"
import { startReminderJob } from "./jobs/reminders"
import { startRetryPendingJob } from "./jobs/retry-pending"
import { startWebServer } from "./web/server"
import { createAnalytics } from "./analytics"
import { createShutdown } from "./shutdown"

console.log("TeleCal starting...")

// Throws on a key without POSTHOG_ID_SECRET, before anything could be sent.
const analytics = createAnalytics(config.posthog)

initializeDatabase()
console.log("Database initialized")

const { bot, usersRepo, foodLogsRepo, pendingRepo, aiService } = createBot()

// Fetches the bot's own username (getMe) for the landing page's t.me links.
// bot.start() below reuses it instead of calling getMe again.
await bot.init()

// Start web server
const webServer = startWebServer({
  usersRepo,
  foodLogsRepo,
  botUsername: bot.botInfo.username,
  baseUrl: config.web.baseUrl,
})
console.log(`Web server running on port ${config.web.port}`)

// Start background jobs
let reminderInterval: NodeJS.Timeout
let retryInterval: NodeJS.Timeout

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} started`)

    // Start background jobs after bot is running
    reminderInterval = startReminderJob(bot, usersRepo, foodLogsRepo)
    retryInterval = startRetryPendingJob(bot, pendingRepo, foodLogsRepo, usersRepo, aiService)
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
