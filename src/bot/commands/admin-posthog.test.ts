// src/bot/commands/admin-posthog.test.ts
import { describe, test, expect } from "bun:test"
import { posthogIdReply } from "./admin"

// echo -n "123456789" | openssl dgst -sha256 -hmac "test-secret"
const HASHED_123456789 = "c5b9a86c94d274ceb6a5fbae1a1f7d99300bc16f29844d0ae752ef38d0788e47"

describe("posthogIdReply", () => {
  test("replies with the user's PostHog distinct ID", () => {
    expect(posthogIdReply("123456789", "test-secret")).toContain(HASHED_123456789)
  })

  test("asks for a numeric ID when it's missing or not a number", () => {
    expect(posthogIdReply(undefined, "test-secret")).toBe("Usage: /admin posthog-id <telegram_user_id>")
    expect(posthogIdReply("ray", "test-secret")).toBe("Usage: /admin posthog-id <telegram_user_id>")
  })

  test("says so when PostHog isn't configured", () => {
    expect(posthogIdReply("123456789", "")).toBe("PostHog isn't configured: POSTHOG_ID_SECRET is unset.")
  })
})
