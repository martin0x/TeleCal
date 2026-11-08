// src/library/types.ts
import type { MacroColumn } from "../macros"

export type ServingUnit = "g" | "ml"
export type FoodSource = "import" | "single" | "log"

/** What a user saves: label values per serving. Macros in grams, decimals allowed; null = not on the label. */
export type FoodFields = {
  name: string
  serving: string
  /** Only together with serving_unit; both null when the label gives no amount. */
  serving_amount: number | null
  serving_unit: ServingUnit | null
  calories: number
} & Record<MacroColumn, number | null>

/** A row of food_library. */
export type SavedFood = FoodFields & {
  id: number
  telegram_id: number
  source: FoodSource
}
