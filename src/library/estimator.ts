// src/library/estimator.ts
// Every meal estimate goes through here (LogFlow and the retry job). With the
// food library on, a meal made only of saved foods is built in code with no AI
// call; otherwise the AI sees the relevant saved foods and code applies their
// label values. The library can never break logging: any library error falls
// back to a plain AI estimate.
import type { AIService, EstimateOptions } from "../ai/service"
import type { EstimationResult, FoodEstimate } from "../ai/types"
import type { FoodLibraryRepository } from "../db/repositories/food-library"
import { noopAnalytics, type Analytics } from "../analytics"
import { MACROS } from "../macros"
import { candidatesFor, matchMeal, scaleFood, type MatchedItem } from "./match"
import type { SavedFood } from "./types"

export type EstimateSource = "library" | "mixed" | "ai" | "cache"
export type MealEstimate = EstimationResult & { source: EstimateSource }

export interface MealEstimatorDeps {
  /** FEATURE_LOCAL_FOOD_DB. Off: every estimate is a plain AIService call, as before. */
  enabled: boolean
  library: Pick<FoodLibraryRepository, "listByUser">
  ai: Pick<AIService, "estimate">
  /** The Analytics createBot returns, so the meal-text opt-out applies. */
  analytics?: Analytics
}

type Found = { matched: MatchedItem[] | null; candidates: SavedFood[] }
const NOTHING_FOUND: Found = { matched: null, candidates: [] }

function libraryResult(matched: MatchedItem[]): EstimationResult {
  return {
    items: matched.map((m) => scaleFood(m.food, m.servings)),
    needsClarification: false,
    confidence: "high",
  }
}

/**
 * Label values over the AI's numbers, for each item the AI tied to one of the
 * candidates; the AI's value stays where the label is blank. Anything else (no
 * id, an id we didn't send, servings that aren't positive) keeps the AI's
 * numbers. `servings` never leaves here.
 */
export function applyLabels(items: FoodEstimate[], candidates: SavedFood[]): FoodEstimate[] {
  const byId = new Map(candidates.map((f) => [f.id, f]))
  return items.map(({ servings, ...item }) => {
    const food = item.saved_food_id ? byId.get(item.saved_food_id) : undefined
    if (!food || typeof servings !== "number" || !(servings > 0)) return { ...item, saved_food_id: null }
    const scaled = scaleFood(food, servings)
    const out: FoodEstimate = { ...item, description: scaled.description, calories: scaled.calories, saved_food_id: food.id }
    for (const m of MACROS) out[m.column] = scaled[m.column] ?? item[m.column]
    return out
  })
}

export class MealEstimator {
  private analytics: Analytics

  constructor(private deps: MealEstimatorDeps) {
    this.analytics = deps.analytics ?? noopAnalytics
  }

  async estimate(text: string, provider: string, opts: EstimateOptions): Promise<MealEstimate> {
    const found = this.deps.enabled ? this.consultLibrary(text, opts) : NOTHING_FOUND
    if (found.matched) return this.finish(opts.telegramId, libraryResult(found.matched), "library")

    if (found.candidates.length === 0) {
      const result = await this.deps.ai.estimate(text, provider, opts)
      return this.finish(opts.telegramId, result, result.cached ? "cache" : "ai")
    }

    const result = await this.deps.ai.estimate(text, provider, { ...opts, savedFoods: found.candidates })
    const items = applyLabels(result.items, found.candidates)
    return this.finish(opts.telegramId, { ...result, items }, items.some((i) => i.saved_food_id) ? "mixed" : "ai")
  }

  /** Saved foods for this message. A clarification reply never takes the code-only path. */
  private consultLibrary(text: string, opts: EstimateOptions): Found {
    try {
      const foods = this.deps.library.listByUser(opts.telegramId)
      if (foods.length === 0) return NOTHING_FOUND
      const matched = opts.context ? null : matchMeal(text, foods)
      if (matched) return { matched, candidates: [] }
      // With context, the original message and earlier replies count too.
      return { matched: null, candidates: candidatesFor(`${text} ${opts.context ?? ""}`, foods) }
    } catch (error) {
      this.analytics.captureException(error, opts.telegramId, { source: "library" })
      return NOTHING_FOUND
    }
  }

  private finish(telegramId: number, result: EstimationResult, source: EstimateSource): MealEstimate {
    this.analytics.capture(telegramId, "meal_estimated", {
      source,
      saved_foods_used: result.items.filter((i) => i.saved_food_id).length,
      clarification: result.needsClarification,
    })
    return { ...result, source }
  }
}
