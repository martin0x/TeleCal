// src/ai/parse.ts
// Model output is untrusted: a field can be missing, a string, or NaN. These
// helpers turn whatever came back into the shapes the rest of the app trusts.
import { ProviderParseError, type AITrace, type FoodEstimate, type TokenUsage } from "./types"

/** JSON.parse that turns a SyntaxError into a ProviderParseError carrying the call's usage and trace. */
export function parseReply(text: string, usage: TokenUsage, trace: AITrace): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProviderParseError(error, usage, trace)
    throw error
  }
}

/** The trace for one system-prompt + user-message call. */
export function traceOf(system: string, user: string, output: string): AITrace {
  return { input: [{ role: "system", content: system }, { role: "user", content: user }], output }
}

/** Whole grams, or null when the value is not a finite number (or numeric string). */
export function coerceProtein(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof num !== "number" || !Number.isFinite(num)) return null
  return Math.max(0, Math.round(num))
}

/** Items from a parsed estimate, each with protein_g coerced. Non-arrays become []. */
export function normalizeItems(items: unknown): FoodEstimate[] {
  if (!Array.isArray(items)) return []
  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((raw) => ({ ...(raw as unknown as FoodEstimate), protein_g: coerceProtein(raw.protein_g) }))
}

/** Strips a markdown code fence that prose-prompted models sometimes wrap JSON in. */
export function stripFences(text: string): string {
  let s = text.trim()
  if (s.startsWith("```")) {
    s = s.replace(/```json?\n?/g, "").replace(/```$/g, "").trim()
  }
  return s
}

/**
 * Maps a batch reply `{items:[{index, protein_g}]}` back onto the inputs by
 * 1-based index. Anything missing, malformed or out of range stays null, which
 * the backfill reports as unresolved.
 */
export function alignProteinBatch(reply: unknown, count: number): (number | null)[] {
  const out: (number | null)[] = new Array(count).fill(null)
  const items = (reply as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return out
  for (const entry of items) {
    const index = (entry as { index?: unknown } | null)?.index
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > count) continue
    out[index - 1] = coerceProtein((entry as { protein_g?: unknown }).protein_g)
  }
  return out
}
