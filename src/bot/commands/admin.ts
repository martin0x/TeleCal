// src/bot/commands/admin.ts
import { Context } from "grammy"
import { config } from "../../config"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"

export function createAdminCommand(repo: AllowedUsersRepository) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId || !config.adminUsers.includes(userId)) {
      await ctx.reply("⛔ Admin only command.")
      return
    }

    const text = ctx.message?.text ?? ""
    const args = text.split(/\s+/).slice(1)
    const subcommand = args[0]?.toLowerCase()

    if (!subcommand) {
      await ctx.reply(
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
          await ctx.reply("Usage: /admin add <telegram_user_id>")
          return
        }
        repo.add(targetId, userId)
        await ctx.reply(`✓ Added user ${targetId} to allowlist`)
        break
      }

      case "remove": {
        const targetId = parseInt(args[1], 10)
        if (isNaN(targetId)) {
          await ctx.reply("Usage: /admin remove <telegram_user_id>")
          return
        }
        repo.remove(targetId)
        await ctx.reply(`✓ Removed user ${targetId} from allowlist`)
        break
      }

      case "list": {
        const users = repo.listAll()
        if (users.length === 0) {
          await ctx.reply("📋 Allowlist is empty")
          return
        }
        const lines = users.map((u) => `• ${u.telegram_id}`)
        await ctx.reply(`📋 Allowed users:\n${lines.join("\n")}`)
        break
      }

      default:
        await ctx.reply(`Unknown subcommand: ${subcommand}`)
    }
  }
}
