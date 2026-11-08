// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
//
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini>           # estimate()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --macros  # estimateMacros()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --foods   # parseFoods()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --saved   # estimate() with savedFoods
//
// With POSTHOG_API_KEY and POSTHOG_ID_SECRET set, the call is also sent to
// PostHog as $ai_generation (tagged environment=development unless
// POSTHOG_ENVIRONMENT says otherwise).
import { AIService } from "../src/ai/service"
import { createTestDb } from "../src/db/test-helpers"
import { CacheRepository } from "../src/db/repositories/cache"
import { UsageRepository } from "../src/db/repositories/usage"
import { createAnalytics } from "../src/analytics"
import { config } from "../src/config"
import { MACROS } from "../src/macros"
import type { SavedFood } from "../src/library/types"

const provider = process.argv[2]
const flag = process.argv[3]
const mode = flag === "--macros" ? "macros" : flag === "--foods" ? "foods" : flag === "--saved" ? "saved" : "estimate"
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--macros|--foods|--saved]")
  process.exit(1)
}

/** The saved food --saved sends; "80g oats" is 2 of its 40 g servings. */
const SAVED_OATS: SavedFood = {
  id: 1,
  telegram_id: 0,
  source: "import",
  name: "Quaker Oats",
  serving: "1/2 cup (40 g)",
  serving_amount: 40,
  serving_unit: "g",
  calories: 150,
  protein_g: 5,
  fat_g: 3,
  fiber_g: 4,
  added_sugar_g: null,
}

const db = createTestDb()
const analytics = createAnalytics(config.posthog)
const service = new AIService(new CacheRepository(db), new UsageRepository(db), analytics)

/** Flushes analytics before exiting, or the $ai_generation event is lost. */
async function finish(code: number): Promise<never> {
  await analytics.shutdown()
  if (config.posthog.apiKey) console.log(`Sent to PostHog (${config.posthog.environment}): check LLM analytics → Generations.`)
  process.exit(code)
}

if (!service.hasProvider(provider)) {
  console.error(`Provider "${provider}" is not configured. Check the API key in .env.`)
  process.exit(1)
}

try {
  if (mode === "foods") {
    const pasted =
      "Quaker Oats, 1/2 cup (40 g): 150 kcal, protein 5 g, fat 3 g, fiber 4 g\n" +
      "Nestle Fresh Milk per 1 cup (250 ml): 160 kcal, 8 g protein, 9 g fat, sugars 12 g\n" +
      "lunch adobo"
    const reply = await service.parseFoods(pasted, provider, { telegramId: 0, chatId: null })
    console.log(`✓ ${provider} responded to parseFoods`)
    console.log(JSON.stringify(reply, null, 2))
    console.log("  Check by eye: milk's added_sugar_g should be null (12 g is total sugars).")
    if (reply.foods.length !== 2) {
      console.error(`✗ Expected 2 foods, got ${reply.foods.length}.`)
      await finish(1)
    }
    await finish(0)
  }

  if (mode === "macros") {
    const descriptions = ["two scrambled eggs", "a slice of toast", "black coffee"]
    const values = await service.estimateMacros(descriptions, provider, { telegramId: 0, chatId: null })
    console.log(`✓ ${provider} responded to estimateMacros`)
    descriptions.forEach((d, i) =>
      console.log(`  ${d}: ${MACROS.map((m) => `${values[i][m.column] ?? "?"} g ${m.totalLabel}`).join(", ")}`)
    )
    if (values.some((row) => MACROS.some((m) => row[m.column] === null))) {
      console.error("✗ At least one description came back with a macro missing.")
      await finish(1)
    }
    await finish(0)
  }

  // --saved: the same call with a saved food, which switches OpenAI to its saved-foods schema.
  const saved = mode === "saved"
  const result = await service.estimate(saved ? "80g oats and a banana" : "two scrambled eggs and a slice of toast", provider, {
    telegramId: 0,
    chatId: null,
    callType: "estimate",
    ...(saved ? { savedFoods: [SAVED_OATS] } : {}),
  })
  console.log(`✓ ${provider} responded${saved ? " with saved foods" : ""}`)
  console.log(JSON.stringify(result, null, 2))
  if (result.items.length === 0 && !result.needsClarification) {
    console.error("✗ Empty items with no clarification request — the model replied, but not usefully.")
    await finish(1)
  }
  const missing = result.items.filter((item) => MACROS.some((m) => item[m.column] === null)).length
  if (missing > 0) {
    console.error(`✗ ${missing} item(s) came back with a macro missing.`)
    await finish(1)
  }
  if (saved) {
    // Reported, not required: which item the model ties to the food is its judgment.
    const tied = result.items.some((item) => item.saved_food_id === SAVED_OATS.id && item.servings === 2)
    console.log(
      tied
        ? "  An item carried saved_food_id 1 with servings 2."
        : "  No item carried saved_food_id 1 with servings 2: check the JSON above by eye."
    )
  }
  await finish(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error instanceof Error ? error.message : String(error))
  await finish(1)
}
