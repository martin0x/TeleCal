// src/index.ts
import { config } from "./config"
import { initializeDatabase } from "./db"
import { createBot } from "./bot"
import { startReminderJob } from "./jobs/reminders"
import { startRetryPendingJob } from "./jobs/retry-pending"
import { startWebServer } from "./web/server"

console.log("TeleCal starting...")

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

process.on("SIGINT", () => {
  console.log("Shutting down...")
  clearInterval(reminderInterval)
  clearInterval(retryInterval)
  webServer.stop()
  bot.stop()
  process.exit(0)
})
