// src/bot/commands/delete.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { encodeDeleteCallback } from "../utils/callback-data"
import { deleteAllToken, resolveDeleteCallback, createDeleteCallbackHandler } from "./delete"

const OWNER = 42
const OTHER = 99
const DATE = "2026-09-25"

let foodLogsRepo: FoodLogsRepository

beforeEach(() => {
  const db = createTestDb()
  const usersRepo = new UsersRepository(db)
  usersRepo.upsert(OWNER, "maria")
  usersRepo.upsert(OTHER, "bob")
  foodLogsRepo = new FoodLogsRepository(db)
})

function logItems(
  telegramId: number,
  items: { description: string; calories: number; emoji?: string }[]
) {
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
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OTHER, foodLogsRepo)

    expect(decision).toEqual({ kind: "not_owner" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(1)
  })

  test("deletes one item", () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "done", edit: "🗑 Deleted: 🍜 Ramen — 520 cal", toast: "Deleted" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(0)
  })

  test("will not delete another user's item", () => {
    const [item] = logItems(OTHER, [{ description: "Toast", calories: 150 }])
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "gone", toast: "That entry is no longer there." })
    expect(foodLogsRepo.getItemsByDate(OTHER, DATE)).toHaveLength(1)
  })

  test("reports an item that no longer exists", () => {
    const decision = resolveDeleteCallback({ action: "one", ownerId: OWNER, itemId: 12345 }, OWNER, foodLogsRepo)
    expect(decision).toEqual({ kind: "gone", toast: "That entry is no longer there." })
  })

  test("deletes all of the day's items when the list is unchanged", () => {
    const items = logItems(OWNER, [
      { description: "Eggs", calories: 180, emoji: "🍳" },
      { description: "Toast", calories: 150, emoji: "🍞" },
    ])
    const decision = resolveDeleteCallback(
      { action: "all", ownerId: OWNER, date: DATE, token: deleteAllToken(items) },
      OWNER,
      foodLogsRepo
    )

    expect(decision).toEqual({
      kind: "done",
      edit: "🗑 Deleted 2 entries (330 cal) for Fri, Sep 25.",
      toast: "Deleted",
    })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(0)
  })

  test("refuses Delete all when an item was added after the prompt", () => {
    const items = logItems(OWNER, [{ description: "Eggs", calories: 180 }])
    const token = deleteAllToken(items)
    logItems(OWNER, [{ description: "Apple", calories: 95 }])

    const decision = resolveDeleteCallback({ action: "all", ownerId: OWNER, date: DATE, token }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "gone", toast: "The list changed — run /delete again." })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(2)
  })

  test("Cancel deletes nothing", () => {
    logItems(OWNER, [{ description: "Eggs", calories: 180 }])
    const decision = resolveDeleteCallback({ action: "cxl", ownerId: OWNER }, OWNER, foodLogsRepo)

    expect(decision).toEqual({ kind: "done", edit: "✖️ Cancelled — nothing deleted.", toast: "Cancelled" })
    expect(foodLogsRepo.getItemsByDate(OWNER, DATE)).toHaveLength(1)
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
    await createDeleteCallbackHandler(foodLogsRepo)(ctx as unknown as Context)
    return ctx
  }

  test("a press by someone else is refused without touching the message", async () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520 }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }), OTHER)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can confirm it.")
    expect(ctx.editMessageText).not.toHaveBeenCalled()
    expect(ctx.editMessageReplyMarkup).not.toHaveBeenCalled()
  })

  test("a successful press edits the message in place", async () => {
    const [item] = logItems(OWNER, [{ description: "Ramen", calories: 520, emoji: "🍜" }])
    const ctx = await press(encodeDeleteCallback({ action: "one", ownerId: OWNER, itemId: item.id! }))

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Deleted")
    expect(ctx.editMessageText).toHaveBeenCalledWith("🗑 Deleted: 🍜 Ramen — 520 cal", undefined)
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
})
