// src/config.test.ts
import { describe, test, expect, beforeEach } from "bun:test"

describe("config", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token"
    process.env.ADMIN_USERS = "123,456"
    process.env.PORT = "3000"
  })

  test("loads telegram bot token", async () => {
    const { config } = await import("./config")
    expect(config.telegram.botToken).toBe("test-token")
  })

  test("parses admin users as array of numbers", async () => {
    const { config } = await import("./config")
    expect(config.adminUsers).toEqual([123, 456])
  })

  test("loads feature flags with defaults", async () => {
    const { config } = await import("./config")
    expect(config.features.caching).toBe(true)
  })
})

describe("baseUrlFrom", () => {
  test("strips trailing slashes", async () => {
    const { baseUrlFrom } = await import("./config")
    expect(baseUrlFrom("https://telecal.example/")).toBe("https://telecal.example")
    expect(baseUrlFrom("https://telecal.example//")).toBe("https://telecal.example")
  })

  test("leaves a clean URL alone", async () => {
    const { baseUrlFrom } = await import("./config")
    expect(baseUrlFrom("https://telecal.example")).toBe("https://telecal.example")
  })

  test("miniAppUrl is the base URL plus /app", async () => {
    const { config, baseUrlFrom } = await import("./config")
    expect(config.web.miniAppUrl).toBe(baseUrlFrom(config.web.appUrl) + "/app")
  })
})
