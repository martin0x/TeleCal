// src/ai/parse.ts
// Model output is untrusted: a field can be missing, a string, or NaN. These
// helpers turn whatever came back into the shapes the rest of the app trusts.
import type { FoodEstimate } from "./types"

/** Whole grams, or null when the value is not a finite number (or numeric string). */
export function coerceProtein(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  if (typeof num !== "number" || !Number.isFinite(num)) return null
  return Math.max(0, Math.round(num))
}

/** Items from a parsed estimate, each with protein_g coerced. Non-arrays become []. */
export function normalizeItems(items: unknown): FoodEstimate[] {
  if (!Array.isArray(items)) return []
  return items.map((item) => {
    const raw = item as Record<string, unknown>
    return { ...(raw as unknown as FoodEstimate), protein_g: coerceProtein(raw.protein_g) }
  })
}

/** Strips a markdown code fence that prose-prompted models sometimes wrap JSON in. */
export function stripFences(text: string): string {
  let s = text.trim()
  if (s.startsWith("```")) {
    s = s.replace(/```json?\n?/g, "").replace(/```$/g, "").trim()
  }
  return s
}
