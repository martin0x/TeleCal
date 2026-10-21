// src/bot/provider-health.test.ts
import { describe, test, expect, mock, spyOn } from "bun:test"
import OpenAI from "openai"
import type { CircuitStatus } from "../ai/circuit-breaker"
import type { ProviderHealthRow } from "../db/repositories/usage"
import {
  createProviderAlerter,
  formatProviderAlert,
  formatProviderHealth,
  parseHealthWindow,
} from "./provider-health"

const UP: CircuitStatus = { state: "closed", consecutiveFailures: 0, retryInMs: null }

function row(over: Partial<ProviderHealthRow>): ProviderHealthRow {
  return {
    provider: "openai",
    calls: 50,
    failures: 1,
    p50LatencyMs: 1840,
    lastSuccessAt: "2026-10-21 10:02:33",
    lastFailureAt: "2026-10-21 09:40:12",
    lastError: "HTTP 429",
    ...over,
  }
}

describe("formatProviderAlert", () => {
  test("an opened circuit names the provider, the error and what happens next", () => {
    const error = OpenAI.APIError.generate(429, undefined, "rate limited", new Headers())
    const text = formatProviderAlert({ type: "opened", provider: "openai", error })

    expect(text).toStartWith("⚠️ OpenAI is failing (last error: HTTP 429).")
    expect(text).toContain("other configured providers")
    expect(text).toContain("every 5 min")
    expect(text).toContain("/admin providers")
  })

  test("a closed circuit says how long it was down", () => {
    expect(formatProviderAlert({ type: "closed", provider: "anthropic", downForMs: 12 * 60_000 })).toBe(
      "✅ Anthropic is answering again, after 12 min."
    )
  })
})

describe("createProviderAlerter", () => {
  test("messages every admin, and a failed send doesn't stop the rest", async () => {
    const sendMessage = mock((id: number) => (id === 1 ? Promise.reject(new Error("blocked")) : Promise.resolve()))
    const logged = spyOn(console, "error").mockImplementation(() => {})

    createProviderAlerter({ sendMessage } as any, [1, 2])({ type: "closed", provider: "gemini", downForMs: 0 })
    await Promise.resolve()

    expect(sendMessage.mock.calls.map((c) => c[0])).toEqual([1, 2])
    await new Promise((r) => setTimeout(r, 0))
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe("parseHealthWindow", () => {
  test("defaults to 24 hours, and accepts 1h and 7d", () => {
    expect(parseHealthWindow(undefined)).toBe(24)
    expect(parseHealthWindow("1h")).toBe(1)
    expect(parseHealthWindow("7D")).toBe(168)
    expect(parseHealthWindow("banana")).toBe(24)
  })
})

describe("formatProviderHealth", () => {
  test("one section per configured provider with its numbers", () => {
    const text = formatProviderHealth(["openai"], [row({})], () => UP, 24)

    expect(text).toBe(
      "🩺 AI providers — last 24 hours\n\n" +
        "OpenAI — ✅ up\n" +
        "50 calls · 1 failed (2%) · p50 1.8 s\n" +
        "Last success: 2026-10-21 10:02 UTC\n" +
        "Last failure: 2026-10-21 09:40 UTC (HTTP 429)"
    )
  })

  test("a skipped provider shows its failures and when it's next tested", () => {
    const status: CircuitStatus = { state: "open", consecutiveFailures: 3, retryInMs: 3 * 60_000 }
    const text = formatProviderHealth(["anthropic"], [row({ provider: "anthropic" })], () => status, 24)

    expect(text).toContain("Anthropic — ⛔ skipped after 3 failures in a row, next test in 3 min")
  })

  test("recent failures short of the threshold are flagged", () => {
    const status: CircuitStatus = { state: "closed", consecutiveFailures: 2, retryInMs: null }
    expect(formatProviderHealth(["openai"], [row({})], () => status, 24)).toContain("⚠️ up, last 2 calls failed")
  })

  test("a provider with no calls says so", () => {
    const text = formatProviderHealth(["gemini"], [], () => UP, 1)

    expect(text).toBe(
      "🩺 AI providers — last hour\n\n" +
        "Gemini — ✅ up\n" +
        "No calls in the last hour\n" +
        "Last success: never\n" +
        "Last failure: never"
    )
  })

  test("providers that aren't configured are left out", () => {
    const text = formatProviderHealth(["openai"], [row({}), row({ provider: "gemini" })], () => UP, 168)

    expect(text).toStartWith("🩺 AI providers — last 7 days")
    expect(text).not.toContain("Gemini")
  })

  test("no providers configured", () => {
    expect(formatProviderHealth([], [], () => UP, 24)).toBe("No AI provider configured.")
  })
})
