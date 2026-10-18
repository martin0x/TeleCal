// src/web/test-helpers.ts
// Test-only: signs Telegram Mini App initData the way Telegram does, so tests
// can call the authenticated /api routes.
import { createHmac } from "crypto"

export function createValidInitData(user: object, botToken: string): string {
  const authDate = Math.floor(Date.now() / 1000)
  const params = new URLSearchParams()
  params.set("user", JSON.stringify(user))
  params.set("auth_date", authDate.toString())
  params.set("query_id", "test_query_id")

  // Sort params and create data check string
  const sorted = [...params.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )
  const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join("\n")

  // Create hash
  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest()
  const hash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex")

  params.set("hash", hash)
  return params.toString()
}
