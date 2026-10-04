// src/bot/conversations/log-flow.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Database } from "bun:sqlite"
import { LogFlow, LogFlowResult, confirmToken } from "./log-flow"
import { ConversationsRepository } from "../../db/repositories/conversations"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { PendingRepository } from "../../db/repositories/pending"
import { AIService } from "../../ai/service"
import { EstimationResult } from "../../ai/types"

describe("LogFlow", () => {
  let db: Database
  let conversationsRepo: ConversationsRepository
  let foodLogsRepo: FoodLogsRepository
  let pendingRepo: PendingRepository
  let mockAIService: { estimate: ReturnType<typeof mock> }
  let logFlow: LogFlow

  beforeEach(() => {
    db = new Database(":memory:")
    db.run("PRAGMA foreign_keys = ON")

    // Create tables
    db.run(`
      CREATE TABLE conversation_state (
        telegram_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        pending_food TEXT,
        pending_items TEXT,
        context TEXT,
        target_date TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `)
    db.run(`
      CREATE TABLE food_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        logged_at TEXT DEFAULT (datetime('now')),
        target_date TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE food_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        calories INTEGER NOT NULL,
        protein_g INTEGER,
        emoji TEXT,
        FOREIGN KEY (log_id) REFERENCES food_logs(id) ON DELETE CASCADE
      )
    `)
    db.run(`
      CREATE TABLE pending_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        food_text TEXT NOT NULL,
        submitted_at TEXT DEFAULT (datetime('now')),
        target_date TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        last_retry_at TEXT
      )
    `)

    conversationsRepo = new ConversationsRepository(db)
    foodLogsRepo = new FoodLogsRepository(db)
    pendingRepo = new PendingRepository(db)

    mockAIService = {
      estimate: mock(() =>
        Promise.resolve({
          items: [{ description: "Chicken", calories: 200, protein_g: 25, emoji: "🍗" }],
          needsClarification: false,
          confidence: "high" as const,
        })
      ),
    }

    logFlow = new LogFlow(
      conversationsRepo,
      foodLogsRepo,
      pendingRepo,
      mockAIService as unknown as AIService
    )
  })

  test("start() creates awaiting_input state", async () => {
    const result = await logFlow.start(123, 456, "2026-01-31", "openai")

    expect(result.message).toContain("What did you eat")
    const state = conversationsRepo.get(123)
    expect(state?.state).toBe("awaiting_input")
  })

  test("start() with existing conversation asks to continue or start over", async () => {
    conversationsRepo.upsert(123, 456, "clarifying", "2026-01-30")
    const result = await logFlow.start(123, 456, "2026-01-31", "openai")

    expect(result.message).toContain("already have an active")
    expect(result.action).toBe("ask_continue")
  })

  test("processInput() with cancel clears state", async () => {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "cancel", "openai")

    expect(result.message).toContain("Cancelled")
    expect(conversationsRepo.get(123)).toBeNull()
  })

  test("processInput() in awaiting_input calls AI and moves to confirming", async () => {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "grilled chicken", "openai")

    expect(mockAIService.estimate).toHaveBeenCalled()
    expect(result.message).toContain("Chicken")
    expect(result.message).toContain("200")
    const state = conversationsRepo.get(123)
    expect(state?.state).toBe("confirming")
  })

  test("processInput() moves to clarifying when AI needs clarification", async () => {
    mockAIService.estimate = mock(() =>
      Promise.resolve({
        items: [],
        needsClarification: true,
        clarificationQuestion: "How much chicken?",
        confidence: "low" as const,
      })
    )

    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "chicken", "openai")

    expect(result.message).toContain("How much chicken")
    const state = conversationsRepo.get(123)
    expect(state?.state).toBe("clarifying")
  })

  test("processInput() in clarifying uses context for AI", async () => {
    conversationsRepo.upsert(123, 456, "clarifying", "2026-01-31", {
      pending_food: "chicken",
      context: JSON.stringify({ originalInput: "chicken" }),
    })

    await logFlow.processInput(123, 456, "200g grilled", "openai")

    expect(mockAIService.estimate).toHaveBeenCalledWith(
      "200g grilled",
      "openai",
      expect.objectContaining({
        callType: "clarify",
        context: expect.stringContaining("chicken"),
      })
    )
  })

  test("processInput() in confirming with yes logs food", async () => {
    conversationsRepo.upsert(123, 456, "confirming", "2026-01-31", {
      pending_items: JSON.stringify([{ description: "Chicken", calories: 200, protein_g: 25, emoji: "🍗" }]),
    })

    const result = await logFlow.processInput(123, 456, "yes", "openai")

    expect(result.message).toContain("Logged")
    expect(result.message).toContain("200")
    expect(conversationsRepo.get(123)).toBeNull()

    const logs = foodLogsRepo.getByDate(123, "2026-01-31")
    expect(logs.length).toBe(1)
    expect(logs[0].items[0].calories).toBe(200)
  })

  test("processInput() in confirming with no returns to awaiting", async () => {
    conversationsRepo.upsert(123, 456, "confirming", "2026-01-31", {
      pending_items: JSON.stringify([{ description: "Chicken", calories: 200, protein_g: 25 }]),
    })

    const result = await logFlow.processInput(123, 456, "no", "openai")

    expect(result.message).toContain("What did you eat")
    const state = conversationsRepo.get(123)
    expect(state?.state).toBe("awaiting_input")
  })

  test("handles AI failure gracefully with pending entry", async () => {
    mockAIService.estimate = mock(() => Promise.reject(new Error("API error")))

    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "chicken", "openai")

    expect(result.message).toContain("saved your entry")
    const pending = pendingRepo.getByUser(123)
    expect(pending.length).toBe(1)
  })

  test("continueOrStartOver with continue resumes existing", async () => {
    conversationsRepo.upsert(123, 456, "clarifying", "2026-01-30", {
      pending_food: "chicken",
    })

    const result = await logFlow.continueOrStartOver(123, 456, "continue", "2026-01-31")

    expect(result.action).toBe("continue")
    const state = conversationsRepo.get(123)
    expect(state?.target_date).toBe("2026-01-30")
  })

  test("continueOrStartOver with new clears and starts fresh", async () => {
    conversationsRepo.upsert(123, 456, "clarifying", "2026-01-30", {
      pending_food: "chicken",
    })

    const result = await logFlow.continueOrStartOver(123, 456, "new", "2026-01-31")

    expect(result.message).toContain("What did you eat")
    const state = conversationsRepo.get(123)
    expect(state?.state).toBe("awaiting_input")
    expect(state?.target_date).toBe("2026-01-31")
  })

  async function reachConfirming(): Promise<string> {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "grilled chicken", "openai")
    return result.confirm!.token
  }

  test("confirmation is an HTML summary with a confirm token", async () => {
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "grilled chicken", "openai")

    expect(result.parseMode).toBe("HTML")
    expect(result.message).toBe(
      "Here's what I'll log:\n<blockquote>🍗 Chicken — 200 cal · 25 g</blockquote>\n<b>Total: 200 cal · 25 g protein</b>"
    )
    const state = conversationsRepo.get(123)!
    expect(result.confirm).toEqual({
      token: confirmToken("2026-01-31", state.pending_items!),
      totals: { calories: 200, protein: 25 },
    })
  })

  test("confirmation escapes AI descriptions", async () => {
    mockAIService.estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Mac & cheese", calories: 400, protein_g: 18, emoji: "🧀" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await logFlow.start(123, 456, "2026-01-31", "openai")
    const result = await logFlow.processInput(123, 456, "mac and cheese", "openai")

    expect(result.message).toContain("Mac &amp; cheese")
  })

  test("resolveConfirmation log saves the items and describes them", async () => {
    const token = await reachConfirming()
    const outcome = logFlow.resolveConfirmation(123, 456, token, "log")

    expect(outcome).toEqual({
      stale: false,
      edit: "✅ Logged to Sat, Jan 31:\n<blockquote>🍗 Chicken — 200 cal · 25 g</blockquote>\n<b>Total: 200 cal · 25 g protein</b>",
      toast: "Logged ✅",
    })
    expect(conversationsRepo.get(123)).toBeNull()
    expect(foodLogsRepo.getByDate(123, "2026-01-31")[0].items[0].calories).toBe(200)
  })

  test("a confirming session saved before protein tracking still logs, showing ? g", () => {
    const pendingItems = JSON.stringify([{ description: "Chicken", calories: 200, emoji: "🍗" }])
    conversationsRepo.upsert(123, 456, "confirming", "2026-01-31", { pending_items: pendingItems })

    const outcome = logFlow.resolveConfirmation(123, 456, confirmToken("2026-01-31", pendingItems), "log")

    expect(outcome.stale).toBe(false)
    if (outcome.stale) return
    expect(outcome.edit).toContain("🍗 Chicken — 200 cal · ? g")
    expect(outcome.edit).toContain("Total: 200 cal · 0 g protein")
    expect(foodLogsRepo.getByDate(123, "2026-01-31")[0].items[0].protein_g).toBeNull()
  })

  test("resolveConfirmation change returns to input without logging", async () => {
    const token = await reachConfirming()
    const outcome = logFlow.resolveConfirmation(123, 456, token, "change")

    expect(outcome).toEqual({
      stale: false,
      edit:
        "✏️ Not logged — changing:\n<blockquote><s>🍗 Chicken — 200 cal · 25 g</s></blockquote>\n" +
        "<b><s>Total: 200 cal · 25 g protein</s></b>",
      followUp: "Okay, let's try again. What did you eat?",
    })
    expect(conversationsRepo.get(123)?.state).toBe("awaiting_input")
    expect(foodLogsRepo.getByDate(123, "2026-01-31")).toHaveLength(0)
  })

  test("resolveConfirmation cancel clears the session without logging", async () => {
    const token = await reachConfirming()
    const outcome = logFlow.resolveConfirmation(123, 456, token, "cancel")

    expect(outcome).toEqual({
      stale: false,
      edit:
        "✖️ Cancelled — not logged:\n<blockquote><s>🍗 Chicken — 200 cal · 25 g</s></blockquote>\n" +
        "<b><s>Total: 200 cal · 25 g protein</s></b>",
      toast: "Cancelled",
    })
    expect(conversationsRepo.get(123)).toBeNull()
    expect(foodLogsRepo.getByDate(123, "2026-01-31")).toHaveLength(0)
  })

  test("resolveConfirmation is stale with no session", () => {
    expect(logFlow.resolveConfirmation(123, 456, "abcd1234", "log")).toEqual({ stale: true })
  })

  test("resolveConfirmation is stale once the session has left confirming", async () => {
    const token = await reachConfirming()
    await logFlow.processInput(123, 456, "no", "openai")

    expect(logFlow.resolveConfirmation(123, 456, token, "log")).toEqual({ stale: true })
  })

  test("an old Log button cannot confirm a newer estimate", async () => {
    const oldToken = await reachConfirming()
    await logFlow.processInput(123, 456, "no", "openai")
    mockAIService.estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Beef", calories: 300, protein_g: 30, emoji: "🥩" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await logFlow.processInput(123, 456, "beef", "openai")

    expect(logFlow.resolveConfirmation(123, 456, oldToken, "log")).toEqual({ stale: true })
    expect(foodLogsRepo.getByDate(123, "2026-01-31")).toHaveLength(0)
    expect(conversationsRepo.get(123)?.state).toBe("confirming")
  })

  test("resuming a confirming session re-sends the same token", async () => {
    const token = await reachConfirming()
    const result = await logFlow.continueOrStartOver(123, 456, "continue", "2026-02-01")

    expect(result.parseMode).toBe("HTML")
    expect(result.confirm?.token).toBe(token)
    expect(result.message).toStartWith("Continuing session for 2026-01-31.\n<blockquote>")
  })

  test("unrecognized text while confirming points to the buttons", async () => {
    await reachConfirming()
    const result = await logFlow.processInput(123, 456, "maybe", "openai")

    expect(result.message).toBe('Tap a button above, or reply "yes" / "no".')
    expect(conversationsRepo.get(123)?.state).toBe("confirming")
  })
})
