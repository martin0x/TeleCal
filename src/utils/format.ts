// src/utils/format.ts
import { createHash } from "node:crypto"
import { MACROS, zeroTotals, type Macro, type MacroColumn, type MacroKey, type Totals } from "../macros"

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

/** An item as the formatters see it. Macro columns are whole grams; null or missing = unknown. */
export type SummaryItem = {
  description: string
  calories: number
  emoji?: string | null
} & Partial<Record<MacroColumn, number | null>>

/** 1450 → "1,450". */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US")
}

const n = formatNumber

function isKnown(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/** The registry entries a user tracks, in registry order. */
function selected(macros: readonly MacroKey[]): Macro[] {
  return MACROS.filter((m) => macros.includes(m.key))
}

/** Calories and every macro across items. Unknown values count as 0. */
export function sumTotals(items: Pick<SummaryItem, "calories" | MacroColumn>[]): Totals {
  const totals = zeroTotals()
  for (const item of items) {
    totals.calories += item.calories
    for (const m of MACROS) {
      const value = item[m.column]
      if (isKnown(value)) totals[m.key] += value
    }
  }
  return totals
}

/** `38 g` for protein, `24 g fat` for the rest; `? g` and `? g fat` when unknown. */
function itemAmount(macro: Macro, value: number | null | undefined): string {
  const grams = isKnown(value) ? `${value} g` : "? g"
  return macro.itemLabel ? `${grams} ${macro.itemLabel}` : grams
}

/**
 * One item, plain text: `🍳 2 scrambled eggs — 180 cal · 14 g`, then each
 * other tracked macro. String() guards against a model that returns a number
 * where a string belongs.
 */
export function formatItemLine(item: SummaryItem, macros: readonly MacroKey[]): string {
  const head = `${String(item.emoji ?? "🍽️")} ${String(item.description)} — ${String(item.calories)} cal`
  return [head, ...selected(macros).map((m) => itemAmount(m, item[m.column]))].join(" · ")
}

/** `335 cal · 28 g protein`: the total spells out what the item lines abbreviate. */
export function formatTotals(totals: Totals, macros: readonly MacroKey[]): string {
  return [`${n(totals.calories)} cal`, ...selected(macros).map((m) => `${n(totals[m.key])} g ${m.totalLabel}`)].join(" · ")
}

/**
 * Items in a quote box with a bold total a blank line beneath, for messages
 * sent with parse_mode "HTML". Callers leave a blank line above it too, since
 * Telegram draws the quote flush against the lines around it. The quote box
 * replaces a row of ─ characters, which wrapped onto a second line on narrow
 * screens: no character count fits every client, and a blockquote does not
 * depend on width at all.
 */
export function formatItemsSummary(
  items: SummaryItem[],
  macros: readonly MacroKey[],
  opts: { struck?: boolean } = {}
): string {
  const strike = (text: string) => (opts.struck ? `<s>${text}</s>` : text)
  const lines = items.map((item) => escapeHtml(formatItemLine(item, macros))).join("\n")
  return `<blockquote>${strike(lines)}</blockquote>\n\n<b>${strike(`Total: ${formatTotals(sumTotals(items), macros)}`)}</b>`
}

export function createProgressBar(percentage: number): string {
  const filled = Math.max(0, Math.min(Math.round(percentage / 10), 10))
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

/**
 * A goal block for /today and friends. One line without a goal; with a goal,
 * the headline, a 10-block bar with percentage, and a remaining/over/reached
 * line. Same shape for calories (a ceiling) and protein (a floor): /today says
 * "remaining" for both; the weekly stats carry the direction. The lines for
 * fat, fiber and added sugar have no emoji and no goal.
 */
export function formatGoalProgress(opts: {
  emoji?: string
  label: string
  current: number
  goal: number | null | undefined
  unit: string
}): string {
  const { emoji, label, current, goal, unit } = opts
  const title = emoji ? `${emoji} ${label}` : label
  if (!goal) return `${title}: ${n(current)} ${unit}`

  const percentage = Math.round((current / goal) * 100)
  const remaining = goal - current
  let out = `${title}: ${n(current)} / ${n(goal)} ${unit}\n${createProgressBar(percentage)} ${percentage}%\n`
  if (remaining > 0) out += `✨ ${n(remaining)} ${unit} remaining`
  else if (remaining < 0) out += `⚠️ ${n(Math.abs(remaining))} ${unit} over goal`
  else out += `🎯 Goal reached!`
  return out
}

/** First 8 hex characters of SHA-256 — short enough for 64-byte button data. */
export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8)
}
