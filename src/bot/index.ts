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
import { AccessRequestsRepository } from "../db/repositories/access-requests"
import { AnnouncementsRepository } from "../db/repositories/announcements"
import { createAllowlistMiddleware } from "./middleware/allowlist"
import { createAccessDecisionHandler, createAdminNotifier } from "./access"
import { HELP_TEXT } from "./help"
import { createAdminCommand, createBackfillDeps } from "./commands/admin"
import { createTodayCommand } from "./commands/today"
import { createWeekCommand, createMonthCommand } from "./commands/stats"
import { createLogCommand, createLogMessageHandler, createLogCallbackHandler } from "./commands/log"
import { createDeleteCommand, createDeleteMessageHandler, createDeleteCallbackHandler, hasDeleteState } from "./commands/delete"
import { createEditCommand, createEditMessageHandler, hasEditState } from "./commands/edit"
import { createSettingsCommand, createSettingsCallbackHandler, createSettingsMessageHandler, hasPendingSettings } from "./commands/settings"
import { createPendingCommand, createPendingCallbackHandler } from "./commands/pending"
import { createUsageCommand } from "./commands/usage"
import {
  createFoodsCommand,
  createFoodsMessageHandler,
  createFoodsCallbackHandler,
  isAwaitingFoodsPaste,
  stopAwaitingPaste,
  type FoodsDeps,
} from "./commands/foods"
import { LogFlow } from "./conversations/log-flow"
import { AIService } from "../ai/service"
import { FoodLibraryRepository } from "../db/repositories/food-library"
import { MealEstimator } from "../library/estimator"
import { noopAnalytics, type Analytics } from "../analytics"
import { withContentPreference } from "../analytics/content-preference"
import { createBotErrorHandler } from "./errors"
import { smartReply } from "./utils/smart-reply"

export interface BotContext extends Context {}

export function createBot(baseAnalytics: Analytics = noopAnalytics) {
  const bot = new Bot<BotContext>(config.telegram.botToken)

  const usersRepo = new UsersRepository(db)
  // Everything below reports through this, so the /settings meal text option
  // applies everywhere. A user with no row yet gets the default: on.
  const analytics = withContentPreference(baseAnalytics, (id) => usersRepo.findById(id)?.analytics_content ?? true)

  bot.catch(createBotErrorHandler(analytics))

  const allowedUsersRepo = new AllowedUsersRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const conversationsRepo = new ConversationsRepository(db)
  const pendingRepo = new PendingRepository(db)
  const usageRepo = new UsageRepository(db)
  const aiService = new AIService(new CacheRepository(db), usageRepo, analytics)
  const foodLibraryRepo = new FoodLibraryRepository(db)
  const foodLibraryEnabled = config.features.localFoodDb
  const mealEstimator = new MealEstimator({ enabled: foodLibraryEnabled, library: foodLibraryRepo, ai: aiService, analytics })
  const logFlow = new LogFlow(conversationsRepo, foodLogsRepo, pendingRepo, mealEstimator, usersRepo, {
    foodLibrary: foodLibraryEnabled,
  })

  const foodsDeps: FoodsDeps = {
    enabled: foodLibraryEnabled,
    library: foodLibraryRepo,
    foodLogs: foodLogsRepo,
    ai: aiService,
    users: usersRepo,
    analytics,
    miniAppUrl: config.web.miniAppUrl,
  }

  const accessRequestsRepo = new AccessRequestsRepository(db)
  const announcementsRepo = new AnnouncementsRepository(db)
  bot.use(
    createAllowlistMiddleware({
      allowedUsersRepo,
      accessRequestsRepo,
      adminIds: config.adminUsers,
      notifyAdmins: createAdminNotifier(bot.api, config.adminUsers),
      analytics,
    })
  )

  bot.use(async (ctx, next) => {
    if (ctx.from) {
      usersRepo.upsert(ctx.from.id, ctx.from.username)
    }
    return next()
  })

  // Any command stops /foods waiting for a paste, so the next message isn't taken as one.
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.message?.text?.startsWith("/")) stopAwaitingPaste(ctx.from.id)
    return next()
  })

  bot.command("start", async (ctx) => {
    await smartReply(ctx, HELP_TEXT)
  })

  // The backfill gets its own AIService, which sends PostHog no meal text: see createBackfillDeps.
  const backfillDeps = createBackfillDeps(new CacheRepository(db), usageRepo, analytics)
  bot.command("admin", createAdminCommand(allowedUsersRepo, usageRepo, { foodLogsRepo, usersRepo, announcementsRepo, analytics, ...backfillDeps }, accessRequestsRepo))
  bot.command("usage", createUsageCommand(usageRepo))
  bot.command("today", createTodayCommand(foodLogsRepo, usersRepo))
  bot.command("week", createWeekCommand(foodLogsRepo, usersRepo))
  bot.command("month", createMonthCommand(foodLogsRepo, usersRepo))
  bot.command("log", createLogCommand(logFlow, conversationsRepo, usersRepo))
  bot.command("delete", createDeleteCommand(foodLogsRepo, usersRepo))
  bot.command("edit", createEditCommand(foodLogsRepo, usersRepo))
  bot.command("settings", createSettingsCommand(usersRepo, aiService))
  bot.command("pending", createPendingCommand(pendingRepo))
  bot.command("foods", createFoodsCommand(foodsDeps))

  // Handle callback queries for inline keyboards
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery?.data
    if (data?.startsWith("settings:")) {
      return createSettingsCallbackHandler(usersRepo, aiService)(ctx)
    }
    if (data?.startsWith("pending:")) {
      return createPendingCallbackHandler(pendingRepo)(ctx)
    }
    if (data?.startsWith("log:")) {
      return createLogCallbackHandler(logFlow)(ctx)
    }
    if (data?.startsWith("del:")) {
      return createDeleteCallbackHandler(foodLogsRepo, usersRepo)(ctx)
    }
    if (data?.startsWith("access:")) {
      return createAccessDecisionHandler({ accessRequestsRepo, allowedUsersRepo, adminIds: config.adminUsers, analytics })(ctx)
    }
    if (data?.startsWith("foods:")) {
      return createFoodsCallbackHandler(foodsDeps)(ctx)
    }
    return next()
  })

  // Create message handlers
  const logMessageHandler = createLogMessageHandler(logFlow, conversationsRepo, usersRepo)
  const deleteMessageHandler = createDeleteMessageHandler(foodLogsRepo, usersRepo)
  const editMessageHandler = createEditMessageHandler(foodLogsRepo, usersRepo, aiService)
  const settingsMessageHandler = createSettingsMessageHandler(usersRepo)
  const foodsMessageHandler = createFoodsMessageHandler(foodsDeps)

  // Handle text messages - route to appropriate handler based on active state
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id
    if (!userId) return

    // Priority order: settings > delete > edit > foods paste > log conversation
    if (hasPendingSettings(userId)) {
      return settingsMessageHandler(ctx)
    }
    if (hasDeleteState(userId)) {
      return deleteMessageHandler(ctx)
    }
    if (hasEditState(userId)) {
      return editMessageHandler(ctx)
    }
    if (isAwaitingFoodsPaste(userId)) {
      return foodsMessageHandler(ctx)
    }
    // Default to log conversation handler
    return logMessageHandler(ctx)
  })

  return { bot, allowedUsersRepo, usersRepo, foodLogsRepo, conversationsRepo, pendingRepo, aiService, foodLibraryRepo, mealEstimator, logFlow, analytics }
}
