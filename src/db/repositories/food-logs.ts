// src/db/repositories/food-logs.ts
import { Database } from "bun:sqlite"
import { MACROS, type MacroColumn, type Totals } from "../../macros"

/**
 * A logged item. The macro columns (protein_g, …) are whole grams; null means
 * unknown: a row from before that macro existed, or a model miss. Optional on
 * input only; rows read back always carry every column.
 */
export type FoodItem = {
  id?: number
  description: string
  calories: number
  emoji?: string
} & Partial<Record<MacroColumn, number | null>>

export type DayTotals = Totals

type FoodItemRow = { id: number; description: string; calories: number; emoji: string | null } & Record<
  MacroColumn,
  number | null
>

const MACRO_COLUMNS = MACROS.map((m) => m.column)
/** `COALESCE(SUM(fi.protein_g), 0) AS protein, …`, built from registry constants, never from input. */
const MACRO_SUMS = MACROS.map((m) => `COALESCE(SUM(fi.${m.column}), 0) AS ${m.key}`).join(", ")
/** True when any macro on the row is still unknown. */
const ANY_MACRO_MISSING = MACROS.map((m) => `${m.column} IS NULL`).join(" OR ")

export interface FoodLog {
  id: number
  telegram_id: number
  chat_id: number
  logged_at: string
  target_date: string
  items: FoodItem[]
}

export class FoodLogsRepository {
  constructor(private db: Database) {}

  create(
    telegramId: number,
    chatId: number,
    targetDate: string,
    items: FoodItem[]
  ): FoodLog {
    const logStmt = this.db.prepare(`
      INSERT INTO food_logs (telegram_id, chat_id, target_date)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    const logRow = logStmt.get(telegramId, chatId, targetDate) as {
      id: number
      telegram_id: number
      chat_id: number
      logged_at: string
      target_date: string
    }

    const itemStmt = this.db.prepare(`
      INSERT INTO food_items (log_id, description, calories, ${MACRO_COLUMNS.join(", ")}, emoji)
      VALUES (?, ?, ?, ${MACRO_COLUMNS.map(() => "?").join(", ")}, ?)
      RETURNING *
    `)

    const insertedItems: FoodItem[] = items.map((item) => {
      const row = itemStmt.get(
        logRow.id,
        item.description,
        item.calories,
        ...MACRO_COLUMNS.map((column) => item[column] ?? null),
        item.emoji ?? null
      ) as FoodItemRow
      return { ...row, emoji: row.emoji ?? undefined }
    })

    return { ...logRow, items: insertedItems }
  }

  getByDate(telegramId: number, targetDate: string): FoodLog[] {
    const logsStmt = this.db.prepare(`
      SELECT * FROM food_logs
      WHERE telegram_id = ? AND target_date = ?
      ORDER BY logged_at
    `)
    const logs = logsStmt.all(telegramId, targetDate) as {
      id: number
      telegram_id: number
      chat_id: number
      logged_at: string
      target_date: string
    }[]

    const itemsStmt = this.db.prepare(
      "SELECT * FROM food_items WHERE log_id = ?"
    )

    return logs.map((log) => {
      const items = itemsStmt.all(log.id) as FoodItemRow[]
      return {
        ...log,
        items: items.map((i) => ({ ...i, emoji: i.emoji ?? undefined })),
      }
    })
  }

  getTotals(telegramId: number, targetDate: string): DayTotals {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(fi.calories), 0) AS calories, ${MACRO_SUMS}
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ? AND fl.target_date = ?
    `)
    return stmt.get(telegramId, targetDate) as DayTotals
  }

  getDailyTotals(
    telegramId: number,
    startDate: string,
    endDate: string
  ): Record<string, DayTotals> {
    const stmt = this.db.prepare(`
      SELECT fl.target_date, COALESCE(SUM(fi.calories), 0) AS calories, ${MACRO_SUMS}
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ?
        AND fl.target_date >= ?
        AND fl.target_date <= ?
      GROUP BY fl.target_date
    `)
    const rows = stmt.all(telegramId, startDate, endDate) as ({ target_date: string } & DayTotals)[]
    return Object.fromEntries(rows.map(({ target_date, ...totals }) => [target_date, totals as DayTotals]))
  }

