// src/db/repositories/users.ts
import { Database } from "bun:sqlite"

export interface User {
  telegram_id: number
  username: string | null
  ai_provider: string
  daily_goal: number | null
  daily_protein_goal: number | null
  reminder_time: string | null
  reminder_mention: boolean
  timezone: string
  created_at: string
}

interface UserRow {
  telegram_id: number
  username: string | null
  ai_provider: string
  daily_goal: number | null
  daily_protein_goal: number | null
  reminder_time: string | null
  reminder_mention: number
  timezone: string
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
      daily_protein_goal: number | null
      reminder_time: string | null
      reminder_mention: boolean
      timezone: string
    }>
  ): void {
    // Explicit allowlist - TypeScript enforces only these columns can be used
    const allowedColumns = [
      "ai_provider",
      "daily_goal",
      "daily_protein_goal",
      "reminder_time",
      "reminder_mention",
      "timezone",
    ] as const
    type AllowedColumn = (typeof allowedColumns)[number]

    const columnUpdates: {
      column: AllowedColumn
      value: string | number | null
    }[] = []

    if (settings.ai_provider !== undefined) {
      columnUpdates.push({ column: "ai_provider", value: settings.ai_provider })
    }
    if (settings.daily_goal !== undefined) {
      columnUpdates.push({ column: "daily_goal", value: settings.daily_goal })
    }
    if (settings.daily_protein_goal !== undefined) {
      columnUpdates.push({ column: "daily_protein_goal", value: settings.daily_protein_goal })
    }
    if (settings.reminder_time !== undefined) {
      columnUpdates.push({
        column: "reminder_time",
        value: settings.reminder_time,
      })
    }
    if (settings.reminder_mention !== undefined) {
      columnUpdates.push({
        column: "reminder_mention",
        value: settings.reminder_mention ? 1 : 0,
      })
    }
    if (settings.timezone !== undefined) {
      columnUpdates.push({ column: "timezone", value: settings.timezone })
    }

    if (columnUpdates.length === 0) return

    // TypeScript guarantees column names are from the literal union
    const setClause = columnUpdates.map((u) => `${u.column} = ?`).join(", ")
    const values = columnUpdates.map((u) => u.value)

    const stmt = this.db.prepare(
      `UPDATE users SET ${setClause} WHERE telegram_id = ?`
    )
    stmt.run(...values, telegramId)
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
