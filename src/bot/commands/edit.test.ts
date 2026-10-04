// src/bot/commands/edit.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, DEFAULT_TIMEZONE } from "../../utils/dates"
import type { AIService } from "../../ai/service"
import { parseEditInput, createEditCommand, createEditMessageHandler, clearEditState } from "./edit"

const USER = 42
let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository

beforeEach(() => {
  const db = createTestDb()
  foodLogsRepo = new FoodLogsRepository(db)
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(USER, "maria")
  clearEditState(USER)
})

describe("parseEditInput", () => {
  test("a bare number sets calories", () => {
    expect(parseEditInput("200")).toEqual({ kind: "calories", value: 200 })
    expect(parseEditInput(" 200 ")).toEqual({ kind: "calories", value: 200 })
  })

  test("a number with g sets protein, case-insensitive, with or without a space", () => {
    expect(parseEditInput("18g")).toEqual({ kind: "protein", value: 18 })
    expect(parseEditInput("18 G")).toEqual({ kind: "protein", value: 18 })
    expect(parseEditInput("0g")).toEqual({ kind: "protein", value: 0 })
  })

  test("out-of-range numbers are rejected with a message", () => {
    expect(parseEditInput("0")).toEqual({ kind: "invalid", message: "Calories must be between 1 and 9999." })
    expect(parseEditInput("20000")).toEqual({ kind: "invalid", message: "Calories must be between 1 and 9999." })
    expect(parseEditInput("1500g")).toEqual({ kind: "invalid", message: "Protein must be between 0 and 1000 g." })
  })

  test("anything else is a description to re-estimate", () => {
    expect(parseEditInput("two eggs and toast")).toEqual({ kind: "describe", text: "two eggs and toast" })
    expect(parseEditInput("200 grams of rice")).toEqual({ kind: "describe", text: "200 grams of rice" })
  })
})

describe("edit flow", () => {
  function commandCtx(text: string) {
    return { from: { id: USER, first_name: "Maria" }, chat: { id: 555, type: "private" }, message: { text }, reply: mock(() => Promise.resolve()) }
  }

  function logToday() {
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    return foodLogsRepo.create(USER, 555, today, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }]).items[0]
  }

  async function editWith(text: string, aiService: AIService = {} as AIService) {
    await createEditCommand(foodLogsRepo, usersRepo)(commandCtx("/edit 1") as unknown as Context)
    const ctx = commandCtx(text)
    await createEditMessageHandler(foodLogsRepo, usersRepo, aiService)(ctx as unknown as Context)
    return ctx
  }

  test("the prompt explains all three inputs", async () => {
    logToday()
    const ctx = commandCtx("/edit 1")
    await createEditCommand(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.reply).toHaveBeenCalledWith(
      "Editing: 🍜 Ramen — 520 cal · 22 g\n\n" +
        "What would you like to change?\n" +
        "• Type a number to set calories (e.g. 200)\n" +
        "• Type a number with g to set protein (e.g. 18g)\n" +
        "• Or describe the food to re-estimate\n" +
        '• Type "cancel" to abort',
      undefined
    )
  })

  test("18g updates only protein", async () => {
    const item = logToday()
    const ctx = await editWith("18g")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 520, protein_g: 18 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 520 cal · 18 g", undefined)
  })

  test("a bare number updates only calories", async () => {
    const item = logToday()
    const ctx = await editWith("600")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 600, protein_g: 22 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 600 cal · 22 g", undefined)
  })

  test("an out-of-range number is refused and the edit stays open", async () => {
    const item = logToday()
    const ctx = await editWith("1500g")

    expect(ctx.reply).toHaveBeenCalledWith("Protein must be between 0 and 1000 g.", undefined)
    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ protein_g: 22 })
  })

  test("a description re-estimates and updates every field", async () => {
    const item = logToday()
    const estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Tonkotsu ramen", calories: 650, protein_g: 30, emoji: "🍜" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    const ctx = await editWith("tonkotsu ramen", { estimate } as unknown as AIService)

    expect(estimate).toHaveBeenCalledWith("tonkotsu ramen", expect.any(String), expect.objectContaining({ callType: "edit" }))
    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ description: "Tonkotsu ramen", calories: 650, protein_g: 30 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Tonkotsu ramen — 650 cal · 30 g", undefined)
  })
})
