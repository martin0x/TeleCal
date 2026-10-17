// src/analytics/index.ts
// PostHog wrapper. Callers pass raw Telegram IDs; only their HMAC leaves the
// process. See docs/adr/0001-posthog-integration.md for what may be sent.
import { createHmac } from "node:crypto"
import { PostHog } from "posthog-node"

type Properties = Record<string, unknown>

export interface Analytics {
  capture(telegramId: number, event: string, properties?: Properties): void
  captureException(error: unknown, telegramId?: number, properties?: Properties): void
  /** Flushes queued events. Await it before exit, or batched events are lost. */
  shutdown(): Promise<void>
}

/** The slice of posthog-node this module uses, so tests can stand in for it. */
export interface AnalyticsClient {
  capture(msg: { distinctId?: string; event: string; properties?: Properties }): void
  captureException(error: unknown, distinctId?: string, properties?: Properties): void
  shutdown(shutdownTimeoutMs?: number): Promise<void>
}

export interface AnalyticsOptions {
  apiKey: string
  host: string
  idSecret: string
  environment: string
}

// Railway waits briefly between SIGTERM and SIGKILL; don't spend all of it here.
const SHUTDOWN_TIMEOUT_MS = 5000

export function hashTelegramId(telegramId: number, secret: string): string {
  return createHmac("sha256", secret).update(String(telegramId)).digest("hex")
}

/** For code paths built without analytics, e.g. tests that don't care about it. */
export const noopAnalytics: Analytics = {
  capture() {},
  captureException() {},
  async shutdown() {},
}

function postHogClient(opts: AnalyticsOptions): AnalyticsClient {
  return new PostHog(opts.apiKey, { host: opts.host })
}

/**
 * Does nothing without an API key (tests, local dev). Analytics must never
 * break calorie logging, so every call swallows and logs its own errors.
 */
export function createAnalytics(
  opts: AnalyticsOptions,
  makeClient: (opts: AnalyticsOptions) => AnalyticsClient = postHogClient
): Analytics {
  if (!opts.apiKey) return noopAnalytics
  if (!opts.idSecret) {
    throw new Error("POSTHOG_API_KEY is set but POSTHOG_ID_SECRET is not: refusing to send unhashed Telegram IDs")
  }

  const client = makeClient(opts)
  // An AI failure is caught in AIService, then again by whichever job or flow
  // called it. Report it from the first catch only.
  const reported = new WeakSet<object>()
  const withEnvironment = (properties?: Properties) => ({ ...properties, environment: opts.environment })

  return {
    capture(telegramId, event, properties) {
      try {
        client.capture({
          distinctId: hashTelegramId(telegramId, opts.idSecret),
          event,
          properties: withEnvironment(properties),
        })
      } catch (error) {
        console.error(`[analytics] Failed to capture ${event}:`, error)
      }
    },

    captureException(error, telegramId, properties) {
      if (typeof error === "object" && error !== null) {
        if (reported.has(error)) return
        reported.add(error)
      }
      try {
        const distinctId = telegramId === undefined ? undefined : hashTelegramId(telegramId, opts.idSecret)
        client.captureException(error, distinctId, withEnvironment(properties))
      } catch (captureError) {
        console.error("[analytics] Failed to capture exception:", captureError)
      }
    },

    async shutdown() {
      try {
        await client.shutdown(SHUTDOWN_TIMEOUT_MS)
      } catch (error) {
        console.error("[analytics] Failed to flush on shutdown:", error)
      }
    },
  }
}
