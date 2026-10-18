# 1. PostHog for errors, AI calls and web analytics

Date: 2026-10-17
Status: Accepted

## Context

TeleCal has no telemetry beyond `console.*` on Railway and the `ai_usage` table behind `/admin usage`. Errors are only logged: `bot.catch` writes to the console, and there are no process-level handlers. AI latency is not measured at all. Since the landing page and access requests shipped, there is also a public funnel (visit → Request access → approval) that nothing measures.

The evaluation of every PostHog product is in #7. The decisions below came out of the grilling session in #8.

## Decision

Integrate PostHog Cloud (US) for four things, in this order:

1. **Error tracking.** `captureException` from `bot.catch`, `unhandledRejection`/`uncaughtException` handlers, the background jobs and the provider error paths. An email alert fires when a new kind of error appears.
2. **LLM analytics.** One `$ai_generation` event per billed AI call, sent by `AIService.recordSafely()` (manual capture, not PostHog's SDK wrappers). Providers return the prompt, the raw output and the latency with their usage.
3. **Landing page analytics.** `posthog-js` in cookieless mode on `/`: page views and Request access clicks. The bot adds server-side "access requested" and "access approved" events, so the funnel is counted in totals. Nobody is followed from the page into Telegram.
4. **Mini App analytics.** Page views and a few named events on `/app`, with no session replay.

Out: product analytics for the `/log` funnel, feature flags, session replay, experiments, surveys, Logs, the data warehouse and workflows. TeleCal stays allowlisted, with under 50 users expected in the next six months, so nothing statistical is worth building.

### Privacy line

- **Content may be sent.** `$ai_generation` events carry the full prompt and AI output, so food descriptions reach PostHog. Error reports may carry user text as well.
- **Identity is pseudonymous.** `distinct_id` is an HMAC-SHA256 of the Telegram ID keyed with `POSTHOG_ID_SECRET`. No usernames, names or other person properties are sent. The Mini App gets its hashed ID from the server after `initData` validation, because the browser never sees the secret.
- **Users are told first.** The README Privacy section, the landing page FAQ and `/start` are updated, and existing users get a one-time Telegram message, all before any user data is sent.
- **Deletion is manual.** On request, the admin deletes the person in PostHog, which deletes their events. The README documents the steps.
- **Opt-out for content.** Originally parked until a user asked; built in #18 (2026-10-19) at the owner's request. `/settings` → Meal Text Sharing turns off a user's prompts, AI replies and error messages; the numbers still go. It wraps the `Analytics` the bot uses (`src/analytics/content-preference.ts`), so no capture site checks it.

### Source of truth for AI cost

`ai_usage` stays the source of truth, and `/admin usage` stays. `$ai_generation` carries TeleCal's own `calculateCost()` result as `$ai_total_cost_usd`, so PostHog shows the same number rather than computing its own.

### Operations

- A $0 billing limit is set on every product, so going over the free tier stops ingestion instead of charging a card.
- Analytics does nothing unless `POSTHOG_API_KEY` is set, which covers tests and local dev. There is one PostHog project (the free tier allows only the default one), so every event carries `environment` (`production` on Railway, `development` otherwise) to keep test-bot events filterable.
- Capturing must never break calorie logging, the same rule `recordSafely()` already follows for `ai_usage`.
- SIGTERM, which Railway sends on every redeploy, flushes the event queue (`posthog.shutdown()`) before exit.

## Consequences

- PostHog becomes a fourth processor of food descriptions, alongside the user's chosen AI provider. The old promise that "nothing else about you is shared" is withdrawn. The rationale for OpenAI's `store: false` in CHANGELOG 0.2.0 no longer reads as a strict privacy requirement, though the setting itself stays.
- AI calls are recorded in two places. If PostHog and `ai_usage` disagree, `ai_usage` wins.
- Gemini stays on `@google/generative-ai`, because manual capture doesn't need PostHog's `@google/genai` wrapper.
- Error tracking ships after the privacy update, because error reports can contain user text.

## Alternatives considered

- **No content sent (tokens, cost and latency only).** Rejected: seeing the actual prompt and output is what makes debugging bad estimates possible.
- **PostHog SDK wrappers.** Rejected: two code paths, two event shapes, and a 2–3 day Gemini SDK migration.
- **Sentry for errors.** Rejected: running errors and AI calls in one tool is cheaper than running two.
- **Raw Telegram IDs as `distinct_id`.** Rejected: PostHog would hold an identifier that names the person.
