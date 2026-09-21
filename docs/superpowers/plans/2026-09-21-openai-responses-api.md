# OpenAI Responses API Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `src/ai/providers/openai.ts` from Chat Completions to the Responses API, with strict Structured Outputs, reasoning disabled, and server-side storage turned off.

**Architecture:** One provider file changes. The `AIProvider` interface, `AIService`, and every call site are untouched — `estimate()` still takes `(food, context?)` and still returns `EstimationResult`. To make the provider testable at all (this repo has zero provider tests), the OpenAI client becomes an optional constructor parameter defaulting to a real client, so tests can pass a fake.

**Tech Stack:** Bun, TypeScript, `openai` ^7.20.0

**Spec:** `docs/superpowers/specs/2026-09-20-ai-usage-tracking-design.md` (see "Branch 2 — `refactor/openai-responses-api`")

## Global Constraints

- Branch name: `refactor/openai-responses-api`, cut from `chore/sdk-and-model-refresh` **after it merges**.
- Model id is exactly `gpt-5.6-luna`. Do not change it in this plan.
- **`store: false` must be on every Responses call.** It defaults to `true`, which persists user food descriptions to the OpenAI organization for 30+ days, visible in the platform logs dashboard. This is a privacy requirement, not an optimization.
- **Do not adopt `previous_response_id` or the Conversations API.** Both require `store: true`, and conversation items are exempt from even the 30-day TTL. Conversation history stays in TeleCal's own `conversation_state` table and is passed explicitly in the request.
- `reasoning: { effort: "none" }` on every call. `gpt-5.6-luna` defaults to `medium`; omitting the parameter means paying for reasoning tokens on every calorie lookup.
- Do **not** add `temperature`. It is undocumented for the GPT-5.6 family and the documented alternatives cover the intent.
- Do **not** touch `anthropic.ts` or `gemini.ts`. Their structured-output mechanisms are a separate change.
- `openai` must be `^7.20.0` or newer. Earlier majors lack the `gpt-5.6`-era types (`input_tokens_details.cache_write_tokens`).

---

### Task 1: Bump `openai` to v7

A three-major-version jump (`4.104.0` → `^7.20.0`). It lives here rather than on the refresh branch because the Responses API is what justifies it, and its breaking changes are entangled with this migration.

**Files:**
- Modify: `package.json`, `bun.lock`

**Interfaces:**
- Consumes: `scripts/smoke-providers.ts` from the refresh branch
- Produces: an `openai` package exposing `client.responses`

- [ ] **Step 1: Create the branch**

```bash
git checkout chore/sdk-and-model-refresh
git pull
git checkout -b refactor/openai-responses-api
```

If the refresh branch has already merged to `main`, branch from `main` instead.

- [ ] **Step 2: Bump**

```bash
bun add openai@latest
grep '"openai"' package.json
```

Record the resolved version. It must be `>= 7.20.0`.

- [ ] **Step 3: Confirm the Responses types are present**

```bash
grep -rn "cache_write_tokens" node_modules/openai/resources/responses/*.d.ts | head -5
```

Expected: at least one match, confirming `usage.input_tokens_details.cache_write_tokens` exists. If there are zero matches, stop and report — the usage-tracking branch reads this path.

- [ ] **Step 4: Typecheck**

```bash
bunx tsc --noEmit
```

A three-major bump will likely surface errors in `openai.ts` — it still uses Chat Completions at this point. **Record every error verbatim, then fix only what is needed to compile**, leaving the Chat Completions call in place. Task 3 replaces it wholesale. If the file cannot be made to compile without migrating, note that and proceed straight to Task 2; the migration will resolve it.

- [ ] **Step 5: Test**

```bash
bun test
```

Expected: same pass count as the refresh branch's baseline.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/ai/providers/openai.ts
git commit -m "chore(deps): bump openai to v7 for Responses API"
```

---

### Task 2: Make the OpenAI client injectable and write the failing test

This repo has no provider tests, so there is nothing to catch a migration mistake. The provider constructs `new OpenAI(...)` internally, which cannot be observed from a test. One optional constructor parameter fixes that without changing any call site.

**Files:**
- Modify: `src/ai/providers/openai.ts` (constructor only)
- Test: `src/ai/providers/openai.test.ts` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `new OpenAIProvider(client?: OpenAI)` — the no-argument form is unchanged for production; `src/ai/service.ts:17` continues to call `new OpenAIProvider()`

- [ ] **Step 1: Make the client injectable**

In `src/ai/providers/openai.ts`, replace the constructor:

```typescript
export class OpenAIProvider implements AIProvider {
  name = "openai"
  private client: OpenAI

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: config.ai.openaiApiKey })
  }
