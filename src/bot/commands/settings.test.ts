// src/bot/commands/settings.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { UsersRepository } from "../../db/repositories/users"
import type { AIService } from "../../ai/service"
import {
  createMainKeyboard,
  formatSettings,
  createSettingsCallbackHandler,
  createSettingsMessageHandler,
  hasPendingSettings,
  clearPendingSettings,
  MACROS_SCREEN_TEXT,
  createMacrosKeyboard,
} from "./settings"

const USER = 42
let usersRepo: UsersRepository
const aiService = { getAvailableProviders: () => ["gemini"], hasProvider: () => true } as unknown as AIService

beforeEach(() => {
  usersRepo = new UsersRepository(createTestDb())
  usersRepo.upsert(USER, "maria")
  clearPendingSettings(USER)
})

function callbackCtx(data: string) {
  return {
    from: { id: USER, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    deleteMessage: mock(() => Promise.resolve(true)),
  }
}

function messageCtx(text: string) {
  return {
    from: { id: USER, first_name: "Maria" },
    chat: { id: 555, type: "private" },
    message: { text },
    reply: mock(() => Promise.resolve()),
  }
}

async function pressThenType(button: string, text: string) {
  await createSettingsCallbackHandler(usersRepo, aiService)(callbackCtx(button) as unknown as Context)
  const ctx = messageCtx(text)
  await createSettingsMessageHandler(usersRepo)(ctx as unknown as Context)
  return ctx
}

describe("createMainKeyboard", () => {
  test("has a Macros button beside the protein goal", () => {
    const rows = createMainKeyboard().inline_keyboard.map((row) => row.map((b) => b.text))
    expect(rows).toEqual([
      ["Change Provider", "Set Calorie Goal"],
      ["Set Protein Goal", "Macros"],
      ["Set Reminder", "Set Timezone"],
      ["Meal Text Sharing", "Close"],
    ])
  })
})

describe("formatSettings", () => {
  test("shows both goals", () => {
    usersRepo.updateSettings(USER, { daily_goal: 2000, daily_protein_goal: 120 })
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Calorie Goal: 2,000 cal\nProtein Goal: 120 g\n")
  })

  test("shows Not set for missing goals", () => {
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Calorie Goal: Not set\nProtein Goal: Not set\n")
  })

  test("lists the tracked macros after the protein goal", () => {
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Protein Goal: Not set\nMacros: Protein\n")

    usersRepo.updateSettings(USER, { tracked_macros: ["added_sugar", "protein"] })
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Macros: Protein, Added sugar\n")

    usersRepo.updateSettings(USER, { tracked_macros: [] })
    expect(formatSettings(usersRepo.findById(USER)!)).toContain("Macros: None\n")
  })
})

describe("meal text sharing", () => {
  test("settings show it as On by default", () => {
    expect(formatSettings(usersRepo.findById(USER)!)).toEndWith("\nMeal text in analytics: On")
  })

  test("the button turns it off, then on again, without a typed step", async () => {
    const off = callbackCtx("settings:analytics")
    await createSettingsCallbackHandler(usersRepo, aiService)(off as unknown as Context)

    expect(usersRepo.findById(USER)!.analytics_content).toBe(false)
    expect(off.editMessageText).toHaveBeenCalledWith(formatSettings(usersRepo.findById(USER)!), {
      reply_markup: createMainKeyboard(),
    })
    expect(formatSettings(usersRepo.findById(USER)!)).toEndWith("\nMeal text in analytics: Off")
    expect(off.answerCallbackQuery).toHaveBeenCalledWith(
      "Your meals and the AI's replies are no longer sent to analytics."
    )
    expect(hasPendingSettings(USER)).toBe(false)

    const on = callbackCtx("settings:analytics")
    await createSettingsCallbackHandler(usersRepo, aiService)(on as unknown as Context)

    expect(usersRepo.findById(USER)!.analytics_content).toBe(true)
    expect(on.answerCallbackQuery).toHaveBeenCalledWith("Your meals and the AI's replies are sent to analytics again.")
  })
})

describe("protein goal flow", () => {
  test("the button prompts for grams and arms the typed step", async () => {
    const ctx = callbackCtx("settings:protein")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith(
      "⚙️ Set Protein Goal\n\nEnter your daily protein goal in grams (e.g., 120), or 'off' to clear it."
    )
    expect(hasPendingSettings(USER)).toBe(true)
  })

  test("a whole number sets the goal", async () => {
    const ctx = await pressThenType("settings:protein", "120")

    expect(usersRepo.findById(USER)!.daily_protein_goal).toBe(120)
    expect(ctx.reply).toHaveBeenCalledWith("Daily protein goal set to 120 g. Use /settings to view settings.", undefined)
    expect(hasPendingSettings(USER)).toBe(false)
  })

  test("off clears the goal", async () => {
    usersRepo.updateSettings(USER, { daily_protein_goal: 120 })
    const ctx = await pressThenType("settings:protein", "off")

    expect(usersRepo.findById(USER)!.daily_protein_goal).toBeNull()
    expect(ctx.reply).toHaveBeenCalledWith("Protein goal cleared. Use /settings to view settings.", undefined)
  })

  test("rejects values outside 10-500 and stays armed", async () => {
    const ctx = await pressThenType("settings:protein", "5")

    expect(ctx.reply).toHaveBeenCalledWith("Please enter a number between 10 and 500, or 'off' to clear.", undefined)
    expect(usersRepo.findById(USER)!.daily_protein_goal).toBeNull()
    expect(hasPendingSettings(USER)).toBe(true)
  })

  test("the calorie goal flow is unchanged", async () => {
    const ctx = await pressThenType("settings:goal", "1800")

    expect(usersRepo.findById(USER)!.daily_goal).toBe(1800)
    expect(ctx.reply).toHaveBeenCalledWith("Daily goal set to 1,800 cal. Use /settings to view settings.", undefined)
  })
})

describe("Macros screen", () => {
  test("the text says what the toggles do", () => {
    expect(MACROS_SCREEN_TEXT).toBe(
      "⚙️ Macros\n\nCalories always show. Pick what else shows beside them. Every meal is estimated for all four, so switching one on shows it for earlier meals too."
    )
  })

  test("Macros opens the screen with a button per macro", async () => {
    const ctx = callbackCtx("settings:macros")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith(MACROS_SCREEN_TEXT, { reply_markup: createMacrosKeyboard(["protein"]) })
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    const rows = createMacrosKeyboard(["protein"]).inline_keyboard.map((row) => row.map((b) => b.text))
    expect(rows).toEqual([["Protein ✓", "Fat"], ["Fiber", "Added sugar"], ["← Back"]])
  })

  test("a macro button switches it on, then off, and redraws", async () => {
    const on = callbackCtx("settings:macro:fiber")
    await createSettingsCallbackHandler(usersRepo, aiService)(on as unknown as Context)

    expect(usersRepo.findById(USER)!.tracked_macros).toEqual(["protein", "fiber"])
    expect(on.editMessageText).toHaveBeenCalledWith(MACROS_SCREEN_TEXT, { reply_markup: createMacrosKeyboard(["protein", "fiber"]) })
    expect(on.answerCallbackQuery).toHaveBeenCalledWith("Fiber on")

    const off = callbackCtx("settings:macro:fiber")
    await createSettingsCallbackHandler(usersRepo, aiService)(off as unknown as Context)

    expect(usersRepo.findById(USER)!.tracked_macros).toEqual(["protein"])
    expect(off.answerCallbackQuery).toHaveBeenCalledWith("Fiber off")
  })

  test("protein can be switched off too", async () => {
    await createSettingsCallbackHandler(usersRepo, aiService)(callbackCtx("settings:macro:protein") as unknown as Context)
    expect(usersRepo.findById(USER)!.tracked_macros).toEqual([])
  })

  test("an unknown macro changes nothing", async () => {
    const ctx = callbackCtx("settings:macro:carbs")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(usersRepo.findById(USER)!.tracked_macros).toEqual(["protein"])
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
  })

  test("Back returns to the main settings view", async () => {
    const ctx = callbackCtx("settings:back")
    await createSettingsCallbackHandler(usersRepo, aiService)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith(formatSettings(usersRepo.findById(USER)!), { reply_markup: createMainKeyboard() })
  })
})
