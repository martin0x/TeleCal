// src/analytics/test-helpers.ts
import type { Analytics } from "./index"

type Properties = Record<string, unknown>

/** In-memory Analytics for tests: assert on what was captured, by raw Telegram ID. */
export class FakeAnalytics implements Analytics {
  events: { telegramId: number; event: string; properties?: Properties }[] = []
  exceptions: { error: unknown; telegramId?: number; properties?: Properties }[] = []
  shutdowns = 0

  capture(telegramId: number, event: string, properties?: Properties): void {
    this.events.push({ telegramId, event, properties })
  }

  captureException(error: unknown, telegramId?: number, properties?: Properties): void {
    this.exceptions.push({ error, telegramId, properties })
  }

  async shutdown(): Promise<void> {
    this.shutdowns++
  }
}
