// src/analytics/index.test.ts
import { describe, test, expect, beforeEach, spyOn } from "bun:test"
import { createAnalytics, hashTelegramId, type AnalyticsClient, type AnalyticsOptions } from "./index"

// echo -n "123456789" | openssl dgst -sha256 -hmac "test-secret"
const HASHED_123456789 = "c5b9a86c94d274ceb6a5fbae1a1f7d99300bc16f29844d0ae752ef38d0788e47"

const OPTS: AnalyticsOptions = {
  apiKey: "phc_test",
  host: "https://us.i.posthog.com",
  idSecret: "test-secret",
  environment: "production",
}

interface RecordingClient extends AnalyticsClient {
  captured: { distinctId?: string; event: string; properties?: Record<string, unknown> }[]
  exceptions: { error: unknown; distinctId?: string; properties?: Record<string, unknown> }[]
  shutdowns: number
}

function recordingClient(): RecordingClient {
  const client: RecordingClient = {
    captured: [],
    exceptions: [],
    shutdowns: 0,
    capture(msg) {
      client.captured.push(msg)
    },
    captureException(error, distinctId, properties) {
      client.exceptions.push({ error, distinctId, properties })
    },
    async shutdown() {
      client.shutdowns++
    },
  }
  return client
}

function throwingClient(): AnalyticsClient {
  return {
    capture() {
      throw new Error("network down")
    },
    captureException() {
      throw new Error("network down")
    },
    async shutdown() {
      throw new Error("network down")
    },
  }
}

describe("hashTelegramId", () => {
  test("is the hex HMAC-SHA256 of the ID keyed with the secret", () => {
    expect(hashTelegramId(123456789, "test-secret")).toBe(HASHED_123456789)
  })

  test("changes with the secret", () => {
    expect(hashTelegramId(123456789, "other-secret")).not.toBe(HASHED_123456789)
  })
})

describe("createAnalytics", () => {
  let client: RecordingClient
  beforeEach(() => {
    client = recordingClient()
  })

  test("never creates a client without an API key", async () => {
    let created = false
    const analytics = createAnalytics({ ...OPTS, apiKey: "" }, () => {
      created = true
      return client
    })

    analytics.capture(123456789, "something_happened")
    analytics.captureException(new Error("boom"), 123456789)
    await analytics.shutdown()

    expect(created).toBe(false)
  })

  test("refuses to start with an API key but no ID secret", () => {
    expect(() => createAnalytics({ ...OPTS, idSecret: "" }, () => client)).toThrow("POSTHOG_ID_SECRET")
  })

  test("capture sends the hashed ID, never the raw one, and tags the environment", () => {
    const analytics = createAnalytics(OPTS, () => client)

    analytics.capture(123456789, "something_happened", { call_type: "estimate" })

    expect(client.captured).toEqual([
      {
        distinctId: HASHED_123456789,
        event: "something_happened",
        properties: { call_type: "estimate", environment: "production" },
      },
    ])
  })

  test("captureException hashes the ID and tags the environment", () => {
    const analytics = createAnalytics(OPTS, () => client)
    const error = new Error("boom")

    analytics.captureException(error, 123456789, { update_id: 42 })

    expect(client.exceptions).toEqual([
      { error, distinctId: HASHED_123456789, properties: { update_id: 42, environment: "production" } },
    ])
  })

  test("captureException without a user sends no distinct ID", () => {
    const analytics = createAnalytics(OPTS, () => client)

    analytics.captureException(new Error("boom"))

    expect(client.exceptions[0].distinctId).toBeUndefined()
    expect(client.exceptions[0].properties).toEqual({ environment: "production" })
  })

  test("the same error object is reported once, however many catch blocks see it", () => {
    const analytics = createAnalytics(OPTS, () => client)
    const error = new Error("boom")

    analytics.captureException(error, 123456789, { source: "ai" })
    analytics.captureException(error, 123456789, { source: "retry-pending" })

    expect(client.exceptions).toHaveLength(1)
    expect(client.exceptions[0].properties).toMatchObject({ source: "ai" })
  })

  test("shutdown flushes the client", async () => {
    const analytics = createAnalytics(OPTS, () => client)

    await analytics.shutdown()

    expect(client.shutdowns).toBe(1)
  })

  test("a failing client never throws into the caller", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    const analytics = createAnalytics(OPTS, throwingClient)

    expect(() => analytics.capture(123456789, "something_happened")).not.toThrow()
    expect(() => analytics.captureException(new Error("boom"), 123456789)).not.toThrow()
    await expect(analytics.shutdown()).resolves.toBeUndefined()

    expect(errorLog).toHaveBeenCalledTimes(3)
    errorLog.mockRestore()
  })
})
