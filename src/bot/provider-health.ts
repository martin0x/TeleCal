// src/bot/provider-health.ts
// Provider health for admins: the /admin providers report, and the alert sent
// when the circuit breaker starts or stops skipping a provider.
import type { Api } from "grammy"
import { COOLDOWN_MS, type CircuitEvent, type CircuitStatus } from "../ai/circuit-breaker"
import { describeFailure } from "../ai/failures"
import { providerLabel } from "../ai/fallback"
import type { ProviderHealthRow } from "../db/repositories/usage"
import { formatDuration } from "../utils/format"

export function formatProviderAlert(event: CircuitEvent): string {
  const label = providerLabel(event.provider)
  if (event.type === "opened") {
    return (
      `⚠️ ${label} is failing (last error: ${describeFailure(event.error)}).\n\n` +
      `Its calls go to the other configured providers, if any, and ${label} gets a test call every ` +
      `${formatDuration(COOLDOWN_MS)}. You'll get another message when it recovers. Details: /admin providers`
    )
  }
  return `✅ ${label} is answering again, after ${formatDuration(event.downForMs)}.`
}

/** One message per admin per change; a failed send is logged, never thrown. */
export function createProviderAlerter(api: Pick<Api, "sendMessage">, adminIds: number[]) {
  return (event: CircuitEvent): void => {
    const text = formatProviderAlert(event)
    for (const adminId of adminIds) {
      api.sendMessage(adminId, text).catch((error) => {
        console.error(`[providers] could not alert admin ${adminId}:`, error)
      })
    }
  }
}

/** /admin providers [1h|24h|7d], in hours. */
export function parseHealthWindow(arg: string | undefined): number {
  switch (arg?.toLowerCase()) {
    case "1h":
      return 1
    case "7d":
      return 24 * 7
    default:
      return 24
  }
}

function windowLabel(hours: number): string {
  if (hours === 1) return "last hour"
  if (hours % 24 === 0 && hours > 24) return `last ${hours / 24} days`
  return `last ${hours} hours`
}

function stateLine(status: CircuitStatus): string {
  switch (status.state) {
    case "open":
      return `⛔ skipped after ${status.consecutiveFailures} failures in a row, next test in ${formatDuration(status.retryInMs ?? 0)}`
    case "half_open":
      return "⏳ skipped; the next call tests it"
    case "closed":
      return status.consecutiveFailures > 0 ? `⚠️ up, last ${status.consecutiveFailures} calls failed` : "✅ up"
  }
}

function at(datetime: string | null): string {
  return datetime ? `${datetime.slice(0, 16)} UTC` : "never"
}

export function formatProviderHealth(
  providers: string[],
  rows: ProviderHealthRow[],
  statusOf: (provider: string) => CircuitStatus,
  hours: number
): string {
  if (providers.length === 0) return "No AI provider configured."

  const sections = providers.map((provider) => {
    const row = rows.find((r) => r.provider === provider)
    const lines = [`${providerLabel(provider)} — ${stateLine(statusOf(provider))}`]
    if (!row || row.calls === 0) {
      lines.push(`No calls in the ${windowLabel(hours)}`)
    } else {
      const rate = Math.round((row.failures / row.calls) * 100)
      const p50 = row.p50LatencyMs === null ? "" : ` · p50 ${(row.p50LatencyMs / 1000).toFixed(1)} s`
      lines.push(`${row.calls} calls · ${row.failures} failed (${rate}%)${p50}`)
    }
    lines.push(`Last success: ${at(row?.lastSuccessAt ?? null)}`)
    const error = row?.lastError ? ` (${row.lastError})` : ""
    lines.push(`Last failure: ${at(row?.lastFailureAt ?? null)}${error}`)
    return lines.join("\n")
  })

  return `🩺 AI providers — ${windowLabel(hours)}\n\n${sections.join("\n\n")}`
}
