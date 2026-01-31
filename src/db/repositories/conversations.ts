// src/db/repositories/conversations.ts
import { Database } from "bun:sqlite"

export type ConversationStateType = "awaiting_input" | "clarifying" | "confirming"

export interface ConversationState {
  telegram_id: number
  chat_id: number
  state: ConversationStateType
  pending_food: string | null
  pending_items: string | null
  context: string | null
  target_date: string
  updated_at: string
}

export class ConversationsRepository {
  constructor(private db: Database) {}

  upsert(
    telegramId: number,
    chatId: number,
    state: ConversationStateType,
    targetDate: string,
    data?: {
      pending_food?: string
      pending_items?: string
      context?: string
    }
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO conversation_state (telegram_id, chat_id, state, target_date, pending_food, pending_items, context, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(telegram_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        state = excluded.state,
        target_date = excluded.target_date,
        pending_food = excluded.pending_food,
        pending_items = excluded.pending_items,
        context = excluded.context,
        updated_at = datetime('now')
    `)
    stmt.run(
      telegramId,
      chatId,
      state,
      targetDate,
      data?.pending_food ?? null,
      data?.pending_items ?? null,
      data?.context ?? null
    )
  }

  get(telegramId: number): ConversationState | null {
    const stmt = this.db.prepare(
      "SELECT * FROM conversation_state WHERE telegram_id = ?"
    )
    return stmt.get(telegramId) as ConversationState | null
  }

  delete(telegramId: number): void {
    const stmt = this.db.prepare(
      "DELETE FROM conversation_state WHERE telegram_id = ?"
    )
    stmt.run(telegramId)
  }

  exists(telegramId: number): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM conversation_state WHERE telegram_id = ?"
    )
    return stmt.get(telegramId) !== null
  }

  deleteStale(timeoutMs: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM conversation_state
      WHERE datetime(updated_at) < datetime('now', ? || ' seconds')
    `)
    const result = stmt.run(-Math.floor(timeoutMs / 1000))
    return result.changes
  }
}
