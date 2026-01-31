// src/index.ts
import { config } from "./config"
import { initializeDatabase } from "./db"
import { createBot } from "./bot"
import { startReminderJob } from "./jobs/reminders"
import { startRetryPendingJob } from "./jobs/retry-pending"

console.log("TeleCal starting...")

initializeDatabase()
console.log("Database initialized")

const { bot, usersRepo, foodLogsRepo, pendingRepo, aiService } = createBot()

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
  bot.stop()
  process.exit(0)
})
