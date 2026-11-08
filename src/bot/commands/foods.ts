// src/bot/commands/foods.ts
// /foods: the hub, adding foods by paste or /foods add, and the preview every
// save goes through (nothing enters the library without a Save tap). Browsing,
// editing and deleting live in the Mini App's Foods tab. State is in memory,
// like /edit and /delete: a restart loses a preview and its Save says so.
import { Context, InlineKeyboard } from "grammy"
import type { AIService } from "../../ai/service"
import type { FoodLibraryRepository } from "../../db/repositories/food-library"
import type { FoodLogsRepository } from "../../db/repositories/food-logs"
import type { UsersRepository } from "../../db/repositories/users"
import type { Analytics } from "../../analytics"
import type { FoodSource } from "../../library/types"
import { formatPreview, importPreview, type Preview } from "../../library/preview"
import { shortHash } from "../../utils/format"
import { encodeFoodsCallback, parseFoodsCallback } from "../utils/callback-data"
import { answerCallback, stripKeyboard } from "../utils/keyboard"
import { smartEdit, smartReply } from "../utils/smart-reply"

export interface FoodsDeps {
  /** FEATURE_LOCAL_FOOD_DB */
  enabled: boolean
  library: FoodLibraryRepository
  foodLogs: Pick<FoodLogsRepository, "getItemsByLog">
  ai: Pick<AIService, "parseFoods">
  users: Pick<UsersRepository, "findById">
  /** The Analytics createBot returns. */
  analytics: Analytics
  /** config.web.miniAppUrl */
  miniAppUrl: string
}

export const NOT_AVAILABLE = "Saved foods aren't available yet."
export const PRIVATE_ONLY = "Open me in a private chat to manage your foods."
export const PASTE_PROMPT = "Paste one food or a whole table. Values per serving."
export const PARSE_FAILED = "Couldn't read that right now. Try again in a bit."
export const NOTHING_FOUND = "I couldn't find any foods in that. Each one needs a name, a serving and calories."
export const EXPIRED = "This preview expired, paste again."
const NOT_OWNER = "Only the person who started this can use these buttons."

type PreviewState = { mode: "preview"; source: FoodSource; preview: Preview; on: boolean[]; token: string }
type FoodsState = { mode: "awaiting_paste" } | PreviewState

const foodsStates = new Map<number, FoodsState>()

export function isAwaitingFoodsPaste(userId: number): boolean {
  return foodsStates.get(userId)?.mode === "awaiting_paste"
}

/** Any command stops waiting for a paste (src/bot/index.ts calls this for every command). */
export function stopAwaitingPaste(userId: number): void {
  if (isAwaitingFoodsPaste(userId)) foodsStates.delete(userId)
}

/** Test-only. */
export function resetFoodsStates(): void {
  foodsStates.clear()
}

function isGroup(ctx: Context): boolean {
  const type = ctx.chat?.type
  return type === "group" || type === "supergroup"
}

function plural(n: number): string {
  return n === 1 ? "food" : "foods"
}

function foodsUrl(deps: FoodsDeps): string {
  return `${deps.miniAppUrl}?tab=foods`
}

function previewHeader(source: FoodSource, rows: number): string {
  return source === "log"
    ? "Save to your foods? Values are per serving, as logged."
    : `Found ${rows} ${plural(rows)} (per serving):`
}

function previewKeyboard(ownerId: number, state: PreviewState): InlineKeyboard {
  const keyboard = new InlineKeyboard()
  if (state.source === "log") {
    state.on.forEach((on, index) => {
      keyboard.text(on ? `${index + 1} ✓` : `${index + 1}`, encodeFoodsCallback({ action: "tog", ownerId, index, token: state.token }))
      if ((index + 1) % 8 === 0) keyboard.row()
    })
    keyboard.row()
  }
  const count = state.on.filter(Boolean).length
  return keyboard
    .text(`Save ${count}`, encodeFoodsCallback({ action: "save", ownerId, token: state.token }))
    .text("Cancel", encodeFoodsCallback({ action: "cxl", ownerId, token: state.token }))
}

/** Shows a preview and remembers it; its buttons carry a fingerprint of the rows it showed. */
export async function showPreview(ctx: Context, ownerId: number, source: FoodSource, preview: Preview): Promise<void> {
  const state: PreviewState = {
    mode: "preview",
    source,
    preview,
    on: preview.rows.map(() => true),
    token: shortHash(JSON.stringify(preview.rows)),
  }
  foodsStates.set(ownerId, state)
  await smartReply(ctx, formatPreview(previewHeader(source, preview.rows.length), preview), {
    reply_markup: previewKeyboard(ownerId, state),
  })
}

async function runImport(ctx: Context, deps: FoodsDeps, userId: number, text: string, source: "import" | "single"): Promise<void> {
  const provider = deps.users.findById(userId)?.ai_provider ?? "openai"
  let reply
  try {
    reply = await deps.ai.parseFoods(text, provider, { telegramId: userId, chatId: ctx.chat?.id ?? null })
  } catch {
    // AIService has already recorded and reported the failure.
    foodsStates.delete(userId)
    await smartReply(ctx, PARSE_FAILED)
    return
  }

  const preview = importPreview(reply, deps.library.listByUser(userId))
  if (preview.rows.length === 0) {
    foodsStates.delete(userId)
    await smartReply(ctx, `${NOTHING_FOUND}${formatPreview("", preview)}`.trimEnd())
    return
  }
  await showPreview(ctx, userId, source, preview)
}

