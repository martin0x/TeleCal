// src/bot/index.ts
import { Bot, Context } from "grammy"
import { config } from "../config"
import { db } from "../db"
import { AllowedUsersRepository } from "../db/repositories/allowed-users"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { createAllowlistMiddleware } from "./middleware/allowlist"
import { createAdminCommand } from "./commands/admin"
import { createTodayCommand } from "./commands/today"
import { createWeekCommand, createMonthCommand } from "./commands/stats"

export interface BotContext extends Context {}

export function createBot() {
  const bot = new Bot<BotContext>(config.telegram.botToken)

  const allowedUsersRepo = new AllowedUsersRepository(db)
  const usersRepo = new UsersRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)

  bot.use(createAllowlistMiddleware(allowedUsersRepo))

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      usersRepo.upsert(ctx.from.id, ctx.from.username)
    }
    return next()
  })

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to TeleCal! 🍽️\n\n" +
        "Track your calories with AI-powered estimation.\n\n" +
        "Commands:\n" +
        "/log - Log what you ate\n" +
        "/today - See today's calories\n" +
        "/week - See past 7 days\n" +
        "/month - See past 30 days\n" +
        "/settings - Change preferences"
    )
  })

  bot.command("admin", createAdminCommand(allowedUsersRepo))
  bot.command("today", createTodayCommand(foodLogsRepo, usersRepo))
  bot.command("week", createWeekCommand(foodLogsRepo, usersRepo))
  bot.command("month", createMonthCommand(foodLogsRepo, usersRepo))

  return { bot, allowedUsersRepo, usersRepo, foodLogsRepo }
}
