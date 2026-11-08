import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { FoodLibraryRepository } from "../../db/repositories/food-library"
import { FoodLogsRepository } from "../../db/repositories/food-logs"
import { UsersRepository } from "../../db/repositories/users"
import { FakeAnalytics } from "../../analytics/test-helpers"
import type { ParsedFoodsReply } from "../../ai/types"
import { encodeFoodsCallback, parseFoodsCallback } from "../utils/callback-data"
import {
  createFoodsCallbackHandler,
  createFoodsCommand,
  createFoodsMessageHandler,
  isAwaitingFoodsPaste,
  resetFoodsStates,
  stopAwaitingPaste,
  EXPIRED,
  NOT_AVAILABLE,
  PARSE_FAILED,
  PASTE_PROMPT,
  PRIVATE_ONLY,
  type FoodsDeps,
} from "./foods"

const OWNER = 42
const OTHER = 99

const OATS_ROW = { name: "Quaker Oats", serving: "1/2 cup (40 g)", serving_amount: 40, serving_unit: "g", calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }
const SKY_ROW = { name: "Skyflakes", serving: "1 pack (25 g)", serving_amount: 25, serving_unit: "g", calories: 110, protein_g: 2, fat_g: 3.5, fiber_g: null, added_sugar_g: 1 }

let library: FoodLibraryRepository
let foodLogs: FoodLogsRepository
let analytics: FakeAnalytics
let parseFoods: ReturnType<typeof mock>
let deps: FoodsDeps

beforeEach(() => {
  resetFoodsStates()
  const db = createTestDb()
  const users = new UsersRepository(db)
  users.upsert(OWNER, "maria")
  users.upsert(OTHER, "bob")
  library = new FoodLibraryRepository(db)
  foodLogs = new FoodLogsRepository(db)
  analytics = new FakeAnalytics()
  parseFoods = mock(async (): Promise<ParsedFoodsReply> => ({ foods: [OATS_ROW, SKY_ROW], unreadable: [] }))
  deps = {
    enabled: true,
    library,
    foodLogs,
    ai: { parseFoods } as unknown as FoodsDeps["ai"],
    users,
    analytics,
    miniAppUrl: "https://telecal.example/app",
  }
})

function commandCtx(text: string, opts: { fromId?: number; chatType?: string } = {}) {
  return {
    from: { id: opts.fromId ?? OWNER, first_name: "Maria" },
    chat: { id: 555, type: opts.chatType ?? "private" },
    message: { text, message_id: 1 },
    reply: mock(() => Promise.resolve()),
  }
}

function callbackCtx(data: string, fromId = OWNER) {
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

async function run(text: string, opts?: { fromId?: number; chatType?: string }) {
  const ctx = commandCtx(text, opts)
  await createFoodsCommand(deps)(ctx as unknown as Context)
  return ctx
}

async function send(text: string, fromId = OWNER) {
  const ctx = commandCtx(text, { fromId })
  await createFoodsMessageHandler(deps)(ctx as unknown as Context)
  return ctx
}

async function press(data: string, fromId = OWNER) {
  const ctx = callbackCtx(data, fromId)
  await createFoodsCallbackHandler(deps)(ctx as unknown as Context)
  return ctx
}

/** The callback data of every button on the last reply, flattened. */
function buttons(ctx: { reply: ReturnType<typeof mock> }): { text: string; data?: string; url?: string }[] {
  const options = ctx.reply.mock.calls.at(-1)?.[1] as { reply_markup?: { inline_keyboard: any[][] } } | undefined
  return (options?.reply_markup?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data, url: b.web_app?.url }))
}

function saveData(ctx: { reply: ReturnType<typeof mock> }): string {
  return buttons(ctx).find((b) => b.text.startsWith("Save"))!.data!
}

