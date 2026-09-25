// src/jobs/retry-pending.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../db/test-helpers"
import { PendingRepository } from "../db/repositories/pending"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { createRetryPendingJob } from "./retry-pending"
import type { AIService } from "../ai/service"

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
      items: [{ description: "Chicken adobo", calories: 420, emoji: "🍗" }],
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
    "✅ Processed your saved entry — logged to Mon, Sep 21:\n" +
      "<blockquote>🍗 Chicken adobo — 420 cal</blockquote>\n<b>Total: 420 cal</b>",
    { parse_mode: "HTML" }
  )
})
