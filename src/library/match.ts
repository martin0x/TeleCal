// src/library/match.ts
// Matching a meal against a user's saved foods, in code. Pure: no database,
// no AI. matchMeal decides whether a log can skip the AI entirely;
// candidatesFor picks the saved foods worth showing the AI otherwise.
import { MACROS } from "../macros"
import type { FoodEstimate } from "../ai/types"
import { foodWords, normalizeFoodName } from "../utils/normalize"
import type { SavedFood, ServingUnit } from "./types"

export type Quantity = { kind: "servings"; n: number } | { kind: "amount"; value: number; unit: ServingUnit }
export type MatchedItem = { food: SavedFood; servings: number }

export const MAX_CANDIDATES = 15

const NUMBER = String.raw`(\d+(?:\.\d+)?)`
const UNIT = String.raw`(g|grams?|ml)`
const SERVINGS_WORD = String.raw`(?:servings?\s+(?:of\s+)?)?`
const WORD_QUANTITIES: Record<string, number> = { a: 1, an: 1, one: 1, half: 0.5 }

const LEADING_AMOUNT = new RegExp(`^${NUMBER}\\s*${UNIT}\\s+(?:of\\s+)?(.+)$`)
const LEADING_FRACTION = new RegExp(`^(\\d+)\\/(\\d+)\\s+${SERVINGS_WORD}(.+)$`)
const LEADING_COUNT = new RegExp(`^[x×]?${NUMBER}\\s*[x×]?\\s+${SERVINGS_WORD}(.+)$`)
const LEADING_WORD = new RegExp(`^(a|an|one|half)\\s+${SERVINGS_WORD}(.+)$`)
const TRAILING_AMOUNT = new RegExp(`^(.+?)\\s+${NUMBER}\\s*${UNIT}$`)
const TRAILING_COUNT = new RegExp(`^(.+?)\\s+[x×]\\s*${NUMBER}$`)
const TRAILING_COUNT_X = new RegExp(`^(.+?)\\s+${NUMBER}\\s*[x×]$`)

/** Short and quantity words that say nothing about which food is meant. */
const IGNORED_WORDS = new Set(["and", "with", "the", "gram", "grams", "cup", "cups", "serving", "servings", "piece", "pieces", "pcs"])

function unitOf(text: string): ServingUnit {
  return text === "ml" ? "ml" : "g"
}

function servings(n: number): Quantity | null {
  return Number.isFinite(n) && n > 0 ? { kind: "servings", n } : null
}

/**
 * Splits a quantity off the start or end of one part of a meal: "2x oats",
 * "oats x2", "1/2 oats", "half oats", "80g oats", "oats 80 g". No quantity
 * means one serving. Null when a quantity is there but unusable ("0 oats").
 */
export function parseQuantity(part: string): { quantity: Quantity; rest: string } | null {
  const text = part.trim().toLowerCase().replace(/\s+/g, " ")
  let m: RegExpMatchArray | null

  if ((m = text.match(LEADING_AMOUNT))) {
    const value = Number(m[1])
    return value > 0 ? { quantity: { kind: "amount", value, unit: unitOf(m[2]) }, rest: m[3] } : null
  }
  if ((m = text.match(LEADING_FRACTION))) {
    const q = servings(Number(m[1]) / Number(m[2]))
    return q ? { quantity: q, rest: m[3] } : null
  }
  if ((m = text.match(LEADING_COUNT))) {
    const q = servings(Number(m[1]))
    return q ? { quantity: q, rest: m[2] } : null
  }
  if ((m = text.match(LEADING_WORD))) {
    return { quantity: { kind: "servings", n: WORD_QUANTITIES[m[1]] }, rest: m[2] }
  }
  if ((m = text.match(TRAILING_AMOUNT))) {
    const value = Number(m[2])
    return value > 0 ? { quantity: { kind: "amount", value, unit: unitOf(m[3]) }, rest: m[1] } : null
  }
  if ((m = text.match(TRAILING_COUNT)) || (m = text.match(TRAILING_COUNT_X))) {
    const q = servings(Number(m[2]))
    return q ? { quantity: q, rest: m[1] } : null
  }
  return { quantity: { kind: "servings", n: 1 }, rest: text }
}

