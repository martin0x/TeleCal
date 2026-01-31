// src/db/repositories/users.ts
import { Database } from "bun:sqlite"

export interface User {
  telegram_id: number
  username: string | null
  ai_provider: string
  daily_goal: number | null
  reminder_time: string | null
  reminder_mention: boolean
  created_at: string
}

interface UserRow {
  telegram_id: number
  username: string | null
  ai_provider: string
  daily_goal: number | null
  reminder_time: string | null
  reminder_mention: number
  created_at: string
}

export class UsersRepository {
  constructor(private db: Database) {}

  upsert(telegramId: number, username?: string): User {
    const stmt = this.db.prepare(`
      INSERT INTO users (telegram_id, username)
      VALUES (?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username)
      RETURNING *
    `)
    const row = stmt.get(telegramId, username ?? null) as UserRow
    return this.rowToUser(row)
  }

  findById(telegramId: number): User | null {
    const stmt = this.db.prepare("SELECT * FROM users WHERE telegram_id = ?")
    const row = stmt.get(telegramId) as UserRow | null
    return row ? this.rowToUser(row) : null
  }

  updateSettings(
    telegramId: number,
    settings: Partial<{
      ai_provider: string
      daily_goal: number | null
      reminder_time: string | null
      reminder_mention: boolean
    }>
  ): void {
    const updates: string[] = []
    const values: (string | number | null)[] = []

    if (settings.ai_provider !== undefined) {
      updates.push("ai_provider = ?")
      values.push(settings.ai_provider)
    }
    if (settings.daily_goal !== undefined) {
      updates.push("daily_goal = ?")
      values.push(settings.daily_goal)
    }
    if (settings.reminder_time !== undefined) {
      updates.push("reminder_time = ?")
      values.push(settings.reminder_time)
    }
    if (settings.reminder_mention !== undefined) {
      updates.push("reminder_mention = ?")
      values.push(settings.reminder_mention ? 1 : 0)
    }

    if (updates.length === 0) return

    values.push(telegramId)
    const sql = `UPDATE users SET ${updates.join(", ")} WHERE telegram_id = ?`
    this.db.run(sql, ...values)
  }

  getUsersWithReminders(): User[] {
    const stmt = this.db.prepare(
      "SELECT * FROM users WHERE reminder_time IS NOT NULL"
    )
    const rows = stmt.all() as UserRow[]
    return rows.map((row) => this.rowToUser(row))
  }

  private rowToUser(row: UserRow): User {
    return {
      ...row,
      reminder_mention: row.reminder_mention === 1,
    }
  }
}
