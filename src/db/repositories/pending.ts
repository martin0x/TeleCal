// src/db/repositories/pending.ts
import { Database } from "bun:sqlite"

export interface PendingEntry {
  id: number
  telegram_id: number
  chat_id: number
  food_text: string
  submitted_at: string
  target_date: string
  retry_count: number
  last_retry_at: string | null
}

export class PendingRepository {
  constructor(private db: Database) {}

  create(
    telegramId: number,
    chatId: number,
    foodText: string,
    targetDate: string
  ): PendingEntry {
    const stmt = this.db.prepare(`
      INSERT INTO pending_entries (telegram_id, chat_id, food_text, target_date)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `)
    return stmt.get(telegramId, chatId, foodText, targetDate) as PendingEntry
  }

  getByUser(telegramId: number): PendingEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_entries
      WHERE telegram_id = ?
      ORDER BY submitted_at
    `)
    return stmt.all(telegramId) as PendingEntry[]
  }

  getForRetry(limit: number): PendingEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_entries
      WHERE retry_count < 10
      ORDER BY submitted_at
      LIMIT ?
    `)
    return stmt.all(limit) as PendingEntry[]
  }

  incrementRetry(id: number): void {
    const stmt = this.db.prepare(`
      UPDATE pending_entries
      SET retry_count = retry_count + 1, last_retry_at = datetime('now')
      WHERE id = ?
    `)
    stmt.run(id)
  }

  delete(id: number): void {
    const stmt = this.db.prepare("DELETE FROM pending_entries WHERE id = ?")
    stmt.run(id)
  }

  deleteAllForUser(telegramId: number): number {
    const stmt = this.db.prepare(
      "DELETE FROM pending_entries WHERE telegram_id = ?"
    )
    const result = stmt.run(telegramId)
    return result.changes
  }
}