function exactFood(text: string, foods: SavedFood[]): SavedFood | null {
  const key = normalizeFoodName(text)
  if (!key) return null
  return foods.find((f) => normalizeFoodName(f.name) === key) ?? null
}

/** The one saved food this text names: an exact name first, then the only food containing every word typed. */
export function findFood(text: string, foods: SavedFood[]): SavedFood | null {
  const exact = exactFood(text, foods)
  if (exact) return exact
  const words = normalizeFoodName(text).split(" ").filter(Boolean)
  if (words.length === 0) return null
  const hits = foods.filter((f) => {
    const names = new Set(foodWords(f.name))
    return words.every((w) => names.has(w))
  })
  return hits.length === 1 ? hits[0] : null
}

/** How many servings a quantity is of this food; null when code can't tell (unit mismatch, no serving amount). */
export function servingsFor(food: SavedFood, quantity: Quantity): number | null {
  if (quantity.kind === "servings") return quantity.n
  if (food.serving_amount === null || food.serving_unit !== quantity.unit) return null
  return quantity.value / food.serving_amount
}

/** "2 skyflakes, milk and oats" → ["2 skyflakes", "milk", "oats"]. */
export function splitMeal(text: string): string[] {
  return text
    .split(/\s*(?:,|\+|&|\n|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
}

function matchPart(part: string, foods: SavedFood[]): MatchedItem | null {
  // A name that starts like a quantity ("Half Moon Cake") wins as a whole.
  const exact = exactFood(part, foods)
  if (exact) return { food: exact, servings: 1 }
  const parsed = parseQuantity(part)
  if (!parsed) return null
  const food = findFood(parsed.rest, foods)
  if (!food) return null
  const count = servingsFor(food, parsed.quantity)
  return count === null ? null : { food, servings: count }
}

/**
 * Every part of the meal as a saved food and a number of servings, or null if
 * any part can't be matched and scaled in code. The whole text is tried as one
 * food first, so a saved "Mac and cheese" is not split in two.
 */
export function matchMeal(text: string, foods: SavedFood[]): MatchedItem[] | null {
  if (foods.length === 0) return null
  const whole = matchPart(text, foods)
  if (whole) return [whole]
  const parts = splitMeal(text)
  if (parts.length < 2) return null
  const items: MatchedItem[] = []
  for (const part of parts) {
    const item = matchPart(part, foods)
    if (!item) return null
    items.push(item)
  }
  return items
}

function formatServings(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** A saved food as a logged item: label values times servings, rounded. Blanks stay null. */
export function scaleFood(food: SavedFood, servings: number): FoodEstimate {
  const item = {
    description: servings === 1 ? food.name : `${food.name} ×${formatServings(servings)}`,
    calories: Math.round(food.calories * servings),
    saved_food_id: food.id,
  } as FoodEstimate
  for (const m of MACROS) {
    const value = food[m.column]
    item[m.column] = value === null ? null : Math.round(value * servings)
  }
  return item
}

function meaningfulWords(text: string): string[] {
  return foodWords(text).filter((w) => w.length >= 3 && !/^\d/.test(w) && !IGNORED_WORDS.has(w))
}

/** Up to `limit` saved foods sharing a word with the text: most shared words first, then shorter names. */
export function candidatesFor(text: string, foods: SavedFood[], limit = MAX_CANDIDATES): SavedFood[] {
  const wanted = new Set(meaningfulWords(text))
  if (wanted.size === 0) return []
  const scored = foods
    .map((food) => {
      let score = 0
      for (const w of new Set(meaningfulWords(food.name))) if (wanted.has(w)) score++
      return { food, score }
    })
    .filter((s) => s.score > 0)
  scored.sort(
    (a, b) => b.score - a.score || a.food.name.length - b.food.name.length || a.food.name.localeCompare(b.food.name)
  )
  return scored.slice(0, limit).map((s) => s.food)
}
