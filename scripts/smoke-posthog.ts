// scripts/smoke-posthog.ts
// Development tool: sends one test exception to PostHog through the real
// analytics module, to confirm the key, host and error tracking work. Not part
// of the app.
//
//   POSTHOG_API_KEY=phc_... POSTHOG_ID_SECRET=any-local-secret bun run scripts/smoke-posthog.ts
//
// Leave POSTHOG_ENVIRONMENT unset so the event is tagged "development".
import { config } from "../src/config"
import { createAnalytics } from "../src/analytics"

if (!config.posthog.apiKey) {
  console.error("POSTHOG_API_KEY is not set. Pass it (and POSTHOG_ID_SECRET) on the command line or in .env.")
  process.exit(1)
}

const analytics = createAnalytics(config.posthog)
const marker = `PostHog smoke test ${new Date().toISOString()}`
analytics.captureException(new Error(marker), undefined, { source: "smoke-test" })
await analytics.shutdown()

console.log(`Sent "${marker}" to ${config.posthog.host} (environment: ${config.posthog.environment}).`)
console.log("In PostHog, open Error tracking and look for it; it can take a minute to appear.")