export function createFoodsCommand(deps: FoodsDeps) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    if (!userId) return
    if (!deps.enabled) return smartReply(ctx, NOT_AVAILABLE)
    if (isGroup(ctx)) return smartReply(ctx, PRIVATE_ONLY)

    // Everything after "/foods" or "/foods@Bot", line breaks included.
    const args = (ctx.message?.text ?? "").replace(/^\/\S+\s*/, "")
    const add = args.match(/^add\b\s*([\s\S]*)$/i)
    if (add) {
      const text = add[1].trim()
      if (!text) {
        foodsStates.set(userId, { mode: "awaiting_paste" })
        return smartReply(ctx, PASTE_PROMPT)
      }
      return runImport(ctx, deps, userId, text, "single")
    }

    const count = deps.library.count(userId)
    const keyboard = new InlineKeyboard()
      .text("Add foods", encodeFoodsCallback({ action: "add", ownerId: userId }))
      .webApp("Open my foods", foodsUrl(deps))
    await smartReply(ctx, count === 0 ? "No saved foods yet." : `You have ${count} ${plural(count)} saved.`, {
      reply_markup: keyboard,
    })
  }
}

export function createFoodsMessageHandler(deps: FoodsDeps) {
  return async (ctx: Context) => {
    const userId = ctx.from?.id
    const text = ctx.message?.text?.trim()
    if (!userId || !text || !isAwaitingFoodsPaste(userId)) return

    if (text.startsWith("/")) {
      foodsStates.delete(userId)
      return
    }
    if (text.toLowerCase() === "cancel") {
      foodsStates.delete(userId)
      return smartReply(ctx, "Cancelled.")
    }
    await runImport(ctx, deps, userId, text, "import")
  }
}

function currentPreview(userId: number, token: string): PreviewState | null {
  const state = foodsStates.get(userId)
  return state?.mode === "preview" && state.token === token ? state : null
}

async function expired(ctx: Context): Promise<void> {
  await answerCallback(ctx, EXPIRED)
  await stripKeyboard(ctx)
}

async function editOrReply(ctx: Context, text: string, options?: Parameters<Context["editMessageText"]>[1]): Promise<void> {
  try {
    await smartEdit(ctx, text, options)
  } catch (error) {
    console.error("Failed to edit foods message:", error)
    await smartReply(ctx, text, options as Parameters<Context["reply"]>[1])
  }
}

async function save(ctx: Context, deps: FoodsDeps, userId: number, token: string): Promise<void> {
  const state = currentPreview(userId, token)
  if (!state) return expired(ctx)

  const foods = state.preview.rows.filter((_, i) => state.on[i]).map((row) => row.food)
  if (foods.length === 0) {
    await answerCallback(ctx, "Nothing selected.")
    return
  }

  const { added, replaced } = deps.library.upsertMany(userId, foods, state.source)
  foodsStates.delete(userId)
  deps.analytics.capture(userId, "foods_added", { count: added + replaced, replaced, source: state.source })

  await answerCallback(ctx, "Saved")
  const total = deps.library.count(userId)
  const text =
    `Saved ${foods.length} ${plural(foods.length)}${replaced ? ` (${replaced} replaced)` : ""}. ` +
    `You have ${total} ${plural(total)}.`
  // Telegram refuses web_app buttons in groups.
  await editOrReply(ctx, text, isGroup(ctx) ? undefined : { reply_markup: new InlineKeyboard().webApp("Open my foods", foodsUrl(deps)) })
}

export function createFoodsCallbackHandler(deps: FoodsDeps) {
  return async (ctx: Context) => {
    const presserId = ctx.from?.id
    const parsed = parseFoodsCallback(ctx.callbackQuery?.data ?? "")
    if (!presserId || !parsed || !deps.enabled) {
      await answerCallback(ctx, "That button has expired.")
      await stripKeyboard(ctx)
      return
    }
    // Owner check first, so a non-owner learns nothing about the owner's state.
    if (parsed.ownerId !== presserId) {
      await answerCallback(ctx, NOT_OWNER)
      return
    }

    switch (parsed.action) {
      case "add":
        foodsStates.set(presserId, { mode: "awaiting_paste" })
        await answerCallback(ctx)
        await smartReply(ctx, PASTE_PROMPT)
        return
      case "cxl": {
        if (!currentPreview(presserId, parsed.token)) return expired(ctx)
        foodsStates.delete(presserId)
        await answerCallback(ctx, "Cancelled")
        await editOrReply(ctx, "Cancelled. Nothing saved.")
        return
      }
      case "tog": {
        const state = currentPreview(presserId, parsed.token)
        if (!state || parsed.index >= state.on.length) return expired(ctx)
        state.on[parsed.index] = !state.on[parsed.index]
        await answerCallback(ctx)
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: previewKeyboard(presserId, state) })
        } catch (error) {
          console.error("Failed to update foods preview keyboard:", error)
        }
        return
      }
      case "save":
        return save(ctx, deps, presserId, parsed.token)
      case "log":
        // Save from a log: Task 10.
        return expired(ctx)
    }
  }
}
