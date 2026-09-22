// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
import { AIService } from "../src/ai/service"
import { createTestDb } from "../src/db/test-helpers"
import { CacheRepository } from "../src/db/repositories/cache"
import { UsageRepository } from "../src/db/repositories/usage"

const provider = process.argv[2]
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini>")
  process.exit(1)
}

const db = createTestDb()
const service = new AIService(new CacheRepository(db), new UsageRepository(db))

if (!service.hasProvider(provider)) {
  console.error(`Provider "${provider}" is not configured. Check the API key in .env.`)
  process.exit(1)
}

try {
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
  process.exit(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error instanceof Error ? error.message : String(error))
  process.exit(1)
}
