// src/db/repositories/food-library.ts
import { Database } from "bun:sqlite"
import { MACROS } from "../../macros"
import { normalizeFoodName } from "../../utils/normalize"
import type { FoodFields, FoodSource, SavedFood } from "../../library/types"

const MACRO_COLUMNS = MACROS.map((m) => m.column)
/** Every column a save writes, in fieldValues order. Built from registry constants, never from input. */
const FIELD_COLUMNS = ["name", "normalized_name", "serving", "serving_amount", "serving_unit", "calories", ...MACRO_COLUMNS]
const SELECT_COLUMNS = `id, telegram_id, source, name, serving, serving_amount, serving_unit, calories, ${MACRO_COLUMNS.join(", ")}`

function fieldValues(food: FoodFields): (string | number | null)[] {
  return [
    food.name,
    normalizeFoodName(food.name),
    food.serving,
    food.serving_amount,
    food.serving_unit,
    food.calories,
    ...MACRO_COLUMNS.map((column) => food[column]),
  ]
}

export class FoodLibraryRepository {
  constructor(private db: Database) {}

  /** A–Z by name, ignoring case. */
  listByUser(telegramId: number): SavedFood[] {
    return this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM food_library WHERE telegram_id = ? ORDER BY name COLLATE NOCASE, id`)
      .all(telegramId) as SavedFood[]
  }

  get(telegramId: number, id: number): SavedFood | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM food_library WHERE telegram_id = ? AND id = ?`)
      .get(telegramId, id) as SavedFood | null
    return row ?? null
  }

  count(telegramId: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM food_library WHERE telegram_id = ?").get(telegramId) as {
      n: number
    }
    return row.n
  }

  /** Saves each food, replacing a saved one with the same name (ignoring case and punctuation). One transaction. */
  upsertMany(telegramId: number, foods: FoodFields[], source: FoodSource): { added: number; replaced: number } {
    const exists = this.db.prepare("SELECT 1 FROM food_library WHERE telegram_id = ? AND normalized_name = ?")
    const upsert = this.db.prepare(`
      INSERT INTO food_library (telegram_id, source, ${FIELD_COLUMNS.join(", ")})
      VALUES (?, ?, ${FIELD_COLUMNS.map(() => "?").join(", ")})
      ON CONFLICT (telegram_id, normalized_name) DO UPDATE SET
        ${FIELD_COLUMNS.filter((c) => c !== "normalized_name").map((c) => `${c} = excluded.${c}`).join(", ")},
        source = excluded.source,
        updated_at = datetime('now')
    `)
    let added = 0
    let replaced = 0
    this.db.transaction(() => {
      for (const food of foods) {
        if (exists.get(telegramId, normalizeFoodName(food.name))) replaced++
        else added++
        upsert.run(telegramId, source, ...fieldValues(food))
      }
    })()
    return { added, replaced }
  }

  update(telegramId: number, id: number, food: FoodFields): "ok" | "not_found" | "name_taken" {
    if (!this.get(telegramId, id)) return "not_found"
    const clash = this.db
      .prepare("SELECT 1 FROM food_library WHERE telegram_id = ? AND normalized_name = ? AND id != ?")
      .get(telegramId, normalizeFoodName(food.name), id)
    if (clash) return "name_taken"
    this.db
      .prepare(
        `UPDATE food_library SET ${FIELD_COLUMNS.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now')
         WHERE telegram_id = ? AND id = ?`
      )
      .run(...fieldValues(food), telegramId, id)
    return "ok"
  }

  /** All or nothing: if any id is not this user's, nothing is deleted. */
  deleteMany(telegramId: number, ids: number[]): number | "not_found" {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return 0
    const placeholders = unique.map(() => "?").join(", ")
    return this.db.transaction((): number | "not_found" => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM food_library WHERE telegram_id = ? AND id IN (${placeholders})`)
        .get(telegramId, ...unique) as { n: number }
      if (row.n !== unique.length) return "not_found"
      this.db.prepare(`DELETE FROM food_library WHERE telegram_id = ? AND id IN (${placeholders})`).run(telegramId, ...unique)
      return unique.length
    })()
  }
}
