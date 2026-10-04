// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
//
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini>            # estimate()
//   bun run scripts/smoke-providers.ts <openai|anthropic|gemini> --protein  # estimateProtein()
import { AIService } from "../src/ai/service"
import { createTestDb } from "../src/db/test-helpers"
import { CacheRepository } from "../src/db/repositories/cache"
import { UsageRepository } from "../src/db/repositories/usage"

const provider = process.argv[2]
const mode = process.argv[3] === "--protein" ? "protein" : "estimate"
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini> [--protein]")
  process.exit(1)
}

const db = createTestDb()
const service = new AIService(new CacheRepository(db), new UsageRepository(db))

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
      process.exit(1)
    }
    process.exit(0)
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
    process.exit(1)
  }
  const missing = result.items.filter((item) => item.protein_g === null).length
  if (missing > 0) {
    console.error(`✗ ${missing} item(s) came back without protein_g.`)
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error instanceof Error ? error.message : String(error))
  process.exit(1)
}
