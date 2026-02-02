// src/bot/middleware/allowlist.ts
import { Context, NextFunction } from "grammy"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { config } from "../../config"
import { smartReply } from "../utils/smart-reply"

export function createAllowlistMiddleware(repo: AllowedUsersRepository) {
  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id
    if (!userId) return

    if (config.adminUsers.includes(userId)) {
      return next()
    }

    if (repo.isAllowed(userId)) {
      return next()
    }

    await smartReply(ctx, "⛔ Sorry, this bot is invite-only.\nContact the admin to request access.")
  }
}
