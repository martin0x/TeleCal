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
    expect(parseEditInput("18g")).toEqual({ kind: "macro", key: "protein", value: 18 })
    expect(parseEditInput("18 G")).toEqual({ kind: "macro", key: "protein", value: 18 })
    expect(parseEditInput("0g")).toEqual({ kind: "macro", key: "protein", value: 0 })
  })

  test("a macro's name after the grams sets that macro", () => {
    expect(parseEditInput("18g protein")).toEqual({ kind: "macro", key: "protein", value: 18 })
    expect(parseEditInput("24g fat")).toEqual({ kind: "macro", key: "fat", value: 24 })
    expect(parseEditInput("5 g Fibre")).toEqual({ kind: "macro", key: "fiber", value: 5 })
    expect(parseEditInput("3g sugar")).toEqual({ kind: "macro", key: "added_sugar", value: 3 })
    expect(parseEditInput("3g added  sugar")).toEqual({ kind: "macro", key: "added_sugar", value: 3 })
  })

  test("grams of anything else is a description", () => {
    expect(parseEditInput("200g chicken")).toEqual({ kind: "describe", text: "200g chicken" })
  })

  test("out-of-range numbers are rejected with a message", () => {
    expect(parseEditInput("0")).toEqual({ kind: "invalid", message: "Calories must be between 1 and 9999." })
    expect(parseEditInput("20000")).toEqual({ kind: "invalid", message: "Calories must be between 1 and 9999." })
    expect(parseEditInput("1500g")).toEqual({ kind: "invalid", message: "Protein must be between 0 and 1000 g." })
    expect(parseEditInput("1500g sugar")).toEqual({ kind: "invalid", message: "Added sugar must be between 0 and 1000 g." })
  })

  test("anything else is a description to re-estimate", () => {
    expect(parseEditInput("two eggs and toast")).toEqual({ kind: "describe", text: "two eggs and toast" })
    expect(parseEditInput("200 grams of rice")).toEqual({ kind: "describe", text: "200 grams of rice" })
  })

  test("a number with a calorie unit still sets calories", () => {
    expect(parseEditInput("250 cal")).toEqual({ kind: "calories", value: 250 })
    expect(parseEditInput("250kcal")).toEqual({ kind: "calories", value: 250 })
    expect(parseEditInput("250 Calories")).toEqual({ kind: "calories", value: 250 })
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
        "• Type a number to set calories (e.g. 200 or 200 cal)\n" +
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

  test("a description the AI can't estimate keeps the edit open and suggests a number", async () => {
    const item = logToday()
    const estimate = mock(() => Promise.resolve({ items: [], needsClarification: true, confidence: "low" as const }))
    const ctx = await editWith("something", { estimate } as unknown as AIService)

    expect(ctx.reply).toHaveBeenCalledWith(
      'Couldn\'t estimate "something".\n\n' +
        'Try a number (calories) or a number with g (protein) instead, or "cancel" to abort.',
      undefined
    )
    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 520, protein_g: 22 })
  })

  test("the prompt adds the macro hint when an extra macro is tracked", async () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["protein", "added_sugar"] })
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    foodLogsRepo.create(USER, 555, today, [{ description: "Chicken adobo (2 pcs)", calories: 420, protein_g: 38, added_sugar_g: 2, emoji: "🍗" }])
    const ctx = commandCtx("/edit 1")
    await createEditCommand(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.reply).toHaveBeenCalledWith(
      "Editing: 🍗 Chicken adobo (2 pcs) — 420 cal · 38 g · 2 g sugar\n\n" +
        "What would you like to change?\n" +
        "• Type a number to set calories (e.g. 200 or 200 cal)\n" +
        "• Type a number with g to set protein (e.g. 18g)\n" +
        "• Add the macro's name to set another (e.g. 5g sugar)\n" +
        "• Or describe the food to re-estimate\n" +
        '• Type "cancel" to abort',
      undefined
    )
  })

  test("with protein off, the protein hint goes and the example uses the first extra macro", async () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["fat", "fiber"] })
    logToday()
    const ctx = commandCtx("/edit 1")
    await createEditCommand(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.reply).toHaveBeenCalledWith(
      "Editing: 🍜 Ramen — 520 cal · ? g fat · ? g fiber\n\n" +
        "What would you like to change?\n" +
        "• Type a number to set calories (e.g. 200 or 200 cal)\n" +
        "• Add the macro's name to set another (e.g. 5g fat)\n" +
        "• Or describe the food to re-estimate\n" +
        '• Type "cancel" to abort',
      undefined
    )
  })

  test("3g sugar updates only added sugar", async () => {
    usersRepo.updateSettings(USER, { tracked_macros: ["protein", "added_sugar"] })
    const item = logToday()
    const ctx = await editWith("3g sugar")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ calories: 520, protein_g: 22, added_sugar_g: 3 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 520 cal · 22 g · 3 g sugar", undefined)
  })

  test("a macro the user doesn't track is still saved, and the reply shows it", async () => {
    const item = logToday()
    const ctx = await editWith("24g fat")

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ fat_g: 24 })
    expect(ctx.reply).toHaveBeenCalledWith("Updated: 🍜 Ramen — 520 cal · 22 g · 24 g fat", undefined)
  })

  test("re-estimating replaces every macro", async () => {
    const item = logToday()
    const estimate = mock(() =>
      Promise.resolve({
        items: [{ description: "Tonkotsu ramen", calories: 650, protein_g: 30, fat_g: 28, fiber_g: 3, added_sugar_g: 1, emoji: "🍜" }],
        needsClarification: false,
        confidence: "high" as const,
      })
    )
    await editWith("tonkotsu ramen", { estimate } as unknown as AIService)

    expect(foodLogsRepo.getItemForUser(item.id!, USER)).toMatchObject({ protein_g: 30, fat_g: 28, fiber_g: 3, added_sugar_g: 1 })
  })
})
