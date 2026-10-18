// src/analytics/content-preference.test.ts
import { describe, test, expect, beforeEach, spyOn } from "bun:test"
import { FakeAnalytics } from "./test-helpers"
import { withContentPreference } from "./content-preference"

const OPTED_IN = 1
const OPTED_OUT = 2

const generation = {
  $ai_provider: "gemini",
  $ai_model: "gemini-2.5-flash",
  $ai_input_tokens: 120,
  $ai_output_tokens: 40,
  $ai_latency: 0.8,
  $ai_total_cost_usd: 0.0001,
  $ai_input: [{ role: "user", content: "2 eggs and adobo" }],
  $ai_output_choices: [{ role: "assistant", content: '{"items":[{"description":"adobo"}]}' }],
  $ai_error: 'JSON Parse error: Unexpected identifier "adobo"',
  $ai_is_error: true,
  call_type: "estimate",
}

let inner: FakeAnalytics
let analytics: ReturnType<typeof withContentPreference>

beforeEach(() => {
  inner = new FakeAnalytics()
  analytics = withContentPreference(inner, (telegramId) => telegramId !== OPTED_OUT)
})

describe("capture", () => {
  test("passes events through untouched for a user who allows meal text", () => {
    analytics.capture(OPTED_IN, "$ai_generation", generation)
    expect(inner.events).toEqual([{ telegramId: OPTED_IN, event: "$ai_generation", properties: generation }])
  })

  test("drops prompt, reply and error text for a user who opted out, keeping the numbers", () => {
    analytics.capture(OPTED_OUT, "$ai_generation", generation)

    const { $ai_input, $ai_output_choices, $ai_error, ...rest } = generation
    expect(inner.events).toEqual([{ telegramId: OPTED_OUT, event: "$ai_generation", properties: rest }])
  })

  test("leaves events without meal text alone", () => {
    analytics.capture(OPTED_OUT, "access_requested", { source: "landing" })
    expect(inner.events).toEqual([{ telegramId: OPTED_OUT, event: "access_requested", properties: { source: "landing" } }])
  })
})

describe("captureException", () => {
  const failure = () => {
    const error = new SyntaxError('JSON Parse error: Unexpected identifier "adobo"')
    error.stack = 'SyntaxError: JSON Parse error: Unexpected identifier "adobo"\n    at parse (src/ai/providers/gemini.ts:40:12)\n    at estimate (src/ai/service.ts:120:5)'
    return error
  }

  test("reports the error as is for a user who allows meal text", () => {
    const error = failure()
    analytics.captureException(error, OPTED_IN, { source: "ai" })
    expect(inner.exceptions).toEqual([{ error, telegramId: OPTED_IN, properties: { source: "ai" } }])
  })

  test("keeps the type and stack frames but not the message for a user who opted out", () => {
    analytics.captureException(failure(), OPTED_OUT, { source: "ai" })

    const [{ error, telegramId, properties }] = inner.exceptions
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe("SyntaxError")
    expect((error as Error).message).toBe("[redacted]")
    expect((error as Error).stack).toBe(
      "SyntaxError: [redacted]\n    at parse (src/ai/providers/gemini.ts:40:12)\n    at estimate (src/ai/service.ts:120:5)"
    )
    expect(telegramId).toBe(OPTED_OUT)
    expect(properties).toEqual({ source: "ai" })
  })

  test("hands the same redacted copy on for the same error, so it is still reported once", () => {
    const error = failure()
    analytics.captureException(error, OPTED_OUT)
    analytics.captureException(error, OPTED_OUT)
    expect(inner.exceptions[0].error).toBe(inner.exceptions[1].error)
  })

  test("redacts a thrown non-Error too", () => {
    analytics.captureException("adobo went wrong", OPTED_OUT)
    expect((inner.exceptions[0].error as Error).message).toBe("[redacted]")
  })

  test("errors with no user are not redacted: there is no preference to apply", () => {
    const error = failure()
    analytics.captureException(error, undefined, { source: "uncaughtException" })
    expect(inner.exceptions[0].error).toBe(error)
  })
})

test("a preference lookup that throws counts as opted out, and doesn't throw", () => {
  const logged = spyOn(console, "error").mockImplementation(() => {})
  const broken = withContentPreference(inner, () => {
    throw new Error("database is locked")
  })

  expect(() => broken.capture(OPTED_IN, "$ai_generation", generation)).not.toThrow()
  expect(inner.events[0].properties).not.toHaveProperty("$ai_input")
  expect(logged).toHaveBeenCalled()
  logged.mockRestore()
})

test("shutdown flushes the wrapped analytics", async () => {
  await analytics.shutdown()
  expect(inner.shutdowns).toBe(1)
})
