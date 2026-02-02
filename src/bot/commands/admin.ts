// src/bot/commands/admin.ts
import { Context } from "grammy"
import { config } from "../../config"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { smartReply } from "../utils/smart-reply"

export function createAdminCommand(repo: AllowedUsersRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId || !config.adminUsers.includes(userId)) {
      await smartReply(ctx, "⛔ Admin only command.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1)
    const subcommand = args[0]?.toLowerCase()

    if (!subcommand) {
      await smartReply(ctx,
        "Admin commands:\n" +
          "/admin add <user_id>\n" +
          "/admin remove <user_id>\n" +
          "/admin list"
      )
      return
    }

    switch (subcommand) {
      case "add": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await smartReply(ctx, "Usage: /admin add <telegram_user_id>")
          return
        }
        repo.add(targetId, userId)
        await smartReply(ctx, `✓ Added user ${targetId} to allowlist`)
        break
      }

      case "remove": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await smartReply(ctx, "Usage: /admin remove <telegram_user_id>")
          return
        }
        repo.remove(targetId)
        await smartReply(ctx, `✓ Removed user ${targetId} from allowlist`)
        break
      }

      case "list": {
        const users = repo.listAll()
        if (users.length === 0) {
          await smartReply(ctx, "📋 Allowlist is empty")
          return
        }
        const lines = users.map((u) => `• ${u.telegram_id}`)
        await smartReply(ctx, `📋 Allowed users:\n${lines.join("\n")}`)
        break
      }

      default:
        await smartReply(ctx, `Unknown subcommand: ${subcommand}`)
    }
  }
}
