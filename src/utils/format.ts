// src/utils/format.ts
import { createHash } from "node:crypto"

/**
 * A single AI call costs roughly $0.0002, so two-decimal formatting would
 * render a light month as "$0.00" — which reads as broken rather than cheap.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString("en-US")
}

/** Escapes text for Telegram's HTML parse mode, which only requires these three. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export interface SummaryItem {
  description: string
  calories: number
  emoji?: string | null
}

/**
 * Items in a quote box with a bold total beneath, for messages sent with
 * parse_mode "HTML". This replaces a row of ─ characters, which wrapped onto a
 * second line on narrow screens: no character count fits every client, and a
 * blockquote does not depend on width at all.
 */
export function formatItemsSummary(items: SummaryItem[], opts: { struck?: boolean } = {}): string {
  const strike = (text: string) => (opts.struck ? `<s>${text}</s>` : text)
  const lines = items
    .map(
      (item) =>
        `${escapeHtml(String(item.emoji ?? "🍽️"))} ${escapeHtml(String(item.description))} — ${escapeHtml(String(item.calories))} cal`
    )
    .join("\n")
  const total = items.reduce((sum, item) => sum + item.calories, 0)
  return `<blockquote>${strike(lines)}</blockquote>\n<b>${strike(`Total: ${total} cal`)}</b>`
}

/** First 8 hex characters of SHA-256 — short enough for 64-byte button data. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8)
}
