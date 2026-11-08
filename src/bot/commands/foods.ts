// src/bot/commands/foods.ts
// /foods: the hub, adding foods by paste or /foods add, and the preview every
// save goes through (nothing enters the library without a Save tap). Browsing,
// editing and deleting live in the Mini App's Foods tab. State is in memory,
// like /edit and /delete: a restart loses a preview and its Save says so.
// Telegram splits a paste over 4096 characters into several messages, so each
// message gets its own preview, and a short window after a paste takes the
// next chunks as pastes too.
import { Context, InlineKeyboard } from "grammy"
import type { AIService } from "../../ai/service"
import type { FoodLibraryRepository } from "../../db/repositories/food-library"
import type { FoodLogsRepository } from "../../db/repositories/food-logs"
import type { UsersRepository } from "../../db/repositories/users"
import type { Analytics } from "../../analytics"
import type { FoodSource } from "../../library/types"
import { formatPreview, importPreview, logPreview, type Preview } from "../../library/preview"
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
  /** The clock for the paste window; Date.now by default. */
  now?: () => number
}

export const NOT_AVAILABLE = "Saved foods aren't available yet."
export const PRIVATE_ONLY = "Open me in a private chat to manage your foods."
export const PASTE_PROMPT = "Paste one food or a whole table. Values per serving."
export const PARSE_FAILED = "Couldn't read that right now. Try again in a bit."
export const NOTHING_FOUND = "I couldn't find any foods in that. Each one needs a name, a serving and calories."
export const EXPIRED = "This preview expired, paste again."
const NOT_OWNER = "Only the person who started this can use these buttons."

/** After a paste, further messages this soon are taken as more chunks of it. */
export const PASTE_WINDOW_MS = 10_000
/** Previews kept per user; a newer one drops the oldest. */
export const MAX_PREVIEWS = 5

type PreviewState = { source: FoodSource; preview: Preview; on: boolean[]; token: string }
type FoodsState = {
  /** Text is a paste until this time; Infinity while waiting for the first paste, null when not waiting. */
  pasteUntil: number | null
  /** Open previews by token, oldest first. */
  previews: Map<string, PreviewState>
}

const foodsStates = new Map<number, FoodsState>()

function stateOf(userId: number): FoodsState {
  let state = foodsStates.get(userId)
  if (!state) {
    state = { pasteUntil: null, previews: new Map() }
    foodsStates.set(userId, state)
  }
  return state
}

/** Drops a user's entry once it holds nothing. */
function tidy(userId: number): void {
  const state = foodsStates.get(userId)
  if (state && state.pasteUntil === null && state.previews.size === 0) foodsStates.delete(userId)
}

function setPasteUntil(userId: number, until: number | null): void {
  stateOf(userId).pasteUntil = until
  tidy(userId)
}

/** Whether this user's next text is a paste. `now` is FoodsDeps.now's time; Date.now by default. */
export function isAwaitingFoodsPaste(userId: number, now: number = Date.now()): boolean {
  const until = foodsStates.get(userId)?.pasteUntil ?? null
  return until !== null && now <= until
}

/** Any command stops waiting for a paste (src/bot/index.ts calls this for every command). */
export function stopAwaitingPaste(userId: number): void {
  if (foodsStates.has(userId)) setPasteUntil(userId, null)
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
    source,
    preview,
    on: preview.rows.map(() => true),
    token: shortHash(JSON.stringify(preview.rows)),
  }
  const { previews } = stateOf(ownerId)
  // The same rows again replace their earlier preview and count as the newest.
  previews.delete(state.token)
  previews.set(state.token, state)
  for (const token of previews.keys()) {
    if (previews.size <= MAX_PREVIEWS) break
    previews.delete(token)
  }
  await smartReply(ctx, formatPreview(previewHeader(source, preview.rows.length), preview), {
    reply_markup: previewKeyboard(ownerId, state),
  })
}

function clock(deps: FoodsDeps): number {
  return (deps.now ?? Date.now)()
}

/**
 * One message's text → a preview. A paste ("import") then keeps the paste
 * window open a little longer for the next chunk of a long paste; /foods add
 * <text> ("single") never starts waiting for a paste.
 */
async function runImport(ctx: Context, deps: FoodsDeps, userId: number, text: string, source: "import" | "single"): Promise<void> {
  const provider = deps.users.findById(userId)?.ai_provider ?? "openai"
  let reply
  try {
    reply = await deps.ai.parseFoods(text, provider, { telegramId: userId, chatId: ctx.chat?.id ?? null })
  } catch {
    // AIService has already recorded and reported the failure.
    setPasteUntil(userId, null)
    await smartReply(ctx, PARSE_FAILED)
    return
  }

  const preview = importPreview(reply, deps.library.listByUser(userId))
  if (source === "import") setPasteUntil(userId, clock(deps) + PASTE_WINDOW_MS)
  if (preview.rows.length === 0) {
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
        setPasteUntil(userId, Infinity)
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
    if (!userId || !text || !isAwaitingFoodsPaste(userId, clock(deps))) return

    if (text.startsWith("/")) {
      stopAwaitingPaste(userId)
      return
    }
    if (text.toLowerCase() === "cancel") {
      stopAwaitingPaste(userId)
      return smartReply(ctx, "Cancelled.")
    }
    await runImport(ctx, deps, userId, text, "import")
  }
}

/** The preview whose buttons carry this token, if it is still open. */
function currentPreview(userId: number, token: string): PreviewState | null {
  return foodsStates.get(userId)?.previews.get(token) ?? null
}

function closePreview(userId: number, token: string): void {
  foodsStates.get(userId)?.previews.delete(token)
  tidy(userId)
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
  closePreview(userId, token)
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
        setPasteUntil(presserId, Infinity)
        await answerCallback(ctx)
        await smartReply(ctx, PASTE_PROMPT)
        return
      case "cxl": {
        if (!currentPreview(presserId, parsed.token)) return expired(ctx)
        closePreview(presserId, parsed.token)
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
        return offerLog(ctx, deps, presserId, parsed.logId)
    }
  }
}

async function offerLog(ctx: Context, deps: FoodsDeps, userId: number, logId: number): Promise<void> {
  const items = deps.foodLogs.getItemsByLog(userId, logId)
  if (!items) {
    await answerCallback(ctx, "That entry is no longer there.")
    await stripKeyboard(ctx)
    return
  }
  const preview = logPreview(items, deps.library.listByUser(userId))
  if (preview.rows.length === 0) {
    await answerCallback(ctx, preview.unreadable.length > 0 ? "Couldn't read those items." : "These are already in your foods.")
    return
  }
  await answerCallback(ctx)
  await showPreview(ctx, userId, "log", preview)
}
