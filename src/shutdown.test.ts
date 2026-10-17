// src/shutdown.test.ts
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test"
import { createShutdown } from "./shutdown"

let order: string[]
let logSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  order = []
  logSpy = spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

function deps() {
  return {
    stop: () => {
      order.push("stop")
    },
    analytics: {
      shutdown: async () => {
        await Promise.resolve()
        order.push("analytics flushed")
      },
    },
    exit: (code: number) => {
      order.push(`exit ${code}`)
    },
  }
}

describe("createShutdown", () => {
  test("stops the app, waits for analytics to flush, then exits", async () => {
    const shutdown = createShutdown(deps())

    await shutdown("SIGTERM")

    expect(order).toEqual(["stop", "analytics flushed", "exit 0"])
  })

  test("a second signal while shutting down does nothing", async () => {
    const shutdown = createShutdown(deps())

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")])

    expect(order).toEqual(["stop", "analytics flushed", "exit 0"])
  })
})