```

`new OpenAIProvider()` behaves exactly as before, so `src/ai/service.ts` needs no change.

- [ ] **Step 2: Write the failing test**

Create `src/ai/providers/openai.test.ts`:

```typescript
// src/ai/providers/openai.test.ts
import { describe, test, expect } from "bun:test"
import OpenAI from "openai"
import { OpenAIProvider } from "./openai"

/** Captures the arguments a Responses call was made with, and returns a canned reply. */
function fakeClient(outputText: string) {
  const calls: any[] = []
  const client = {
    responses: {
      create: async (args: any) => {
        calls.push(args)
        return {
          model: "gpt-5.6-luna",
          output_text: outputText,
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 45,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 165,
          },
        }
      },
    },
  }
  return { client: client as unknown as OpenAI, calls }
}

const VALID_REPLY = JSON.stringify({
  items: [{ description: "Scrambled eggs", calories: 180, emoji: "🍳" }],
  needsClarification: false,
  clarificationQuestion: "",
  confidence: "high",
})

describe("OpenAIProvider", () => {
  test("parses a structured estimate", async () => {
    const { client } = fakeClient(VALID_REPLY)
    const provider = new OpenAIProvider(client)

    const result = await provider.estimate("two scrambled eggs")

    expect(result.items).toHaveLength(1)
    expect(result.items[0].calories).toBe(180)
    expect(result.needsClarification).toBe(false)
    expect(result.confidence).toBe("high")
  })

  test("disables server-side storage on every call", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].store).toBe(false)
  })

  test("disables reasoning effort", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].reasoning).toEqual({ effort: "none" })
  })

  test("requests strict structured output, not json_object mode", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].text.format.type).toBe("json_schema")
    expect(calls[0].text.format.strict).toBe(true)
    expect(calls[0].response_format).toBeUndefined()
  })

  test("sends no temperature", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("two scrambled eggs")

    expect(calls[0].temperature).toBeUndefined()
  })

  test("passes conversation context in the input, not via previous_response_id", async () => {
    const { client, calls } = fakeClient(VALID_REPLY)
    await new OpenAIProvider(client).estimate("about 200g", "earlier: grilled chicken")

    expect(JSON.stringify(calls[0].input)).toContain("grilled chicken")
    expect(calls[0].previous_response_id).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
bun test src/ai/providers/openai.test.ts
```

Expected: FAIL. The provider still calls `chat.completions.create`, which the fake does not define, so calls error out. That failure is the point — it proves the test exercises the code path you are about to replace.

- [ ] **Step 4: Commit the injectable constructor and the failing test**

```bash
git add src/ai/providers/openai.ts src/ai/providers/openai.test.ts
git commit -m "test(openai): add failing Responses API contract tests"
```

Committing a red test is deliberate: the next task's commit shows exactly which behaviors turned green.

---

### Task 3: Migrate to the Responses API

**Files:**
- Modify: `src/ai/providers/openai.ts` (the `estimate` method and `SYSTEM_PROMPT`)

**Interfaces:**
- Consumes: `new OpenAIProvider(client?)` from Task 2
- Produces: `estimate(food: string, context?: string): Promise<EstimationResult>` — signature unchanged

- [ ] **Step 1: Replace the file body**

Rewrite `src/ai/providers/openai.ts`:

```typescript
// src/ai/providers/openai.ts
import OpenAI from "openai"
import { AIProvider, EstimationResult, FoodEstimate } from "../types"
import { config } from "../../config"

const INSTRUCTIONS = `You are a nutrition expert that estimates calories in food.

Rules:
- Be accurate but err on the side of slightly higher estimates
- Use common portion sizes if not specified
- Include a relevant emoji for each food item
- If multiple items are mentioned, break them down separately
- If quantity or size is unclear, set needsClarification to true and ask a
  specific question in clarificationQuestion
- When no clarification is needed, return an empty string for
  clarificationQuestion`

/**
 * Strict Structured Outputs requires every property to appear in `required`
 * and `additionalProperties: false` on every object. Fields that are
 * conceptually optional (clarificationQuestion, emoji) are therefore required
 * here and filled with an empty string when not applicable — see INSTRUCTIONS.
 */
const ESTIMATE_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          calories: { type: "number" },
          emoji: { type: "string" },
        },
        required: ["description", "calories", "emoji"],
        additionalProperties: false,
      },
    },
    needsClarification: { type: "boolean" },
    clarificationQuestion: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["items", "needsClarification", "clarificationQuestion", "confidence"],
  additionalProperties: false,
} as const

export class OpenAIProvider implements AIProvider {
  name = "openai"
  private client: OpenAI

  constructor(client?: OpenAI) {
    this.client = client ?? new OpenAI({ apiKey: config.ai.openaiApiKey })
  }

