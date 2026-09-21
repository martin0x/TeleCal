# SDK & Model Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all three AI providers onto current, non-deprecated models and SDKs, so that cost tracking built afterwards measures a code path that actually runs.

**Architecture:** Purely mechanical changes to three provider files, `package.json`, and one schema default. No interface changes, no new abstractions. Each change is verified by a live smoke call against the real provider API, because this repo has no provider tests and the failure mode we are guarding against (a rejected model id or parameter) only appears at runtime.

**Tech Stack:** Bun, TypeScript, `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`

**Spec:** `docs/superpowers/specs/2026-09-20-ai-usage-tracking-design.md` (see "Branch 1 — `chore/sdk-and-model-refresh`")

## Global Constraints

- Branch name: `chore/sdk-and-model-refresh`, cut from `main`.
- **`node_modules` has never existed in this repo.** `bun install` must run before anything else; no claim about test results is valid before Task 1 completes.
- Do **not** bump the `openai` package in this plan. That bump belongs to the Responses API branch.
- Model ids are exact strings, verified 2026-09-20. Use them verbatim:
  - OpenAI: `gpt-5.6-luna`
  - Anthropic: `claude-haiku-4-5-20251001` (unchanged)
  - Gemini: `gemini-3.1-flash-lite`
- All three providers' docs recommend pinned ids over floating aliases. Never introduce a `-latest` suffix.
- Requires real API keys in `.env` for the smoke verification steps. If a key is unavailable for a given provider, mark that task blocked and report it — do **not** skip verification silently.

---

### Task 1: Install dependencies and establish a test baseline

Nothing in this repo has ever been installed. Until this task is done, "the tests pass" is an unverifiable claim.

**Files:**
- Modify: `bun.lock` (only if install changes it)

**Interfaces:**
- Consumes: nothing
- Produces: a working `bun test` command for every later task

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git pull
git checkout -b chore/sdk-and-model-refresh
```

- [ ] **Step 2: Install dependencies**

```bash
bun install
```

Expected: `node_modules/` is created. Note whether `bun.lock` changed.

- [ ] **Step 3: Run the existing test suite and record the result**

```bash
bun test
```

Expected: 10 test files run. Record the exact pass/fail count in your report. If anything fails, **stop and report it** — a pre-existing failure must be understood before you change models, or you will not be able to tell your changes apart from it.

- [ ] **Step 4: Commit only if the lockfile moved**

```bash
git status --porcelain bun.lock
# If bun.lock is modified:
git add bun.lock
git commit -m "chore: refresh lockfile after first install"
```

If `bun.lock` is unchanged, skip the commit. There is nothing to record.

---

### Task 2: Create a provider smoke-test script

The three provider files have zero test coverage, and the failures this branch guards against (a rejected model id, a rejected `temperature`) happen only against the live API. This script is the verification harness for Tasks 3–6. It is a throwaway development tool, not shipped code.

**Files:**
- Create: `scripts/smoke-providers.ts`

**Interfaces:**
- Consumes: `AIService` from `src/ai/service.ts` (current signature: `estimate(food, providerName?, context?)`)
- Produces: `bun run scripts/smoke-providers.ts <provider>` — exits 0 on success, prints the estimate and exits 1 on failure

- [ ] **Step 1: Write the script**

```typescript
// scripts/smoke-providers.ts
// Development tool: makes one real API call per provider to verify the
// configured model id and parameters are accepted. Not part of the app.
import { Database } from "bun:sqlite"
import { AIService } from "../src/ai/service"

const provider = process.argv[2]
if (!provider) {
  console.error("Usage: bun run scripts/smoke-providers.ts <openai|anthropic|gemini>")
  process.exit(1)
}

const db = new Database(":memory:")
db.run(`
  CREATE TABLE estimation_cache (
    normalized_food TEXT PRIMARY KEY,
    result_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`)

const service = new AIService(db)

if (!service.hasProvider(provider)) {
  console.error(`Provider "${provider}" is not configured. Check the API key in .env.`)
  process.exit(1)
}

try {
  const result = await service.estimate("two scrambled eggs and a slice of toast", provider)
  console.log(`✓ ${provider} responded`)
  console.log(JSON.stringify(result, null, 2))
  if (result.items.length === 0 && !result.needsClarification) {
    console.error("✗ Empty items with no clarification request — the model replied, but not usefully.")
    process.exit(1)
  }
  process.exit(0)
} catch (error) {
  console.error(`✗ ${provider} failed:`, error)
  process.exit(1)
}
```

Note the inline `CREATE TABLE` rather than reading `schema.sql`: this script must keep working during Task 6, which edits `schema.sql`.

- [ ] **Step 2: Run it against Anthropic, which this branch does not change**

```bash
bun run scripts/smoke-providers.ts anthropic
```

Expected: `✓ anthropic responded` plus a JSON estimate. This proves the harness itself works before you use it to judge your own changes. If this fails, fix the harness — not the provider.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-providers.ts
git commit -m "chore: add provider smoke-test script"
```

