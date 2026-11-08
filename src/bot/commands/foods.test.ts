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
  PASTE_WINDOW_MS,
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
/** The handlers' clock (FoodsDeps.now); tests move it forward. */
let clock: number

beforeEach(() => {
  resetFoodsStates()
  clock = 1_000_000
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
    now: () => clock,
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

  test("an old preview's Save still works after a newer preview", async () => {
    parseFoods.mockImplementation(async () => ({ foods: [OATS_ROW], unreadable: [] }))
    const first = await run("/foods add x")
    parseFoods.mockImplementation(async () => ({ foods: [SKY_ROW], unreadable: [] }))
    const second = await run("/foods add y")
    await press(saveData(first))
    expect(library.listByUser(OWNER).map((f) => f.name)).toEqual(["Quaker Oats"])
    await press(saveData(second))
    expect(library.listByUser(OWNER).map((f) => f.name)).toEqual(["Quaker Oats", "Skyflakes"])
  })

  test("a token from a Cancelled preview is refused", async () => {
    const preview = await run("/foods add x")
    await press(buttons(preview).find((b) => b.text === "Cancel")!.data!)
    const ctx = await press(saveData(preview))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(EXPIRED)
    expect(library.count(OWNER)).toBe(0)
  })

  test("only the newest five previews are kept", async () => {
    const previews = []
    for (let i = 0; i < 6; i++) {
      parseFoods.mockImplementation(async () => ({ foods: [{ ...OATS_ROW, name: `Food ${i}` }], unreadable: [] }))
      previews.push(await run(`/foods add food ${i}`))
    }
    const oldest = await press(saveData(previews[0]))
    expect(oldest.answerCallbackQuery).toHaveBeenCalledWith(EXPIRED)
    await press(saveData(previews[1]))
    expect(library.listByUser(OWNER).map((f) => f.name)).toEqual(["Food 1"])
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

  test("a long paste split into two messages: each gets its own preview and both Saves work", async () => {
    await run("/foods add")
    parseFoods.mockImplementation(async () => ({ foods: [OATS_ROW], unreadable: [] }))
    const first = await send("first half of the table")
    expect(isAwaitingFoodsPaste(OWNER, clock)).toBe(true)
    parseFoods.mockImplementation(async () => ({ foods: [SKY_ROW], unreadable: [] }))
    const second = await send("second half of the table")
    expect(parseFoods).toHaveBeenCalledTimes(2)

    await press(saveData(first))
    await press(saveData(second))
    expect(library.listByUser(OWNER).map((f) => f.name)).toEqual(["Quaker Oats", "Skyflakes"])
  })

  test("a text sent after the paste window has passed is not taken as a paste", async () => {
    await run("/foods add")
    await send("the table")
    clock += PASTE_WINDOW_MS
    expect(isAwaitingFoodsPaste(OWNER, clock)).toBe(true)
    clock += 1
    expect(isAwaitingFoodsPaste(OWNER, clock)).toBe(false)
    await send("2 eggs")
    expect(parseFoods).toHaveBeenCalledTimes(1)
  })

  test("waiting for the first paste has no time limit; /foods add <text> doesn't start waiting", async () => {
    await run("/foods add")
    clock += 24 * 60 * 60 * 1000
    expect(isAwaitingFoodsPaste(OWNER, clock)).toBe(true)
    stopAwaitingPaste(OWNER)
    await run("/foods add oats 150 kcal")
    expect(isAwaitingFoodsPaste(OWNER, clock)).toBe(false)
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

describe("save from a log", () => {
  function logged(items: Parameters<FoodLogsRepository["create"]>[3], owner = OWNER) {
    return foodLogs.create(owner, 555, "2026-11-08", items)
  }

  /** A saved Quaker Oats, as a log item made from it would point at. */
  function savedOatsId(): number {
    library.upsertMany(OWNER, [{ ...(OATS_ROW as any) }], "import")
    return library.listByUser(OWNER)[0].id
  }

  test("previews the log's items with toggles, leaving out items from saved foods; Save stores only the ones on", async () => {
    const log = logged([
      { description: "Chicken adobo (1 cup)", calories: 350, protein_g: 30, emoji: "🍗" },
      { description: "Garlic rice (1 cup)", calories: 300, protein_g: 5, emoji: "🍚" },
      { description: "Quaker Oats ×2", calories: 300, protein_g: 10, saved_food_id: savedOatsId() },
    ])
    const ctx = await press(encodeFoodsCallback({ action: "log", ownerId: OWNER, logId: log.id }))

    expect(ctx.reply.mock.calls[0][0]).toStartWith("Save to your foods? Values are per serving, as logged.\n1. Chicken adobo (1 cup)")
    expect(ctx.reply.mock.calls[0][0]).not.toContain("Quaker Oats")
    expect(buttons(ctx).map((b) => b.text)).toEqual(["1 ✓", "2 ✓", "Save 2", "Cancel"])

    const toggle = buttons(ctx).find((b) => b.text === "2 ✓")!.data!
    const toggled = await press(toggle)
    const markup = (toggled.editMessageReplyMarkup.mock.calls[0][0] as any).reply_markup.inline_keyboard.flat()
    expect(markup.map((b: any) => b.text)).toEqual(["1 ✓", "2", "Save 1", "Cancel"])

    await press(saveData(ctx))
    const saved = library.listByUser(OWNER)
    expect(saved.map((f) => [f.name, f.serving, f.source])).toEqual([
      ["Chicken adobo (1 cup)", "as logged", "log"],
      ["Quaker Oats", "1/2 cup (40 g)", "import"],
    ])
  })

  test("a log made only of saved foods: says so", async () => {
    const log = logged([{ description: "Quaker Oats ×2", calories: 300, saved_food_id: savedOatsId() }])
    const ctx = await press(encodeFoodsCallback({ action: "log", ownerId: OWNER, logId: log.id }))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("These are already in your foods.")
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  test("someone else's log shows nothing", async () => {
    const log = logged([{ description: "Banana", calories: 105 }], OTHER)
    const ctx = await press(encodeFoodsCallback({ action: "log", ownerId: OWNER, logId: log.id }))
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("That entry is no longer there.")
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
