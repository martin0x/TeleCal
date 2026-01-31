// src/db/repositories/food-logs.ts
import { Database } from "bun:sqlite"

export interface FoodItem {
  id?: number
  description: string
  calories: number
  emoji?: string
}

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
      INSERT INTO food_items (log_id, description, calories, emoji)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `)

    const insertedItems: FoodItem[] = items.map((item) => {
      const row = itemStmt.get(
        logRow.id,
        item.description,
        item.calories,
        item.emoji ?? null
      ) as { id: number; description: string; calories: number; emoji: string | null }
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
      const items = itemsStmt.all(log.id) as {
        id: number
        description: string
        calories: number
        emoji: string | null
      }[]
      return {
        ...log,
        items: items.map((i) => ({ ...i, emoji: i.emoji ?? undefined })),
      }
    })
  }

  getTotalCalories(telegramId: number, targetDate: string): number {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(fi.calories), 0) as total
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ? AND fl.target_date = ?
    `)
    const result = stmt.get(telegramId, targetDate) as { total: number }
    return result.total
  }

  getDailyTotals(
    telegramId: number,
    startDate: string,
    endDate: string
  ): Record<string, number> {
    const stmt = this.db.prepare(`
      SELECT fl.target_date, COALESCE(SUM(fi.calories), 0) as total
      FROM food_logs fl
      JOIN food_items fi ON fi.log_id = fl.id
      WHERE fl.telegram_id = ?
        AND fl.target_date >= ?
        AND fl.target_date <= ?
      GROUP BY fl.target_date
    `)
    const rows = stmt.all(telegramId, startDate, endDate) as {
      target_date: string
      total: number
    }[]
    return Object.fromEntries(rows.map((r) => [r.target_date, r.total]))
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
    updates: Partial<{ description: string; calories: number; emoji: string }>
  ): void {
    const sets: string[] = []
    const values: (string | number)[] = []

    if (updates.description !== undefined) {
      sets.push("description = ?")
      values.push(updates.description)
    }
    if (updates.calories !== undefined) {
      sets.push("calories = ?")
      values.push(updates.calories)
    }
    if (updates.emoji !== undefined) {
      sets.push("emoji = ?")
      values.push(updates.emoji)
    }

    if (sets.length === 0) return

    values.push(itemId)
    const sql = `UPDATE food_items SET ${sets.join(", ")} WHERE id = ?`
    this.db.run(sql, ...values)
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
}
