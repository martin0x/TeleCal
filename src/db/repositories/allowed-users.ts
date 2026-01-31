// src/db/repositories/allowed-users.ts
import { Database } from "bun:sqlite"

export interface AllowedUser {
  telegram_id: number
  added_by: number | null
  added_at: string
}

export class AllowedUsersRepository {
  constructor(private db: Database) {}

  add(telegramId: number, addedBy: number): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO allowed_users (telegram_id, added_by)
      VALUES (?, ?)
    `)
    stmt.run(telegramId, addedBy)
  }

  remove(telegramId: number): void {
    const stmt = this.db.prepare("DELETE FROM allowed_users WHERE telegram_id = ?")
    stmt.run(telegramId)
  }

  isAllowed(telegramId: number): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM allowed_users WHERE telegram_id = ?"
    )
    return stmt.get(telegramId) !== null
  }

  listAll(): AllowedUser[] {
    const stmt = this.db.prepare("SELECT * FROM allowed_users ORDER BY added_at")
    return stmt.all() as AllowedUser[]
  }
}
