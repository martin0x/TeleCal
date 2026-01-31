// src/index.ts
import { config } from "./config"
import { initializeDatabase } from "./db"
import { createBot } from "./bot"

console.log("TeleCal starting...")

initializeDatabase()
console.log("Database initialized")

const { bot } = createBot()

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} started`)
  },
})

process.on("SIGINT", () => {
  console.log("Shutting down...")
  bot.stop()
  process.exit(0)
})