  async estimate(foodDescription: string, context?: string): Promise<EstimationResult> {
    const userMessage = context
      ? `Context from previous conversation: ${context}\n\nFood to estimate: ${foodDescription}`
      : foodDescription

    const response = await this.client.responses.create({
      model: "gpt-5.6-luna",
      instructions: INSTRUCTIONS,
      input: userMessage,
      reasoning: { effort: "none" },
      // Defaults to true, which would retain user food descriptions in the
      // OpenAI org for 30+ days. TeleCal keeps its own conversation state.
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "calorie_estimate",
          schema: ESTIMATE_SCHEMA,
          strict: true,
        },
      },
    } as any)

    const content = response.output_text
    if (!content) {
      throw new Error("No response from OpenAI")
    }

    // No markdown-fence stripping: strict Structured Outputs cannot return
    // fenced or malformed JSON.
    const result = JSON.parse(content) as {
      items: FoodEstimate[]
      needsClarification: boolean
      clarificationQuestion?: string
      confidence: "high" | "medium" | "low"
    }

    return {
      items: result.items || [],
      needsClarification: result.needsClarification || false,
      clarificationQuestion: result.clarificationQuestion || undefined,
      confidence: result.confidence || "medium",
    }
  }
}
```

The `as any` on the request object is a deliberate, temporary escape hatch: SDK type definitions for a brand-new model family are often narrower than the API. **Try removing it first.** If `bunx tsc --noEmit` passes without it, delete it and note that in your report.

- [ ] **Step 2: Run the tests**

```bash
bun test src/ai/providers/openai.test.ts
```

Expected: all six tests PASS.

- [ ] **Step 3: Typecheck and run the whole suite**

```bash
bunx tsc --noEmit
bun test
```

Expected: no type errors; baseline pass count plus the six new tests.

- [ ] **Step 4: Smoke-test against the live API**

```bash
bun run scripts/smoke-providers.ts openai
```

Expected: `✓ openai responded` with a JSON estimate.

If you get a 400 about an unknown parameter, record the exact message. The most likely culprits, in order: `text.format` shape (check `name` and `strict` are siblings of `schema`, not nested inside it), then `reasoning.effort: "none"` support.

- [ ] **Step 5: Verify storage is actually off**

Open <https://platform.openai.com/logs?api=responses> and confirm the smoke call from Step 4 does **not** appear. This is the one requirement in this plan that a passing test cannot prove — the unit test asserts the flag was sent; only the dashboard proves the server honored it.

Record what you saw. If the call **does** appear, stop and report: something is overriding `store`.

- [ ] **Step 6: Commit**

```bash
git add src/ai/providers/openai.ts
git commit -m "refactor(openai): migrate to Responses API with strict structured outputs

- store: false so food descriptions are not retained by OpenAI
- reasoning.effort none, since gpt-5.6-luna defaults to medium
- strict json_schema replaces json_object mode and fence-stripping"
```

---

### Task 4: Document the data-handling behavior

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Add a Privacy section**

Insert into `README.md`, after the Bot Commands table:

```markdown
### Privacy

Food descriptions are sent to whichever AI provider the user has selected in
`/settings` (OpenAI, Anthropic, or Google) to estimate calories.

TeleCal disables server-side retention where the provider offers the option —
OpenAI calls are made with `store: false`, so requests are not kept in the
OpenAI organization's logs. Providers may still retain request content
separately for abuse monitoring under their own policies.

Calorie data itself is stored only in TeleCal's local SQLite database.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe AI provider data handling"
```

---

### Task 5: Final verification and handoff

**Files:** none modified

- [ ] **Step 1: Verify all three providers still work**

```bash
bun run scripts/smoke-providers.ts openai
bun run scripts/smoke-providers.ts anthropic
bun run scripts/smoke-providers.ts gemini
```

Expected: three `✓` lines. Anthropic and Gemini must still pass — this branch should not have touched them.

- [ ] **Step 2: Full typecheck and test**

```bash
bunx tsc --noEmit
bun test
```

- [ ] **Step 3: Review the diff**

```bash
git diff chore/sdk-and-model-refresh --stat
```

Expected files: `package.json`, `bun.lock`, `src/ai/providers/openai.ts`, `src/ai/providers/openai.test.ts`, `README.md`. **`anthropic.ts`, `gemini.ts`, `service.ts`, and `types.ts` must not appear.**

- [ ] **Step 4: Report**

Report: the resolved `openai` version, whether the `as any` cast was needed, all six test results, the live smoke output, and **explicitly, what you saw in the OpenAI logs dashboard when verifying `store: false`**. Note for the usage-tracking branch: confirm the live response's `usage` object matches the paths that branch expects — `usage.input_tokens`, `usage.input_tokens_details.cached_tokens`, `usage.output_tokens`, `usage.output_tokens_details.reasoning_tokens`.
