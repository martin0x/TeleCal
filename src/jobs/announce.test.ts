// src/jobs/announce.test.ts
import { describe, test, expect, beforeEach, spyOn } from "bun:test"
import { GrammyError } from "grammy"
import { createTestDb } from "../db/test-helpers"
import { AnnouncementsRepository } from "../db/repositories/announcements"
import { sendAnnouncement } from "./announce"

const KEY = "privacy"
let repo: AnnouncementsRepository
let delivered: number[]
let sleeps: number[]

const sleep = async (ms: number) => {
  sleeps.push(ms)
}

function telegramError(code: number, description: string, parameters = {}) {
  return new GrammyError(`Call to 'sendMessage' failed! (${code}: ${description})`, { ok: false, error_code: code, description, parameters }, "sendMessage", {})
}

beforeEach(() => {
  repo = new AnnouncementsRepository(createTestDb())
  delivered = []
  sleeps = []
})

describe("sendAnnouncement", () => {
  test("sends to every recipient once and records each receipt", async () => {
    const report = await sendAnnouncement(KEY, "hello", [1, 2, 2, 3], {
      announcementsRepo: repo,
      send: async (id) => {
        delivered.push(id)
      },
      sleep,
    })

    expect(delivered).toEqual([1, 2, 3])
    expect(report).toEqual({ sent: 3, alreadyReceived: 0, failed: [] })
    expect(repo.countSent(KEY)).toBe(3)
  })

  test("a second run sends nothing to people who already got it", async () => {
    repo.markSent(KEY, 1)

    const report = await sendAnnouncement(KEY, "hello", [1, 2], {
      announcementsRepo: repo,
      send: async (id) => {
        delivered.push(id)
      },
      sleep,
    })

    expect(delivered).toEqual([2])
    expect(report).toEqual({ sent: 1, alreadyReceived: 1, failed: [] })
  })

  test("a user who blocked the bot is reported, not recorded, and doesn't stop the run", async () => {
    const errorLog = spyOn(console, "error").mockImplementation(() => {})

    const report = await sendAnnouncement(KEY, "hello", [1, 2], {
      announcementsRepo: repo,
      send: async (id) => {
        if (id === 1) throw telegramError(403, "Forbidden: bot was blocked by the user")
        delivered.push(id)
      },
      sleep,
    })

    expect(delivered).toEqual([2])
    expect(report.sent).toBe(1)
    expect(report.failed).toEqual([{ telegramId: 1, reason: "Forbidden: bot was blocked by the user" }])
    expect(repo.hasReceived(KEY, 1)).toBe(false)
    errorLog.mockRestore()
  })

  test("waits out Telegram's rate limit and retries once", async () => {
    let attempts = 0

    const report = await sendAnnouncement(KEY, "hello", [1], {
      announcementsRepo: repo,
      send: async (id) => {
        attempts++
        if (attempts === 1) throw telegramError(429, "Too Many Requests: retry after 3", { retry_after: 3 })
        delivered.push(id)
      },
      sleep,
    })

    expect(delivered).toEqual([1])
    expect(report.sent).toBe(1)
    expect(sleeps).toContain(3000)
  })

  test("paces sends to stay under Telegram's broadcast limit", async () => {
    await sendAnnouncement(KEY, "hello", [1, 2, 3], {
      announcementsRepo: repo,
      send: async () => {},
      sleep,
    })

    expect(sleeps.length).toBeGreaterThanOrEqual(2)
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(40) // at most ~25 messages a second
  })
})