---

### Task 3: Bump `@anthropic-ai/sdk`

Installed version is `0.30.1`. Its `Usage` type exposes only `input_tokens` and `output_tokens`, while the live API now returns `cache_read_input_tokens` and `cache_creation_input_tokens` on the standard non-beta endpoint. The usage-tracking branch needs those fields.

**Files:**
- Modify: `package.json` (the `@anthropic-ai/sdk` dependency)
- Modify: `bun.lock`

**Interfaces:**
- Consumes: the smoke script from Task 2
- Produces: an `@anthropic-ai/sdk` whose `Usage` type includes cache fields

- [ ] **Step 1: Bump to latest**

```bash
bun add @anthropic-ai/sdk@latest
```

- [ ] **Step 2: Record the new version**

```bash
grep '"@anthropic-ai/sdk"' package.json
```

Write the resolved version into your task report.

- [ ] **Step 3: Verify the cache fields now exist in the types**

```bash
grep -rn "cache_read_input_tokens" node_modules/@anthropic-ai/sdk/resources/messages*
```

Expected: at least one match. If there are **zero** matches, stop and report — the usage-tracking branch depends on this field, and silently proceeding would push the discovery two branches downstream.

- [ ] **Step 4: Typecheck and test**

```bash
bunx tsc --noEmit
bun test
```

Expected: no new type errors, same pass count as Task 1 Step 3. A major-version bump can introduce breaking changes; if `anthropic.ts` no longer compiles, fix it here and describe the change in your report.

- [ ] **Step 5: Smoke-test the live call**

```bash
bun run scripts/smoke-providers.ts anthropic
```

Expected: `✓ anthropic responded`.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/ai/providers/anthropic.ts
git commit -m "chore(deps): bump @anthropic-ai/sdk for cache token fields"
```

---

### Task 4: Bump `@google/generative-ai`

**Files:**
- Modify: `package.json` (the `@google/generative-ai` dependency)
- Modify: `bun.lock`

**Interfaces:**
- Consumes: the smoke script from Task 2
- Produces: a current `@google/generative-ai`

- [ ] **Step 1: Bump to latest**

```bash
bun add @google/generative-ai@latest
```

- [ ] **Step 2: Confirm the usage metadata path is unchanged**

```bash
grep -rn "usageMetadata" node_modules/@google/generative-ai/dist/types/responses.d.ts
```

Expected: `usageMetadata?: UsageMetadata;` on `GenerateContentResponse`. The usage-tracking branch reads `result.response.usageMetadata` — nested under `.response`, **not** on the result object. If the new version moves it, record the new path in your report; the usage plan depends on it.

- [ ] **Step 3: Typecheck and test**

```bash
bunx tsc --noEmit
bun test
```

Expected: no new type errors, same pass count as Task 1.

- [ ] **Step 4: Smoke-test the live call**

```bash
bun run scripts/smoke-providers.ts gemini
```

Expected: `✓ gemini responded`. This still runs `gemini-3-flash-preview`; the model change is Task 5.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/ai/providers/gemini.ts
git commit -m "chore(deps): bump @google/generative-ai"
```

---

### Task 5: Move OpenAI to `gpt-5.6-luna` and drop `temperature`

`gpt-5-mini` is deprecated with a shutdown date of 2026-12-11. `gpt-5.6-luna` is the cost-tier successor at $0.20 input / $1.20 output per 1M tokens.

`temperature` is removed because it is undocumented for the GPT-5.6 family; the GPT-5.2/5.4 precedent permits it only at `effort: "none"`, and GPT-6 Astra forbids it outright. Omitting it is correct under every reading.

**Files:**
- Modify: `src/ai/providers/openai.ts:56-64`

**Interfaces:**
- Consumes: the smoke script from Task 2
- Produces: an OpenAI provider on a non-deprecated model

- [ ] **Step 1: Change the model and remove `temperature`**

Replace the `create` call in `src/ai/providers/openai.ts`. Before:

```typescript
    const response = await this.client.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
    })
```

After:

```typescript
    const response = await this.client.chat.completions.create({
      model: "gpt-5.6-luna",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
    })
```

Leave `response_format` alone. Structured Outputs belong to the Responses branch.

- [ ] **Step 2: Typecheck and test**

```bash
bunx tsc --noEmit
bun test
```

Expected: no new type errors, same pass count.

- [ ] **Step 3: Smoke-test the live call**

```bash
bun run scripts/smoke-providers.ts openai
```

Expected: `✓ openai responded` with a JSON estimate.

If this returns a 400 mentioning an unsupported parameter, the remaining offender is `response_format` — record the exact error text and report it rather than guessing at a fix, because the correct answer is Structured Outputs on the next branch.

- [ ] **Step 4: Commit**

```bash
git add src/ai/providers/openai.ts
git commit -m "fix(openai): move to gpt-5.6-luna and drop unsupported temperature

gpt-5-mini is deprecated with a 2026-12-11 shutdown. temperature is
undocumented for the GPT-5.6 reasoning family and rejected by adjacent
models, so it is removed rather than tuned."
```

