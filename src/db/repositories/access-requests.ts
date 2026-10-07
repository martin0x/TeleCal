// src/db/repositories/access-requests.ts
import { Database } from "bun:sqlite"

export type AccessRequestStatus = "pending" | "approved" | "declined"

export interface AccessRequest {
  telegram_id: number
  username: string | null
  first_name: string | null
  status: AccessRequestStatus
  requested_at: string
  decided_at: string | null
  decided_by: number | null
}

/** created = admins should be notified; the other two are not new requests. */
export type RequestResult = "created" | "already_pending" | "declined"

export class AccessRequestsRepository {
  constructor(private db: Database) {}

  find(telegramId: number): AccessRequest | null {
    const stmt = this.db.prepare("SELECT * FROM access_requests WHERE telegram_id = ?")
    return (stmt.get(telegramId) as AccessRequest | null) ?? null
  }

  request(
    telegramId: number,
    username: string | null | undefined,
    firstName: string | null | undefined
  ): RequestResult {
    const existing = this.find(telegramId)
    if (existing?.status === "pending") return "already_pending"
    // Declined is sticky so a declined user can't re-notify admins; /admin add still works.
    if (existing?.status === "declined") return "declined"

    // No row, or approved and since removed from the allowlist: (re)open as pending.
    const stmt = this.db.prepare(`
      INSERT INTO access_requests (telegram_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        status = 'pending',
        requested_at = datetime('now'),
        decided_at = NULL,
        decided_by = NULL
    `)
    stmt.run(telegramId, username ?? null, firstName ?? null)
    return "created"
  }

  /** Acts only on a pending request, so a second admin's tap is a no-op (null). */
  decide(telegramId: number, status: "approved" | "declined", adminId: number): AccessRequest | null {
    const stmt = this.db.prepare(`
      UPDATE access_requests
      SET status = ?, decided_at = datetime('now'), decided_by = ?
      WHERE telegram_id = ? AND status = 'pending'
    `)
    const result = stmt.run(status, adminId, telegramId)
    return result.changes === 0 ? null : this.find(telegramId)
  }

  /**
   * /admin add: force-approves regardless of current status (declined
   * included), so the two paths can't disagree. A no-op if there's no row,
   * and leaves decided_by/decided_at untouched if already approved.
   */
  markApproved(telegramId: number, adminId: number): void {
    const stmt = this.db.prepare(`
      UPDATE access_requests
      SET status = 'approved', decided_at = datetime('now'), decided_by = ?
      WHERE telegram_id = ? AND status != 'approved'
    `)
    stmt.run(adminId, telegramId)
  }

  listPending(limit: number): AccessRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM access_requests
      WHERE status = 'pending'
      ORDER BY requested_at, telegram_id
      LIMIT ?
    `)
    return stmt.all(limit) as AccessRequest[]
  }
}
