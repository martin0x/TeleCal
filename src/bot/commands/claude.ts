// src/bot/commands/claude.ts
// /claude hands out the Claude connector link (src/web/mcp.ts); /claude revoke
// turns it off. The link is a credential, so it is only ever sent in a private chat.
import { Context } from "grammy"
import { ApiTokensRepository } from "../../db/repositories/api-tokens"
import { noopAnalytics, type Analytics } from "../../analytics"
import { escapeHtml } from "../../utils/format"
import { smartReply } from "../utils/smart-reply"

export const PRIVATE_ONLY = "🔒 Your Claude link is private. Send /claude to me in a private chat."
export const USAGE = "Send /claude to get a link for Claude, or /claude revoke to turn it off."
export const REVOKED =
  "🔌 Claude connector turned off. Claude can no longer read your log.\n\n" +
  "You can also remove TeleCal under Settings → Connectors on claude.ai."
export const NOTHING_TO_REVOKE = "You don't have a Claude connector. Send /claude to set one up."

/** HTML: the link sits in <code> so Telegram copies it with a tap. */
export function connectorMessage(url: string): string {
  return (
    "🔗 Your Claude connector link:\n\n" +
    `<code>${escapeHtml(url)}</code>\n\n` +
    "To connect: on claude.ai, open Settings → Connectors → Add custom connector. " +
    "Name it TeleCal and paste the link as the URL.\n\n" +
    "Claude can then read your food log, goals and trends. It can't change anything. " +
    "What Claude reads, meal descriptions included, goes to Anthropic.\n\n" +
    "Treat the link like a password: anyone who has it can read your log. " +
    "Sending /claude again makes a new link and turns this one off. /claude revoke turns it off for good."
  )
}

export interface ClaudeCommandDeps {
  apiTokensRepo: ApiTokensRepository
  /** APP_URL without a trailing slash. */
  baseUrl: string
  analytics?: Analytics
}

export function createClaudeCommand(deps: ClaudeCommandDeps) {
  const { apiTokensRepo, baseUrl } = deps
  const analytics = deps.analytics ?? noopAnalytics

  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return

    if (ctx.chat?.type !== "private") {
      await smartReply(ctx, PRIVATE_ONLY)
      return
    }

    const arg = (typeof ctx.match === "string" ? ctx.match : "").trim().toLowerCase()

    if (arg === "revoke") {
      if (apiTokensRepo.revoke(userId)) {
        analytics.capture(userId, "claude_connector_revoked")
        await ctx.reply(REVOKED)
      } else {
        await ctx.reply(NOTHING_TO_REVOKE)
      }
      return
    }

    if (arg !== "") {
      await ctx.reply(USAGE)
      return
    }

    const token = apiTokensRepo.issue(userId)
    analytics.capture(userId, "claude_connector_created")
    await ctx.reply(connectorMessage(`${baseUrl}/mcp/${token}`), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    })
  }
}
