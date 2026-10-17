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
  /** Whole grams. null or undefined = unknown. */
  protein_g?: number | null
  emoji?: string | null
}

const n = (value: number) => value.toLocaleString("en-US")

function isKnownProtein(protein: number | null | undefined): protein is number {
  return typeof protein === "number" && Number.isFinite(protein)
}

/** Calories and known protein across items. Unknown protein counts as 0. */
export function sumTotals(items: Pick<SummaryItem, "calories" | "protein_g">[]): { calories: number; protein: number } {
  return items.reduce<{ calories: number; protein: number }>(
    (acc, item) => ({
      calories: acc.calories + item.calories,
      protein: acc.protein + (isKnownProtein(item.protein_g) ? item.protein_g : 0),
    }),
    { calories: 0, protein: 0 }
  )
}

export function formatProtein(protein: number | null | undefined): string {
  return isKnownProtein(protein) ? `${protein} g` : "? g"
}

/**
 * One item, plain text: `🍳 2 scrambled eggs — 180 cal · 14 g`. String() guards
 * against a model that returns a number where a string belongs.
 */
export function formatItemLine(item: SummaryItem): string {
  return `${String(item.emoji ?? "🍽️")} ${String(item.description)} — ${String(item.calories)} cal · ${formatProtein(item.protein_g)}`
}

/** `335 cal · 28 g protein` — the total spells out the unit the item lines abbreviate. */
export function formatTotals(totals: { calories: number; protein: number }): string {
  return `${n(totals.calories)} cal · ${n(totals.protein)} g protein`
}

/**
 * Items in a quote box with a bold total a blank line beneath, for messages
 * sent with parse_mode "HTML". Callers leave a blank line above it too, since
 * Telegram draws the quote flush against the lines around it. The quote box
 * replaces a row of ─ characters, which wrapped onto a second line on narrow
 * screens: no character count fits every client, and a blockquote does not
 * depend on width at all.
 */
export function formatItemsSummary(items: SummaryItem[], opts: { struck?: boolean } = {}): string {
  const strike = (text: string) => (opts.struck ? `<s>${text}</s>` : text)
  const lines = items.map((item) => escapeHtml(formatItemLine(item))).join("\n")
  return `<blockquote>${strike(lines)}</blockquote>\n\n<b>${strike(`Total: ${formatTotals(sumTotals(items))}`)}</b>`
}

export function createProgressBar(percentage: number): string {
  const filled = Math.max(0, Math.min(Math.round(percentage / 10), 10))
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

/**
 * A goal block for /today and friends. One line without a goal; with a goal,
 * the headline, a 10-block bar with percentage, and a remaining/over/reached
 * line. Same shape for calories (a ceiling) and protein (a floor) — /today says
 * "remaining" for both; the weekly stats carry the direction.
 */
export function formatGoalProgress(opts: {
  emoji: string
  label: string
  current: number
  goal: number | null | undefined
  unit: string
}): string {
  const { emoji, label, current, goal, unit } = opts
  if (!goal) return `${emoji} ${label}: ${n(current)} ${unit}`

  const percentage = Math.round((current / goal) * 100)
  const remaining = goal - current
  let out = `${emoji} ${label}: ${n(current)} / ${n(goal)} ${unit}\n${createProgressBar(percentage)} ${percentage}%\n`
  if (remaining > 0) out += `✨ ${n(remaining)} ${unit} remaining`
  else if (remaining < 0) out += `⚠️ ${n(Math.abs(remaining))} ${unit} over goal`
  else out += `🎯 Goal reached!`
  return out
}

/** First 8 hex characters of SHA-256 — short enough for 64-byte button data. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8)
}