---

### Task 6: Move Gemini to `gemini-3.1-flash-lite` and change the schema default

Two changes in one task because they are verified by the same smoke call: the new default provider is only meaningful if that provider works.

**Verify the model id in the Google AI Studio console before committing.** Google's published version ordering is non-monotonic — `gemini-3.1-flash-lite` is listed as stable *and* prices below `gemini-3.5-flash-lite` — which is odd enough to confirm by hand rather than trust from a docs page.

**Files:**
- Modify: `src/ai/providers/gemini.ts:35`
- Modify: `src/db/schema.sql` (the `users.ai_provider` default)

**Interfaces:**
- Consumes: the smoke script from Task 2
- Produces: Gemini on a stable model; new users defaulting to `gemini`

- [ ] **Step 1: Confirm the model id exists**

Check <https://ai.google.dev/gemini-api/docs/models> or the AI Studio console for `gemini-3.1-flash-lite`. If the id does not exist or is not stable, **stop and report** — do not substitute a different model on your own judgment. The pricing map in the usage branch is keyed to this exact string.

- [ ] **Step 2: Change the model id**

In `src/ai/providers/gemini.ts`, inside `getGenerativeModel`:

```typescript
    const model = this.client.getGenerativeModel({
      model: "gemini-3.1-flash-lite",
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
      systemInstruction: SYSTEM_PROMPT,
    })
```

Keep `temperature: 0.3` here. Gemini is not a reasoning model in the OpenAI sense and accepts it; the removal in Task 5 was specific to GPT-5.6.

- [ ] **Step 3: Smoke-test before touching the schema**

```bash
bun run scripts/smoke-providers.ts gemini
```

Expected: `✓ gemini responded`. Do not proceed to the default change until this passes — making a non-working provider the default for new users is strictly worse than leaving the default alone.

- [ ] **Step 4: Change the schema default**

In `src/db/schema.sql`, in the `users` table:

```sql
  ai_provider TEXT DEFAULT 'gemini',
```

This affects **only rows inserted after this change**. Existing users keep their stored `ai_provider` value. Do **not** write an `UPDATE` statement — provider is a user-visible `/settings` option, and silently switching someone's provider is an unexplained behavior change.

- [ ] **Step 5: Update `.env.example` if it implies OpenAI is required**

```bash
grep -n "API_KEY" .env.example
```

If the file presents `OPENAI_API_KEY` as the primary or only required key, adjust the comment so it reads that at least one provider key is required and `GOOGLE_API_KEY` backs the default. If `.env.example` does not exist or already says this, skip the edit.

- [ ] **Step 6: Verify a fresh database picks up the new default**

```bash
bun -e '
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
const db = new Database(":memory:")
db.run(readFileSync("src/db/schema.sql", "utf-8"))
db.run("INSERT INTO users (telegram_id) VALUES (1)")
console.log(db.prepare("SELECT ai_provider FROM users WHERE telegram_id = 1").get())
'
```

Expected: `{ ai_provider: "gemini" }`.

- [ ] **Step 7: Run the full suite**

```bash
bun test
```

Expected: same pass count as Task 1. Note that `users.test.ts` hand-copies its own `CREATE TABLE` with `DEFAULT 'openai'` and asserts that default, so it is **unaffected** by this change — it tests its own inline DDL, not `schema.sql`. That drift is a known problem addressed in the usage-tracking plan; do not fix it here.

- [ ] **Step 8: Commit**

```bash
git add src/ai/providers/gemini.ts src/db/schema.sql .env.example
git commit -m "feat(providers): move Gemini to stable gemini-3.1-flash-lite

Also defaults new users to gemini. gemini-3-flash-preview is superseded
by six stable Flash models and Google recommends stable ids in
production. Existing users keep their stored provider."
```

---

### Task 7: Final verification and handoff

**Files:** none modified

- [ ] **Step 1: Smoke-test all three providers**

```bash
bun run scripts/smoke-providers.ts openai
bun run scripts/smoke-providers.ts anthropic
bun run scripts/smoke-providers.ts gemini
```

Expected: three `✓` lines. Paste all three outputs into your report.

- [ ] **Step 2: Full typecheck and test**

```bash
bunx tsc --noEmit
bun test
```

- [ ] **Step 3: Review the diff against `main`**

```bash
git diff main --stat
```

Expected files: `package.json`, `bun.lock`, `src/ai/providers/openai.ts`, `src/ai/providers/gemini.ts`, `src/db/schema.sql`, `scripts/smoke-providers.ts`, possibly `.env.example`. **`src/ai/service.ts` must not appear** — if it does, scope has leaked from a later branch.

- [ ] **Step 4: Report**

Report: the resolved version of each bumped SDK, the three smoke outputs, the test pass count before and after, and anything you had to fix that this plan did not anticipate. The next branch (`refactor/openai-responses-api`) starts from this one.
