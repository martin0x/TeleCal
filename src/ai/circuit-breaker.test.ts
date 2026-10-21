// src/ai/circuit-breaker.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { CircuitBreaker, type CircuitEvent } from "./circuit-breaker"

let clock: number
let events: CircuitEvent[]
let breaker: CircuitBreaker

beforeEach(() => {
  clock = 1_000_000
  events = []
  breaker = new CircuitBreaker({
    threshold: 3,
    cooldownMs: 60_000,
    now: () => clock,
    onChange: (e) => events.push(e),
  })
})

function fail(times: number, provider = "openai") {
  for (let i = 0; i < times; i++) breaker.recordFailure(provider, new Error(`fail ${i}`))
}

describe("CircuitBreaker", () => {
  test("lets calls through until the threshold of failures in a row", () => {
    fail(2)
    expect(breaker.tryAcquire("openai")).toBe(true)
    expect(breaker.status("openai")).toEqual({ state: "closed", consecutiveFailures: 2, retryInMs: null })
    expect(events).toHaveLength(0)
  })

  test("a success resets the count", () => {
    fail(2)
    breaker.recordSuccess("openai")
    fail(2)
    expect(breaker.tryAcquire("openai")).toBe(true)
  })

  test("opens at the threshold, alerting once with the last error", () => {
    fail(3)
    expect(breaker.tryAcquire("openai")).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "opened", provider: "openai" })
    expect((events[0] as { error: Error }).error.message).toBe("fail 2")
    expect(breaker.status("openai")).toEqual({ state: "open", consecutiveFailures: 3, retryInMs: 60_000 })
  })

  test("circuits are per provider", () => {
    fail(3)
    expect(breaker.tryAcquire("gemini")).toBe(true)
  })

  test("after the cooldown, lets exactly one trial call through", () => {
    fail(3)
    clock += 60_000
    expect(breaker.status("openai").state).toBe("half_open")
    expect(breaker.tryAcquire("openai")).toBe(true)
    expect(breaker.tryAcquire("openai")).toBe(false)
  })

  test("a failed trial starts another cooldown without another alert", () => {
    fail(3)
    clock += 60_000
    breaker.tryAcquire("openai")
    fail(1)
    expect(breaker.tryAcquire("openai")).toBe(false)
    expect(breaker.status("openai").retryInMs).toBe(60_000)
    expect(events).toHaveLength(1)
  })

  test("a successful trial closes the circuit and reports how long it was down", () => {
    fail(3)
    clock += 60_000
    breaker.tryAcquire("openai")
    fail(1)
    clock += 60_000
    breaker.tryAcquire("openai")
    breaker.recordSuccess("openai")

    expect(breaker.tryAcquire("openai")).toBe(true)
    expect(events[1]).toEqual({ type: "closed", provider: "openai", downForMs: 120_000 })
  })

  test("a success with the circuit closed sends no alert", () => {
    fail(1)
    breaker.recordSuccess("openai")
    expect(events).toHaveLength(0)
  })

  test("release frees the trial slot without closing the circuit", () => {
    fail(3)
    clock += 60_000
    breaker.tryAcquire("openai")
    breaker.release("openai")
    expect(breaker.status("openai").state).toBe("half_open")
    expect(breaker.tryAcquire("openai")).toBe(true)
  })

  test("a throwing listener doesn't break the caller", () => {
    const b = new CircuitBreaker({
      threshold: 1,
      onChange: () => {
        throw new Error("listener")
      },
    })
    expect(() => b.recordFailure("openai", new Error("x"))).not.toThrow()
  })
})