  deleteItem(itemId: number): void {
    const stmt = this.db.prepare("DELETE FROM food_items WHERE id = ?")
    stmt.run(itemId)
  }

  deleteAllForDate(telegramId: number, targetDate: string): number {
    const stmt = this.db.prepare(`
      DELETE FROM food_logs
      WHERE telegram_id = ? AND target_date = ?
    `)
    const result = stmt.run(telegramId, targetDate)
    return result.changes
  }

  updateItem(
    itemId: number,
    updates: Partial<{ description: string; calories: number; emoji: string } & Record<MacroColumn, number | null>>
  ): void {
    // Column names come from this list and the registry, never from the keys of `updates`.
    const columnUpdates: { column: "description" | "calories" | "emoji" | MacroColumn; value: string | number | null }[] = []

    if (updates.description !== undefined) {
      columnUpdates.push({ column: "description", value: updates.description })
    }
    if (updates.calories !== undefined) {
      columnUpdates.push({ column: "calories", value: updates.calories })
    }
    for (const column of MACRO_COLUMNS) {
      const value = updates[column]
      if (value !== undefined) columnUpdates.push({ column, value })
    }
    if (updates.emoji !== undefined) {
      columnUpdates.push({ column: "emoji", value: updates.emoji })
    }

    if (columnUpdates.length === 0) return

    const setClause = columnUpdates.map((u) => `${u.column} = ?`).join(", ")
    const values = columnUpdates.map((u) => u.value)

    const stmt = this.db.prepare(`UPDATE food_items SET ${setClause} WHERE id = ?`)
    stmt.run(...values, itemId)
  }

  getItemsByDate(telegramId: number, targetDate: string): (FoodItem & { log_id: number })[] {
    const stmt = this.db.prepare(`
      SELECT fi.*, fl.id as log_id
      FROM food_items fi
      JOIN food_logs fl ON fl.id = fi.log_id
      WHERE fl.telegram_id = ? AND fl.target_date = ?
      ORDER BY fl.logged_at, fi.id
    `)
    return stmt.all(telegramId, targetDate) as (FoodItem & { log_id: number })[]
  }

  getItemForUser(itemId: number, telegramId: number): (FoodItem & { log_id: number }) | null {
    const stmt = this.db.prepare(`
      SELECT fi.*, fl.id as log_id
      FROM food_items fi
      JOIN food_logs fl ON fl.id = fi.log_id
      WHERE fi.id = ? AND fl.telegram_id = ?
    `)
    return (stmt.get(itemId, telegramId) as (FoodItem & { log_id: number }) | null) ?? null
  }

  // --- Macro backfill -------------------------------------------------------

  /** Distinct descriptions of items with any macro still unknown. */
  listDescriptionsMissingMacros(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT description FROM food_items WHERE ${ANY_MACRO_MISSING} ORDER BY description`)
      .all() as { description: string }[]
    return rows.map((r) => r.description)
  }

  countItemsMissingMacros(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM food_items WHERE ${ANY_MACRO_MISSING}`).get() as { n: number }
    return row.n
  }

  /**
   * Fills the still-null cells of every row with this exact description. Exact
   * match on purpose: it is the string the model was asked about. A value
   * already there (from the original estimate or an /edit) is never
   * overwritten. Returns the rows that gained at least one value.
   */
  fillMissingMacros(description: string, values: Partial<Record<MacroColumn, number>>): number {
    const given = MACROS.filter((m) => typeof values[m.column] === "number")
    if (given.length === 0) return 0
    const set = given.map((m) => `${m.column} = COALESCE(${m.column}, ?)`).join(", ")
    const gap = given.map((m) => `${m.column} IS NULL`).join(" OR ")
    const result = this.db
      .prepare(`UPDATE food_items SET ${set} WHERE description = ? AND (${gap})`)
      .run(...given.map((m) => values[m.column] as number), description)
    return result.changes
  }
}
