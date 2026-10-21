// src/ai/circuit-breaker.ts

export const FAILURE_THRESHOLD = 3
export const COOLDOWN_MS = 5 * 60_000

export type CircuitState = "closed" | "open" | "half_open"

export type CircuitEvent =
  | { type: "opened"; provider: string; error: unknown }
  | { type: "closed"; provider: string; downForMs: number }

export interface CircuitStatus {
  state: CircuitState
  consecutiveFailures: number
  /** While open: how long until the next trial call is let through. */
  retryInMs: number | null
}

interface Circuit {
  failures: number
  /** When the cooldown started; restarts on each failed trial. null while closed. */
  openedAt: number | null
  /** When the outage started, for the recovery alert. */
  downSince: number | null
  trialInFlight: boolean
}

export interface CircuitBreakerOptions {
  threshold?: number
  cooldownMs?: number
  now?: () => number
  /** Called once when a provider is first skipped, and once when it recovers. */
  onChange?: (event: CircuitEvent) => void
}

/**
 * Skips a provider after repeated outage-type failures, so calls during an
 * outage don't each wait out its timeout. After a cooldown one trial call goes
 * through: success closes the circuit, failure starts another cooldown.
 * In memory: a restart closes every circuit.
 */
export class CircuitBreaker {
  private circuits = new Map<string, Circuit>()
  private threshold: number
  private cooldownMs: number
  private now: () => number

  constructor(private opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.threshold ?? FAILURE_THRESHOLD
    this.cooldownMs = opts.cooldownMs ?? COOLDOWN_MS
    this.now = opts.now ?? Date.now
  }

  /** Whether a call may go to this provider now. Once a cooldown ends, one trial call at a time. */
  tryAcquire(provider: string): boolean {
    const c = this.circuit(provider)
    if (c.openedAt === null) return true
    if (c.trialInFlight || this.now() - c.openedAt < this.cooldownMs) return false
    c.trialInFlight = true
    return true
  }

  recordSuccess(provider: string): void {
    const c = this.circuit(provider)
    const downSince = c.downSince
    c.failures = 0
    c.openedAt = null
    c.downSince = null
    c.trialInFlight = false
    if (downSince !== null) this.emit({ type: "closed", provider, downForMs: this.now() - downSince })
  }

  /** An outage-type failure; see classifyFailure. */
  recordFailure(provider: string, error: unknown): void {
    const c = this.circuit(provider)
    c.failures++
    c.trialInFlight = false
    if (c.openedAt !== null) {
      c.openedAt = this.now()
      return
    }
    if (c.failures >= this.threshold) {
      c.openedAt = this.now()
      c.downSince = c.openedAt
      this.emit({ type: "opened", provider, error })
    }
  }

  /** The call ended in a way that says nothing about an outage (a parse or config error). */
  release(provider: string): void {
    this.circuit(provider).trialInFlight = false
  }

  status(provider: string): CircuitStatus {
    const c = this.circuit(provider)
    if (c.openedAt === null) return { state: "closed", consecutiveFailures: c.failures, retryInMs: null }
    const retryInMs = Math.max(0, c.openedAt + this.cooldownMs - this.now())
    return {
      state: retryInMs === 0 ? "half_open" : "open",
      consecutiveFailures: c.failures,
      retryInMs,
    }
  }

  private circuit(provider: string): Circuit {
    let c = this.circuits.get(provider)
    if (!c) {
      c = { failures: 0, openedAt: null, downSince: null, trialInFlight: false }
      this.circuits.set(provider, c)
    }
    return c
  }

  private emit(event: CircuitEvent): void {
    try {
      this.opts.onChange?.(event)
    } catch (error) {
      console.error("[circuit] onChange failed:", error)
    }
  }
}
