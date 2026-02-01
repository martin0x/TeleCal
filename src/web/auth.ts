// src/web/auth.ts
import { createHmac } from "crypto"

export interface TelegramUser {
  id: number
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export function validateInitData(
  initData: string,
  botToken: string
): TelegramUser | null {
  if (!initData) return null

  try {
    const params = new URLSearchParams(initData)
    const hash = params.get("hash")
    if (!hash) return null

    params.delete("hash")

    // Sort params alphabetically and create data check string
    const sorted = [...params.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )
    const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join("\n")

    // Create secret key: HMAC-SHA256(bot_token, "WebAppData")
    const secretKey = createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest()

    // Create hash: HMAC-SHA256(data_check_string, secret_key)
    const expectedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex")

    if (hash !== expectedHash) {
      return null
    }

    // Optional: Check auth_date is not too old (1 hour)
    const authDate = params.get("auth_date")
    if (authDate) {
      const authTimestamp = parseInt(authDate, 10) * 1000
      const now = Date.now()
      const oneHour = 60 * 60 * 1000
      if (now - authTimestamp > oneHour) {
        return null
      }
    }

    // Parse user data
    const userJson = params.get("user")
    if (!userJson) return null

    const user = JSON.parse(userJson) as TelegramUser
    return user
  } catch {
    return null
  }
}

export function extractAuthHeader(request: Request): string | null {
  const auth = request.headers.get("Authorization")
  if (!auth) return null

  const prefix = "tg-init-data "
  if (!auth.startsWith(prefix)) return null

  return auth.slice(prefix.length)
}
