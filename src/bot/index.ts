// src/bot/index.ts
import { Bot, Context } from "grammy"
import { config } from "../config"
import { db } from "../db"
import { AllowedUsersRepository } from "../db/repositories/allowed-users"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { ConversationsRepository } from "../db/repositories/conversations"
import { PendingRepository } from "../db/repositories/pending"
import { CacheRepository } from "../db/repositories/cache"
import { UsageRepository } from "../db/repositories/usage"
import { createAllowlistMiddleware } from "./middleware/allowlist"
import { createAdminCommand } from "./commands/admin"
import { createTodayCommand } from "./commands/today"
import { createWeekCommand, createMonthCommand } from "./commands/stats"
import { createLogCommand, createLogMessageHandler } from "./commands/log"
import { createDeleteCommand, createDeleteMessageHandler, hasDeleteState } from "./commands/delete"
import { createEditCommand, createEditMessageHandler, hasEditState } from "./commands/edit"
import { createSettingsCommand, createSettingsCallbackHandler, createSettingsMessageHandler, hasPendingSettings } from "./commands/settings"
import { createPendingCommand, createPendingCallbackHandler } from "./commands/pending"
import { LogFlow } from "./conversations/log-flow"
import { AIService } from "../ai/service"
import { smartReply } from "./utils/smart-reply"

export interface BotContext extends Context {}

export function createBot() {
  const bot = new Bot<BotContext>(config.telegram.botToken)

  const allowedUsersRepo = new AllowedUsersRepository(db)
  const usersRepo = new UsersRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const conversationsRepo = new ConversationsRepository(db)
  const pendingRepo = new PendingRepository(db)
  const aiService = new AIService(new CacheRepository(db), new UsageRepository(db))
  const logFlow = new LogFlow(conversationsRepo, foodLogsRepo, pendingRepo, aiService)

  bot.use(createAllowlistMiddleware(allowedUsersRepo))

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      usersRepo.upsert(ctx.from.id, ctx.from.username)
    }
    return next()
  })

  bot.command("start", async (ctx) => {
    await smartReply(ctx,
      "Welcome to TeleCal! 🍽️\n\n" +
        "Track your calories with AI-powered estimation.\n\n" +
        "Commands:\n" +
        "/log - Log what you ate\n" +
        "/today - See today's calories\n" +
        "/week - See past 7 days\n" +
        "/month - See past 30 days\n" +
        "/edit - Edit a food entry\n" +
        "/delete - Delete a food entry\n" +
        "/pending - View pending estimations\n" +
        "/settings - Change preferences\n\n" +
        'Tip: Type "cancel" to abort any active conversation.'
    )
  })

  bot.command("admin", createAdminCommand(allowedUsersRepo))
  bot.command("today", createTodayCommand(foodLogsRepo, usersRepo))
  bot.command("week", createWeekCommand(foodLogsRepo, usersRepo))
  bot.command("month", createMonthCommand(foodLogsRepo, usersRepo))
  bot.command("log", createLogCommand(logFlow, conversationsRepo, usersRepo))
  bot.command("delete", createDeleteCommand(foodLogsRepo, usersRepo))
  bot.command("edit", createEditCommand(foodLogsRepo, usersRepo))
  bot.command("settings", createSettingsCommand(usersRepo, aiService))
  bot.command("pending", createPendingCommand(pendingRepo))

  // Handle callback queries for inline keyboards
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery?.data
    if (data?.startsWith("settings:")) {
      return createSettingsCallbackHandler(usersRepo, aiService)(ctx)
    }
    if (data?.startsWith("pending:")) {
      return createPendingCallbackHandler(pendingRepo)(ctx)
    }
    return next()
  })

  // Create message handlers
  const logMessageHandler = createLogMessageHandler(logFlow, conversationsRepo, usersRepo)
  const deleteMessageHandler = createDeleteMessageHandler(foodLogsRepo)
  const editMessageHandler = createEditMessageHandler(foodLogsRepo, usersRepo, aiService)
  const settingsMessageHandler = createSettingsMessageHandler(usersRepo)

  // Handle text messages - route to appropriate handler based on active state
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id
    if (!userId) return

    // Priority order: settings > delete > edit > log conversation
    if (hasPendingSettings(userId)) {
      return settingsMessageHandler(ctx)
    }
    if (hasDeleteState(userId)) {
      return deleteMessageHandler(ctx)
    }
    if (hasEditState(userId)) {
      return editMessageHandler(ctx)
    }
    // Default to log conversation handler
    return logMessageHandler(ctx)
  })

  return { bot, allowedUsersRepo, usersRepo, foodLogsRepo, conversationsRepo, pendingRepo, aiService, logFlow }
}
