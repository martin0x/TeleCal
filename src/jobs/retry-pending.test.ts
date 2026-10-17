// src/jobs/retry-pending.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../db/test-helpers"
import { PendingRepository } from "../db/repositories/pending"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { createRetryPendingJob } from "./retry-pending"
import type { AIService } from "../ai/service"
import { FakeAnalytics } from "../analytics/test-helpers"

let db: Database

beforeEach(() => {
  db = createTestDb()
})

test("passes retry call type and the entry's user and chat to the AI service", async () => {
  const pendingRepo = new PendingRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(42, "ray")
  pendingRepo.create(42, -100, "chicken adobo", "2026-09-21")

  const estimate = mock(() =>
    Promise.resolve({
      items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high" as const,
    })
  )
  const bot = { api: { sendMessage: mock(() => Promise.resolve()) } }

  // createRetryPendingJob returns the single-pass async function that the
  // interval in startRetryPendingJob calls. Invoke it directly — never test
  // by waiting on a timer.
  const job = createRetryPendingJob(
    bot as any,
    pendingRepo,
    foodLogsRepo,
    usersRepo,
    { estimate } as unknown as AIService
  )
  await job()

  expect(estimate).toHaveBeenCalledWith(
    "chicken adobo",
    expect.any(String),
    expect.objectContaining({ telegramId: 42, chatId: -100, callType: "retry" })
  )
})

test("announces a processed entry as an HTML summary", async () => {
  const pendingRepo = new PendingRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(42, "ray")
  pendingRepo.create(42, -100, "chicken adobo", "2026-09-21")

  const estimate = mock(() =>
    Promise.resolve({
      items: [{ description: "Chicken adobo", calories: 420, protein_g: 38, emoji: "🍗" }],
      needsClarification: false,
      confidence: "high" as const,
    })
  )
  const bot = { api: { sendMessage: mock(() => Promise.resolve()) } }

  const job = createRetryPendingJob(
    bot as any,
    pendingRepo,
    foodLogsRepo,
    usersRepo,
    { estimate } as unknown as AIService
  )
  await job()

  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    42,
    "✅ Processed your saved entry — logged to Mon, Sep 21:\n\n" +
      "<blockquote>🍗 Chicken adobo — 420 cal · 38 g</blockquote>\n\n<b>Total: 420 cal · 38 g protein</b>",
    { parse_mode: "HTML" }
  )
})

test("tells the user when an entry is given up on", async () => {
  // getForRetry never returns an entry at the limit, so feed one in directly.
  const entry = { id: 7, telegram_id: 42, chat_id: -100, food_text: "mystery stew", target_date: "2026-09-21", retry_count: 10 }
  const pendingRepo = { getForRetry: () => [entry], delete: mock(() => {}) }
  const bot = { api: { sendMessage: mock(() => Promise.resolve()) } }

  const job = createRetryPendingJob(
    bot as any,
    pendingRepo as unknown as PendingRepository,
    new FoodLogsRepository(db),
    new UsersRepository(db),
    {} as AIService
  )
  await job()

  expect(pendingRepo.delete).toHaveBeenCalledWith(7)
  expect(bot.api.sendMessage).toHaveBeenCalledWith(
    42,
    '❌ Couldn\'t process your entry "mystery stew" after multiple attempts.\n\n' +
      "Your AI provider may be unavailable — try switching it with /settings, then log the entry again with /log."
  )
})

test("a failure processing an entry is reported, and the entry stays for the next run", async () => {
  const pendingRepo = new PendingRepository(db)
  const foodLogsRepo = new FoodLogsRepository(db)
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(42, "ray")
  pendingRepo.create(42, -100, "chicken adobo", "2026-09-21")
  const error = new Error("SQLITE_BUSY")
  const estimate = mock(() => Promise.reject(error))
  const analytics = new FakeAnalytics()
  const errorLog = spyOn(console, "error").mockImplementation(() => {})

  const job = createRetryPendingJob(
    { api: { sendMessage: mock(() => Promise.resolve()) } } as any,
    pendingRepo,
    foodLogsRepo,
    usersRepo,
    { estimate } as unknown as AIService,
    analytics
  )
  await job()

  expect(analytics.exceptions).toEqual([{ error, telegramId: 42, properties: { source: "retry-pending" } }])
  expect(pendingRepo.getForRetry(5)[0].retry_count).toBe(1)
  errorLog.mockRestore()
})
