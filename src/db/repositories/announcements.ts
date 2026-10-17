// src/db/repositories/announcements.ts
import { Database } from "bun:sqlite"

export class AnnouncementsRepository {
  constructor(private db: Database) {}

  hasReceived(announcement: string, telegramId: number): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM announcements_sent WHERE announcement = ? AND telegram_id = ?")
    return stmt.get(announcement, telegramId) !== null
  }

  markSent(announcement: string, telegramId: number): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO announcements_sent (announcement, telegram_id) VALUES (?, ?)")
    stmt.run(announcement, telegramId)
  }

  countSent(announcement: string): number {
    const stmt = this.db.prepare("SELECT COUNT(*) AS n FROM announcements_sent WHERE announcement = ?")
    return (stmt.get(announcement) as { n: number }).n
  }
}
