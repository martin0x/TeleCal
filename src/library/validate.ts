// src/library/validate.ts
// One gate for every way a food enters the library: a parsed paste, a logged
// item and a Mini App edit. Input is untrusted (model output or a request body).
import { MACROS, type MacroColumn } from "../macros"
import { normalizeFoodName } from "../utils/normalize"
import type { FoodFields, ServingUnit } from "./types"

export const MAX_FOOD_CALORIES = 5000
export const MAX_FOOD_GRAMS = 500
export const MAX_NAME_LENGTH = 100
export const MAX_SERVING_LENGTH = 100
/** The serving of a row that gave none. */
export const DEFAULT_SERVING = "1 serving"
/** The serving of a food saved from a log: one serving is what was logged. */
export const AS_LOGGED = "as logged"

export type Validation = { ok: true; food: FoodFields } | { ok: false; reason: string }

/** A finite number from a number or numeric string; null for anything else, "" included. */
function toNumber(value: unknown): number | null {
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof num === "number" && Number.isFinite(num) ? num : null
}

function toUnit(value: unknown): ServingUnit | null {
  if (typeof value !== "string") return null
  const unit = value.trim().toLowerCase()
  if (unit === "g" || unit === "gram" || unit === "grams") return "g"
  if (unit === "ml") return "ml"
  return null
}

export function validateFood(input: Record<string, unknown>): Validation {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : ""
  if (!normalizeFoodName(name)) return { ok: false, reason: "no name" }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name too long" }

  const rawCalories = toNumber(input.calories)
  if (rawCalories === null) return { ok: false, reason: "no calories" }
  const calories = Math.round(rawCalories)
  if (calories < 0 || calories > MAX_FOOD_CALORIES) return { ok: false, reason: "calories out of range" }

  const macros = {} as Record<MacroColumn, number | null>
  for (const m of MACROS) {
    const value = toNumber(input[m.column])
    if (value !== null && (value < 0 || value > MAX_FOOD_GRAMS)) {
      return { ok: false, reason: `${m.totalLabel} out of range` }
    }
    macros[m.column] = value === null ? null : Math.round(value * 10) / 10
  }

  const servingText = typeof input.serving === "string" ? input.serving.trim().replace(/\s+/g, " ") : ""
  const serving = (servingText || DEFAULT_SERVING).slice(0, MAX_SERVING_LENGTH)

  const amount = toNumber(input.serving_amount)
  const unit = toUnit(input.serving_unit)
  const hasAmount = amount !== null && amount > 0 && unit !== null

  return {
    ok: true,
    food: {
      name,
      serving,
      serving_amount: hasAmount ? amount : null,
      serving_unit: hasAmount ? unit : null,
      calories,
      ...macros,
    },
  }
}
