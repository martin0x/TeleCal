// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
//
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini>            # estimate()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --protein  # estimateProtein()
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

const provider = process.argv[2]
const mode = process.argv[3] === "--protein" ? "protein" : "estimate"
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--protein]")
  process.exit(1)
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
  if (mode === "protein") {
    const descriptions = ["two scrambled eggs", "a slice of toast", "black coffee"]
    const protein = await service.estimateProtein(descriptions, provider, { telegramId: 0, chatId: null })
    console.log(`✓ ${provider} responded to estimateProtein`)
    descriptions.forEach((d, i) => console.log(`  ${d}: ${protein[i] ?? "?"} g`))
    if (protein.some((p) => p === null)) {
      console.error("✗ At least one description came back without protein.")
      await finish(1)
    }
    await finish(0)
  }

  const result = await service.estimate("two scrambled eggs and a slice of toast", provider, {
    telegramId: 0,
    chatId: null,
    callType: "estimate",
  })
  console.log(`✓ ${provider} responded`)
  console.log(JSON.stringify(result, null, 2))
  if (result.items.length === 0 && !result.needsClarification) {
    console.error("✗ Empty items with no clarification request — the model replied, but not usefully.")
    await finish(1)
  }
  const missing = result.items.filter((item) => item.protein_g === null).length
  if (missing > 0) {
    console.error(`✗ ${missing} item(s) came back without protein_g.`)
    await finish(1)
  }
  await finish(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error instanceof Error ? error.message : String(error))
  await finish(1)
}
