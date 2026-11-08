// src/library/preview.ts
// What a user sees before anything is saved: rows from a paste or a log,
// validated, marked when they replace a saved food, and formatted to fit one
// Telegram message.
import { MACROS } from "../macros"
import type { ParsedFoodsReply } from "../ai/types"
import type { FoodItem } from "../db/repositories/food-logs"
import { normalizeFoodName } from "../utils/normalize"
import { AS_LOGGED, DEFAULT_SERVING, validateFood } from "./validate"
import type { FoodFields, SavedFood } from "./types"

export type PreviewRow = { food: FoodFields; replaces: boolean }
export type Unreadable = { text: string; reason: string }
export type Preview = { rows: PreviewRow[]; unreadable: Unreadable[] }

/** Telegram's limit is 4096; leave room for the "…and N more" line and the footer. */
const MAX_PREVIEW_CHARS = 3800
const MAX_UNREADABLE_SHOWN = 5
const MAX_UNREADABLE_TEXT = 40
const MAX_UNREADABLE_REASON = 40

function finish(foods: FoodFields[], unreadable: Unreadable[], existing: SavedFood[]): Preview {
  // The same name twice in one batch: the later row wins, as saving would.
  const byName = new Map<string, FoodFields>()
  for (const food of foods) {
    const key = normalizeFoodName(food.name)
    byName.delete(key)
    byName.set(key, food)
  }
  const saved = new Set(existing.map((f) => normalizeFoodName(f.name)))
  return {
    rows: [...byName.entries()].map(([key, food]) => ({ food, replaces: saved.has(key) })),
    unreadable,
  }
}

/** A parse reply → rows that passed validateFood; the rest join the model's own unreadable list. */
export function importPreview(reply: ParsedFoodsReply, existing: SavedFood[]): Preview {
  const foods: FoodFields[] = []
  const unreadable: Unreadable[] = [...reply.unreadable]
  for (const raw of reply.foods) {
    const result = validateFood(raw)
    if (result.ok) foods.push(result.food)
    else unreadable.push({ text: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "a row", reason: result.reason })
  }
  return finish(foods, unreadable, existing)
}

/**
 * A log's items → foods served "as logged". Items that came from a saved food
 * are left out while that food still exists; once it is deleted, they are
 * offered again.
 */
export function logPreview(items: FoodItem[], existing: SavedFood[]): Preview {
  const foods: FoodFields[] = []
  const unreadable: Unreadable[] = []
  for (const item of items) {
    if (existing.some((f) => f.id === item.saved_food_id)) continue
    const result = validateFood({ ...item, name: item.description, serving: AS_LOGGED })
    if (result.ok) foods.push(result.food)
    else unreadable.push({ text: item.description, reason: result.reason })
  }
  return finish(foods, unreadable, existing)
}

/** "Quaker Oats · 1/2 cup (40 g) · 150 cal · 5g protein · 3g fat · 4g fiber": every value the label has. */
export function formatFoodLine(food: FoodFields): string {
  const serving = food.serving === DEFAULT_SERVING ? "no serving size" : food.serving
  const macros = MACROS.filter((m) => food[m.column] !== null).map((m) => `${food[m.column]}g ${m.totalLabel}`)
  return [food.name, serving, `${food.calories} cal`, ...macros].join(" · ")
}

function truncateField(field: string, maxLen: number): string {
  return field.length > maxLen ? `${field.slice(0, maxLen - 1)}…` : field
}

function unreadableLine(unreadable: Unreadable[]): string {
  if (unreadable.length === 0) return ""
  const shown = unreadable.slice(0, MAX_UNREADABLE_SHOWN).map((u) => {
    const text = truncateField(u.text, MAX_UNREADABLE_TEXT)
    const reason = truncateField(u.reason, MAX_UNREADABLE_REASON)
    return `"${text}" (${reason})`
  })
  const more = unreadable.length > MAX_UNREADABLE_SHOWN ? `, and ${unreadable.length - MAX_UNREADABLE_SHOWN} more` : ""
  return `\nCouldn't read: ${shown.join(", ")}${more}`
}

/** Header, numbered rows, then what couldn't be read. Rows are cut to fit one message, ending "…and N more". */
export function formatPreview(header: string, preview: Preview): string {
  const footer = unreadableLine(preview.unreadable)
  const lines: string[] = []
  let length = header.length + footer.length
  for (const [i, row] of preview.rows.entries()) {
    const line = `${i + 1}. ${formatFoodLine(row.food)}${row.replaces ? " (replaces your saved one)" : ""}`
    if (length + line.length + 1 > MAX_PREVIEW_CHARS) {
      lines.push(`…and ${preview.rows.length - i} more`)
      break
    }
    lines.push(line)
    length += line.length + 1
  }
  return [header, ...lines].join("\n") + footer
}
