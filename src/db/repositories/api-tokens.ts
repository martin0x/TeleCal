// src/db/repositories/api-tokens.ts
import { Database } from "bun:sqlite"
import { createHash, randomBytes } from "crypto"

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export class ApiTokensRepository {
  constructor(private db: Database) {}

  /** A new token for this user, replacing any earlier one. Returned once: only its hash is kept. */
  issue(telegramId: number): string {
    const token = randomBytes(32).toString("base64url")
    this.db
      .prepare(`
        INSERT INTO api_tokens (telegram_id, token_hash)
        VALUES (?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          token_hash = excluded.token_hash,
          created_at = datetime('now'),
          last_used_at = NULL
      `)
      .run(telegramId, hashToken(token))
    return token
  }

  /** True if the user had a token. */
  revoke(telegramId: number): boolean {
    return this.db.prepare("DELETE FROM api_tokens WHERE telegram_id = ?").run(telegramId).changes > 0
  }

  /** The token's owner, or null for an unknown or revoked token. Marks the token used. */
  findUser(token: string): number | null {
    const row = this.db
      .prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ? RETURNING telegram_id")
      .get(hashToken(token)) as { telegram_id: number } | null
    return row?.telegram_id ?? null
  }
}
