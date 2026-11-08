// src/utils/normalize.ts
// Food text as the estimation cache and the food library compare it.

/** Lowercase, trimmed, single-spaced, punctuation stripped. The estimation_cache key: never change it. */
export function normalizeFoodText(food: string): string {
  return food
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
}

/** "Mac & Cheese!" → ["mac", "cheese"]. */
export function foodWords(text: string): string[] {
  return normalizeFoodText(text).split(/\s+/).filter(Boolean)
}

/** A saved food's key: its words joined by single spaces. "Quaker  Oats!" → "quaker oats". */
export function normalizeFoodName(name: string): string {
  return foodWords(name).join(" ")
}
