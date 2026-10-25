// src/db/repositories/group-badges.ts
import { Database } from "bun:sqlite"

export class GroupBadgesRepository {
  constructor(private db: Database) {}

  get(chatId: number, telegramId: number): string | null {
    const stmt = this.db.prepare("SELECT emoji FROM group_badges WHERE chat_id = ? AND telegram_id = ?")
    return (stmt.get(chatId, telegramId) as { emoji: string } | null)?.emoji ?? null
  }

  /** False, changing nothing, when another member of the chat already has the emoji. */
  set(chatId: number, telegramId: number, emoji: string): boolean {
    const holder = this.db
      .prepare("SELECT telegram_id FROM group_badges WHERE chat_id = ? AND emoji = ?")
      .get(chatId, emoji) as { telegram_id: number } | null
    if (holder && holder.telegram_id !== telegramId) return false

    this.db
      .prepare(`
        INSERT INTO group_badges (chat_id, telegram_id, emoji, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(chat_id, telegram_id) DO UPDATE SET
          emoji = excluded.emoji,
          updated_at = datetime('now')
      `)
      .run(chatId, telegramId, emoji)
    return true
  }

  clear(chatId: number, telegramId: number): void {
    this.db.prepare("DELETE FROM group_badges WHERE chat_id = ? AND telegram_id = ?").run(chatId, telegramId)
  }
}
