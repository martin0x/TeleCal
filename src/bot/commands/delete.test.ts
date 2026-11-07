// src/bot/commands/delete.test.ts
import { describe, test, expect, beforeEach, mock, spyOn } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import type { FoodItem } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { getTodayInTimezone, DEFAULT_TIMEZONE } from "../../utils/dates"
import { encodeDeleteCallback } from "../utils/callback-data"
import {
  deleteAllToken,
  resolveDeleteCallback,
  createDeleteCallbackHandler,
  createDeleteCommand,
  createDeleteMessageHandler,
  hasDeleteState,
} from "./delete"

const OWNER = 42
const OTHER = 99
const DATE = "2026-09-25"

let foodLogsRepo: FoodLogsRepository
let usersRepo: UsersRepository

beforeEach(() => {
  const db = createTestDb()
  usersRepo = new UsersRepository(db)
  usersRepo.upsert(OWNER, "maria")
  usersRepo.upsert(OTHER, "bob")
  foodLogsRepo = new FoodLogsRepository(db)
})

function logItems(telegramId: number, items: FoodItem[]) {
  return foodLogsRepo.create(telegramId, 555, DATE, items).items
}

describe("deleteAllToken", () => {
  test("does not depend on item order", () => {
    const a = { id: 2, description: "a", calories: 1 }
    const b = { id: 1, description: "b", calories: 1 }
    expect(deleteAllToken([a, b])).toBe(deleteAllToken([b, a]))
  })
})

describe("resolveDeleteCallback", () => {
  test("refuses a press by someone other than the owner", () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OTHER, foodLogsRepo, ["protein"])

    expect(decision).toEqual({ kind: "not_owner" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(1)
  })

  test("deletes one item", () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OWNER, foodLogsRepo, ["protein"])

    expect(decision).toEqual({ kind: "done", edit: "🗑 Deleted: 🍜 Ramen — 520 cal · 22 g", toast: "Deleted" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(0)
  })

  test("will not delete another user's item", () => {
    const [item] = logItems(OTHER, [{ description: "Toast", calories: 150 }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OWNER, foodLogsRepo, ["protein"])

    expect(decision).toEqual({ kind: "gone", toast: "That entry is no longer there." })
    expect(foodLogsRepo.getItemsByDate(OTHER, DATE)).toHaveLength(1)
  })

  test("reports an item that no longer exists", () => {
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: 12345 }, OWNER, foodLogsRepo, ["protein"])
    expect(decision).toEqual({ kind: "gone", toast: "That entry is no longer there." })
  })

  test("deletes all of the day's items when the list is unchanged", () => {
    const items = logItems(OWNER, [
      { description: "Eggs", calories: 180, protein_g: 12, emoji: "🍳" },
      { description: "Toast", calories: 150, protein_g: 4, emoji: "🍞" },
    ])
    const decision = resolveDeleteCallback(
      { action: "all", ownerId: OWNER, date: DATE, token: deleteAllToken(items) },
      OWNER,
      foodLogsRepo,
      ["protein"]
    )

    expect(decision).toEqual({
      kind: "done",
      edit: "🗑 Deleted 2 entries (330 cal · 16 g protein) for Fri, Sep 25.",
      toast: "Deleted",
    })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(0)
  })

  test("refuses Delete all when an item was added after the prompt", () => {
    const items = logItems(OWNER, [{ description: "Eggs", calories: 180 }])
    const token = deleteAllToken(items)
    logItems(OWNER, [{ description: "Apple", calories: 95 }])

    const decision = resolveDeleteCallback({ action: "all", ownerId: OWNER, date: DATE, token }, OWNER, foodLogsRepo, ["protein"])

    expect(decision).toEqual({ kind: "gone", toast: "The list changed — run /delete again." })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(2)
  })

  test("Cancel deletes nothing", () => {
    logItems(OWNER, [{ description: "Eggs", calories: 180 }])
    const decision = resolveDeleteCallback({ action: "cxl", ownerId: OWNER }, OWNER, foodLogsRepo, ["protein"])

    expect(decision).toEqual({ kind: "done", edit: "✖️ Cancelled — nothing deleted.", toast: "Cancelled" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(1)
  })

  test("the summary follows the macros it is given", () => {
    const items = logItems(OWNER, [{ description: "Adobo", calories: 420, protein_g: 38, fiber_g: 1, emoji: "🍗" }])
    const decision = resolveDeleteCallback(
      { action: "all", ownerId: OWNER, date: DATE, token: deleteAllToken(items) },
      OWNER,
      foodLogsRepo,
      ["fiber"]
    )
    expect(decision).toEqual({ kind: "done", edit: "🗑 Deleted 1 entries (420 cal · 1 g fiber) for Fri, Sep 25.", toast: "Deleted" })
  })
})

describe("createDeleteCallbackHandler", () => {
  function fakeCallbackCtx(data: string, fromId: number) {
    return {
      from: { id: fromId, first_name: "Maria" },
      chat: { id: 555, type: "private" },
      callbackQuery: { data },
      answerCallbackQuery: mock(() => Promise.resolve(true)),
      editMessageText: mock(() => Promise.resolve(true)),
      editMessageReplyMarkup: mock(() => Promise.resolve(true)),
      reply: mock(() => Promise.resolve()),
    }
  }

  async function press(data: string, fromId = OWNER) {
    const ctx = fakeCallbackCtx(data, fromId)
    await createDeleteCallbackHandler(foodLogsRepo, usersRepo)(ctx as unknown as Context)
    return ctx
  }

  test("a press by someone else is refused without touching the message", async () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }), OTHER)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can confirm it.")
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
  })

  test("a successful press edits the message in place", async () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }))

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Deleted")
    expect(ctx.editMessageText).toHaveBeenCalledWith("🗑 Deleted: 🍜 Ramen — 520 cal · 22 g", undefined)
  })

  test("a stale press strips the keyboard", async () => {
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: 12345 }))

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That entry is no longer there.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
    expect(ctx.editMessageText).not.toHaveBeenCalled()
  })

  test("malformed data expires the button", async () => {
    const ctx = await press("del:one:42")

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That button has expired.")
    expect(ctx.editMessageReplyMarkup).toHaveBeenCalled()
  })

  test("if answering the callback query fails, the message is still edited", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, emoji: "🍜" }])
    const ctx = fakeCallbackCtx(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }), OWNER)
    ctx.answerCallbackQuery.mockImplementation(() => Promise.reject(new Error("query is too old")))

    await createDeleteCallbackHandler(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(ctx.editMessageText).toHaveBeenCalledWith("🗑 Deleted: 🍜 Ramen — 520 cal · 22 g", undefined)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  test("the edited message uses the owner's macros", async () => {
    usersRepo.updateSettings(OWNER, { tracked_macros: ["protein", "fat"] })
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, protein_g: 22, fat_g: 18, emoji: "🍜" }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }))

    expect(ctx.editMessageText).toHaveBeenCalledWith("🗑 Deleted: 🍜 Ramen — 520 cal · 22 g · 18 g fat", undefined)
  })
})