describe("/foods", () => {
  test("off: says it isn't available", async () => {
    deps.enabled = false
    const ctx = await run("/foods")
    expect(ctx.reply).toHaveBeenCalledWith(NOT_AVAILABLE, undefined)
  })

  test("in a group: points to a private chat", async () => {
    const ctx = await run("/foods", { chatType: "group" })
    expect(ctx.reply.mock.calls[0][0]).toContain(PRIVATE_ONLY)
  })

  test("the hub shows the count, Add foods and Open my foods", async () => {
    library.upsertMany(OWNER, [{ ...(OATS_ROW as any), serving_unit: "g" }], "import")
    const ctx = await run("/foods")
    expect(ctx.reply.mock.calls[0][0]).toBe("You have 1 food saved.")
    expect(buttons(ctx)).toEqual([
      { text: "Add foods", data: encodeFoodsCallback({ action: "add", ownerId: OWNER }), url: undefined },
      { text: "Open my foods", data: undefined, url: "https://telecal.example/app?tab=foods" },
    ])
  })

  test("an empty library says so", async () => {
    const ctx = await run("/foods")
    expect(ctx.reply.mock.calls[0][0]).toBe("No saved foods yet.")
  })

  test("/foods add with no text waits for a paste; a command stops waiting", async () => {
    const ctx = await run("/foods add")
    expect(ctx.reply).toHaveBeenCalledWith(PASTE_PROMPT, undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(true)
    stopAwaitingPaste(OWNER)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(false)
  })

  test("/foods add <text> goes straight to a preview, with nothing saved yet", async () => {
    const ctx = await run("/foods add Oats 1/2 cup 40g 150 kcal")
    expect(parseFoods).toHaveBeenCalledWith("Oats 1/2 cup 40g 150 kcal", "gemini", { telegramId: OWNER, chatId: 555 })
    expect(ctx.reply.mock.calls[0][0]).toStartWith("Found 2 foods (per serving):\n1. Quaker Oats")
    expect(buttons(ctx).map((b) => b.text)).toEqual(["Save 2", "Cancel"])
    expect(library.count(OWNER)).toBe(0)
  })
})

describe("paste → preview → Save", () => {
  test("Save writes the rows and reports foods_added", async () => {
    await run("/foods add")
    const preview = await send("Quaker Oats 150 kcal ...")
    const saved = await press(saveData(preview))

    expect(library.listByUser(OWNER).map((f) => f.name)).toEqual(["Quaker Oats", "Skyflakes"])
    expect(library.listByUser(OWNER)[0].source).toBe("import")
    expect(saved.editMessageText.mock.calls[0][0]).toBe("Saved 2 foods. You have 2 foods.")
    expect(analytics.events).toEqual([
      { telegramId: OWNER, event: "foods_added", properties: { count: 2, replaced: 0, source: "import" } },
    ])
  })

  test("a replacement is counted and said", async () => {
    library.upsertMany(OWNER, [{ ...(SKY_ROW as any) }], "import")
    const preview = await run("/foods add skyflakes")
    expect(preview.reply.mock.calls[0][0]).toContain("(replaces your saved one)")
    const saved = await press(saveData(preview))
    expect(saved.editMessageText.mock.calls[0][0]).toBe("Saved 2 foods (1 replaced). You have 2 foods.")
  })

  test("Cancel writes nothing", async () => {
    const preview = await run("/foods add x")
    const cancel = buttons(preview).find((b) => b.text === "Cancel")!.data!
    const ctx = await press(cancel)
    expect(library.count(OWNER)).toBe(0)
    expect(ctx.editMessageText.mock.calls[0][0]).toBe("Cancelled. Nothing saved.")
  })

  test("an old preview's Save is refused once a newer preview exists", async () => {
    const first = await run("/foods add x")
    parseFoods.mockImplementation(async () => ({ foods: [OATS_ROW], unreadable: [] }))
    await run("/foods add y")
    const ctx = await press(saveData(first))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(EXPIRED)
    expect(library.count(OWNER)).toBe(0)
  })

  test("someone else's press is refused", async () => {
    const preview = await run("/foods add x")
    const ctx = await press(saveData(preview), OTHER)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Only the person who started this can use these buttons.")
    expect(library.count(OWNER)).toBe(0)
    expect(library.count(OTHER)).toBe(0)
  })

  test("a failed parse says so and keeps nothing", async () => {
    parseFoods.mockImplementation(async () => {
      throw new Error("down")
    })
    await run("/foods add")
    const ctx = await send("anything")
    expect(ctx.reply).toHaveBeenCalledWith(PARSE_FAILED, undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(false)
  })

  test("nothing usable: says what a row needs and lists what it couldn't read", async () => {
    parseFoods.mockImplementation(async () => ({ foods: [], unreadable: [{ text: "lunch adobo", reason: "no calories" }] }))
    const ctx = await run("/foods add lunch adobo")
    expect(ctx.reply.mock.calls[0][0]).toBe(
      'I couldn\'t find any foods in that. Each one needs a name, a serving and calories.\nCouldn\'t read: "lunch adobo" (no calories)'
    )
  })

  test("cancel while waiting for a paste", async () => {
    await run("/foods add")
    const ctx = await send("cancel")
    expect(ctx.reply).toHaveBeenCalledWith("Cancelled.", undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(false)
  })

  test("the Add foods button waits for a paste", async () => {
    const ctx = await press(encodeFoodsCallback({ action: "add", ownerId: OWNER }))
    expect(ctx.reply).toHaveBeenCalledWith(PASTE_PROMPT, undefined)
    expect(isAwaitingFoodsPaste(OWNER)).toBe(true)
  })
})

test("parseFoodsCallback reads what the preview sends", async () => {
  const preview = await run("/foods add x")
  expect(parseFoodsCallback(saveData(preview))).toMatchObject({ action: "save", ownerId: OWNER })
})
