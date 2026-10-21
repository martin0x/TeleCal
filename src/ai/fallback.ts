// src/ai/fallback.ts
import type { FailureKind } from "./failures"

/** Set on an estimate that came from another provider than the user's. */
export interface ProviderFallback {
  /** The provider that failed or was skipped. */
  from: string
  /** The provider that answered. */
  to: string
  reason: FailureKind
}

const LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
}

export function providerLabel(name: string): string {
  return LABELS[name] ?? name
}

/** One line telling the user who answered instead, and why. */
export function fallbackNotice(fallback: ProviderFallback): string {
  const why = fallback.reason === "busy" ? "is busy right now" : "isn't responding right now"
  return `ℹ️ ${providerLabel(fallback.from)} ${why}, so ${providerLabel(fallback.to)} answered instead.`
}