describe("a stale button press vs. a newer typed /delete session", () => {
  function fakeCommandCtx(fromId: number) {
    return {
      from: { id: fromId, first_name: "Maria" },
      message: { text: "/delete" },
      chat: { type: "private" },
      reply: mock(() => Promise.resolve()),
    }
  }

  function fakeCallbackCtx(data: string, fromId: number) {
    return {
      from: { id: fromId, first_name: "Maria" },
      chat: { id: 555, type: "private" },
      callbackQuery: { data },
      answerCallbackQuery: mock(() => Promise.resolve(true)),
      editMessageText: mock(() => Promise.resolve(true)),
      editMessageReplyMarkup: mock(() => Promise.resolve(true)),
      reply: mock(() => Promise.resolve()),
    }
  }

  test("a stale press for a missing item leaves a newer typed session intact", async () => {
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    foodLogsRepo.create(OWNER, 555, today, [{ description: "Eggs", calories: 180 }])

    await createDeleteCommand(foodLogsRepo, usersRepo)(fakeCommandCtx(OWNER) as unknown as Context)
    expect(hasDeleteState(OWNER)).toBe(true)

    const staleCtx = fakeCallbackCtx(
      encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: 999999 }),
      OWNER
    )
    await createDeleteCallbackHandler(foodLogsRepo, usersRepo)(staleCtx as unknown as Context)

    expect(hasDeleteState(OWNER)).toBe(true)
  })

  test("a successful press still clears the typed session", async () => {
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    const [item] = foodLogsRepo.create(OWNER, 555, today, [{ description: "Eggs", calories: 180 }]).items

    await createDeleteCommand(foodLogsRepo, usersRepo)(fakeCommandCtx(OWNER) as unknown as Context)
    expect(hasDeleteState(OWNER)).toBe(true)

    const ctx = fakeCallbackCtx(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }), OWNER)
    await createDeleteCallbackHandler(foodLogsRepo, usersRepo)(ctx as unknown as Context)

    expect(hasDeleteState(OWNER)).toBe(false)
  })
})

describe("typed /delete follows the user's macros", () => {
  test("the list and the single-item prompt show the tracked macros", async () => {
    usersRepo.updateSettings(OWNER, { tracked_macros: ["added_sugar"] })
    const today = getTodayInTimezone(DEFAULT_TIMEZONE)
    foodLogsRepo.create(OWNER, 555, today, [{ description: "Halo-halo", calories: 350, added_sugar_g: 40, emoji: "🍧" }])

    const command = { from: { id: OWNER, first_name: "Maria" }, chat: { type: "private" }, message: { text: "/delete" }, reply: mock(() => Promise.resolve()) }
    await createDeleteCommand(foodLogsRepo, usersRepo)(command as unknown as Context)
    expect(command.reply).toHaveBeenCalledWith(expect.stringContaining("1. 🍧 Halo-halo — 350 cal · 40 g sugar"), undefined)

    const typed = { from: { id: OWNER, first_name: "Maria" }, chat: { type: "private" }, message: { text: "1" }, reply: mock(() => Promise.resolve()) }
    await createDeleteMessageHandler(foodLogsRepo, usersRepo)(typed as unknown as Context)
    expect(typed.reply).toHaveBeenCalledWith("Delete this entry?\n\n🍧 Halo-halo — 350 cal · 40 g sugar", expect.anything())
  })
})
