// src/web/api.ts
// Every change here is additive: Telegram webviews cache app.html, so a stale
// page must keep working against this server. Never rename or reshape a field.
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository, FoodLog } from "../db/repositories/food-logs"
import { getTodayInTimezone, getDateRangeInTimezone, DEFAULT_TIMEZONE } from "../utils/dates"
import { sumTotals } from "../utils/format"
import { hashTelegramId } from "../analytics"
import { MACROS, DEFAULT_MACROS, macroValuesOf, type MacroKey } from "../macros"
import type { FoodLibraryRepository } from "../db/repositories/food-library"
import { validateFood } from "../library/validate"
import type { SavedFood } from "../library/types"

export interface ApiDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
  /** POSTHOG_ID_SECRET, only when analytics is on. Server-side only: the browser gets the hash. */
  analyticsIdSecret?: string
  /** The food library (Foods tab); its routes 404 unless foodLibraryEnabled. */
  foodLibrary?: FoodLibraryRepository
  /** FEATURE_LOCAL_FOOD_DB */
  foodLibraryEnabled?: boolean
}

export type ApiResult = { status: number; body: unknown }
export const MAX_DELETE_IDS = 500

/** The fields a PATCH may change. Anything else in the body is ignored. */
const FOOD_FIELDS = ["name", "serving", "serving_amount", "serving_unit", "calories", ...MACROS.map((m) => m.column)]
const NOT_FOUND: ApiResult = { status: 404, body: { error: "Not found" } }

function foodPayload(food: SavedFood) {
  return {
    id: food.id,
    name: food.name,
    serving: food.serving,
    serving_amount: food.serving_amount,
    serving_unit: food.serving_unit,
    calories: food.calories,
    ...macroValuesOf(food),
  }
}

function dayPayload(date: string, entries: FoodLog[]) {
  const items = entries.flatMap((log) =>
    log.items.map((item) => ({
      id: item.id,
      description: item.description,
      calories: item.calories,
      ...macroValuesOf(item),
      emoji: item.emoji,
    }))
  )
  const { calories, ...macros } = sumTotals(items)
  return { date, total: calories, protein: macros.protein, macros, items }
}

export function createApiHandlers(deps: ApiDeps) {
  const { usersRepo, foodLogsRepo, analyticsIdSecret } = deps
  const library = deps.foodLibraryEnabled && deps.foodLibrary ? deps.foodLibrary : null

  return {
    /** Whether /api/foods is served; when false, every /api/foods path is a 404. */
    foodsEnabled: library !== null,

    getUser(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      return {
        daily_goal: user?.daily_goal ?? null,
        daily_protein_goal: user?.daily_protein_goal ?? null,
        // Registry order. A Telegram-cached page that predates this ignores it.
        tracked_macros: user?.tracked_macros ?? [...DEFAULT_MACROS],
        username: user?.username ?? null,
        // The same distinct ID as this user's server-side events; null means no analytics.
        analytics_id: analyticsIdSecret ? hashTelegramId(telegramId, analyticsIdSecret) : null,
        // Shows the Foods tab. A Telegram-cached page that predates this ignores it.
        food_library: library !== null,
      }
    },

    getToday(telegramId: number) {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      return dayPayload(today, foodLogsRepo.getByDate(telegramId, today))
    },

    getStats(telegramId: number, period: "week" | "month") {
      const user = usersRepo.findById(telegramId)
      const timezone = user?.timezone ?? DEFAULT_TIMEZONE
      const today = getTodayInTimezone(timezone)
      const days = period === "week" ? 7 : 30
      const dateRange = getDateRangeInTimezone(days, today, timezone)
      const startDate = dateRange[0]
      const endDate = dateRange[dateRange.length - 1]

      const dailyTotals = foodLogsRepo.getDailyTotals(telegramId, startDate, endDate)

      // Fill in missing days with 0
      const daily: Record<string, number> = {}
      const dailyProtein: Record<string, number> = {}
      const dailyMacros = Object.fromEntries(MACROS.map((m) => [m.key, {}])) as Record<MacroKey, Record<string, number>>
      for (const date of dateRange) {
        const day = dailyTotals[date]
        daily[date] = day?.calories ?? 0
        dailyProtein[date] = day?.protein ?? 0
        for (const m of MACROS) dailyMacros[m.key][date] = day?.[m.key] ?? 0
      }

      return {
        start: startDate,
        end: endDate,
        daily,
        dailyProtein,
        dailyMacros,
      }
    },

    getDay(telegramId: number, date: string) {
      return dayPayload(date, foodLogsRepo.getByDate(telegramId, date))
    },

    listFoods(telegramId: number): ApiResult {
      if (!library) return NOT_FOUND
      return { status: 200, body: { foods: library.listByUser(telegramId).map(foodPayload) } }
    },

    updateFood(telegramId: number, id: number, patch: unknown): ApiResult {
      if (!library) return NOT_FOUND
      const existing = library.get(telegramId, id)
      if (!existing) return NOT_FOUND
      if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
        return { status: 400, body: { error: "Expected a JSON object" } }
      }
      const merged: Record<string, unknown> = { ...foodPayload(existing) }
      for (const key of FOOD_FIELDS) if (key in patch) merged[key] = (patch as Record<string, unknown>)[key]
      const result = validateFood(merged)
      if (!result.ok) return { status: 400, body: { error: result.reason } }
      const outcome = library.update(telegramId, id, result.food)
      if (outcome === "not_found") return NOT_FOUND
      if (outcome === "name_taken") {
        return { status: 409, body: { error: `You already have a food called ${result.food.name}` } }
      }
      return { status: 200, body: { food: foodPayload(library.get(telegramId, id)!) } }
    },

    deleteFoods(telegramId: number, body: unknown): ApiResult {
      if (!library) return NOT_FOUND
      const ids = typeof body === "object" && body !== null ? (body as { ids?: unknown }).ids : undefined
      const valid =
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= MAX_DELETE_IDS &&
        ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
      if (!valid) return { status: 400, body: { error: `Expected ids: 1 to ${MAX_DELETE_IDS} food ids` } }
      const deleted = library.deleteMany(telegramId, ids as number[])
      if (deleted === "not_found") return NOT_FOUND
      return { status: 200, body: { deleted } }
    },
  }
}
