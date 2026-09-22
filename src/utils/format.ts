// src/utils/format.ts

/**
 * A single AI call costs roughly $0.0002, so two-decimal formatting would
 * render a light month as "$0.00" — which reads as broken rather than cheap.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.00"
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 100_000) return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString("en-US")
}
