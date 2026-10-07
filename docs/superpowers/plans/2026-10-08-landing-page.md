# Landing Page and Access Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a public landing page at `/` (Mini App moves to `/app`), and replace the bot's invite-only dead end with an in-bot access request that admins approve in one tap.

**Architecture:** The existing Bun web server gains a landing route, a static `/assets/*` route, and a testable `createFetchHandler`. The page is one static HTML file with two placeholders filled at startup. In the bot, the allowlist middleware becomes a gate that fully handles non-allowlisted users (prompt → request → admin DM with Approve/Decline), backed by a new `access_requests` table.

**Tech Stack:** Bun, `bun:sqlite`, grammY, plain HTML/CSS (no framework, no build step), macOS `sips` and headless Chrome for images.

**Spec:** `docs/superpowers/specs/2026-10-08-landing-page-design.md`. Visual reference: `docs/superpowers/specs/assets/2026-10-08-landing-page-draft.html`.

## Global Constraints

- No emojis on the web page or in its assets. Icons are inline SVG. (Bot messages keep their existing emojis; new bot strings in this plan have none.)
- Palette "Berry": accent `#6D4AFF`, page `#F8F6FF`, ink `#1B1530`. Dark mode: page `#0F0C1A`, surface `#17132A`, ink `#EEEAFB`, muted `#A39DBD`, line `#2A2444`, accent `#8B6DFF`.
- Font: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif`. No webfonts.
- No new npm dependencies.
- `APP_URL` on Railway is not changed. The Mini App URL is derived: `APP_URL` without trailing slash + `/app`.
- Pushing to `main` deploys to production. Do not push. Commit locally only.
- `CLAUDE.md` has the owner's uncommitted edits. Never stage it.
- Tests: `bun test`. Baseline is 288 passing. Tests use `createTestDb()` from `src/db/test-helpers.ts` and fake grammY contexts cast with `as unknown as Context`.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  ```

## File Map

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `baseUrlFrom()`, `config.web.baseUrl`, `config.web.miniAppUrl` |
| `src/bot/commands/today.ts`, `stats.ts` (modify) | View Charts buttons use `miniAppUrl` |
| `src/web/server.ts` (modify) | `renderLanding`, `createFetchHandler`, routes `/`, `/app`, `/assets/*` |
| `src/web/views/landing.html` (new) | The landing page |
| `src/web/public/favicon.svg`, `og.png`, `shot-*.jpg` (new) | Static assets |
| `scripts/og.html`, `scripts/build-landing-assets.sh` (new) | Asset generation |
| `src/db/schema.sql` (modify) | `access_requests` table |
| `src/db/repositories/access-requests.ts` (new) | Request state transitions |
| `src/bot/help.ts` (new) | `HELP_TEXT` shared by `/start` and approval |
| `src/bot/access.ts` (new) | Access-flow strings, keyboards, admin notifier, admin decision handler, pending list |
| `src/bot/middleware/allowlist.ts` (modify) | Gate for non-allowlisted users |
| `src/bot/index.ts`, `src/bot/commands/admin.ts`, `src/index.ts` (modify) | Wiring |

---

### Task 1: Mini App URL lives at `/app`

**Files:**
- Modify: `src/config.ts`
- Modify: `src/bot/commands/today.ts:70,81`
- Modify: `src/bot/commands/stats.ts:140,151`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces: `export function baseUrlFrom(appUrl: string): string`; `config.web.baseUrl: string`; `config.web.miniAppUrl: string`.

- [ ] **Step 1: Write the failing test.** Append to `src/config.test.ts`:

```ts
describe("baseUrlFrom", () => {
  test("strips trailing slashes", async () => {
    const { baseUrlFrom } = await import("./config")
    expect(baseUrlFrom("https://telecal.example/")).toBe("https://telecal.example")
    expect(baseUrlFrom("https://telecal.example//")).toBe("https://telecal.example")
  })

  test("leaves a clean URL alone", async () => {
    const { baseUrlFrom } = await import("./config")
    expect(baseUrlFrom("https://telecal.example")).toBe("https://telecal.example")
  })

  test("miniAppUrl is the base URL plus /app", async () => {
    const { config, baseUrlFrom } = await import("./config")
    expect(config.web.miniAppUrl).toBe(baseUrlFrom(config.web.appUrl) + "/app")
  })
})
```

- [ ] **Step 2: Run it and confirm it fails.** `bun test src/config.test.ts` → FAIL, `baseUrlFrom` is not a function.

- [ ] **Step 3: Implement.** In `src/config.ts`, add above `export const config`:

```ts
/** APP_URL without trailing slashes, so paths can be appended safely. */
export function baseUrlFrom(appUrl: string): string {
  return appUrl.replace(/\/+$/, "")
}

const appUrl = getEnv("APP_URL", "http://localhost:3000")
```

and replace the `web` block with:

```ts
  web: {
    appUrl,
    baseUrl: baseUrlFrom(appUrl),
    // The landing page owns "/"; the Mini App is served at /app.
    miniAppUrl: `${baseUrlFrom(appUrl)}/app`,
    port: getEnvNumber("PORT", 3000),
  },
```

- [ ] **Step 4: Switch the four View Charts buttons.** In `src/bot/commands/today.ts` (two places) and `src/bot/commands/stats.ts` (two places), change `web_app: { url: config.web.appUrl }` to `web_app: { url: config.web.miniAppUrl }`. Then confirm none are left: `grep -rn "web.appUrl" src --include=*.ts` should only show `src/config.ts` (zsh: quote the glob or use `grep -rn "web.appUrl" src`).

- [ ] **Step 5: Run all tests.** `bun test` → all pass (291).

- [ ] **Step 6: Commit.**

```bash
git add src/config.ts src/config.test.ts src/bot/commands/today.ts src/bot/commands/stats.ts
git commit -m "feat(web): Mini App URL moves to /app

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Web server routes `/`, `/app`, `/assets/*`

**Files:**
- Modify: `src/web/server.ts` (full rewrite below)
- Create: `src/web/views/landing.html` (minimal skeleton; Task 3 replaces it)
- Create: `src/web/public/favicon.svg`
- Test: `src/web/server.test.ts` (new)

**Interfaces:**
- Consumes: nothing from Task 1 at the type level (the caller passes `baseUrl`).
- Produces:
  - `export interface WebServerDeps { usersRepo: UsersRepository; foodLogsRepo: FoodLogsRepository; botUsername: string; baseUrl: string }`
  - `export function renderLanding(template: string, values: { botUsername: string; baseUrl: string }): string`
  - `export function createFetchHandler(deps: WebServerDeps): (request: Request) => Promise<Response>`
  - `export function startWebServer(deps: WebServerDeps)` (unchanged name; new deps fields)

- [ ] **Step 1: Create the favicon.** `src/web/public/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="7" fill="#6D4AFF"/><path d="M6.5 8.5a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-3.2L8.6 17.6c-.4.3-.9 0-.9-.4v-2.3a3 3 0 0 1-1.2-2.4z" fill="#fff"/><circle cx="12" cy="10.2" r="1.7" fill="#6D4AFF"/></svg>
```

- [ ] **Step 2: Create the skeleton page.** `src/web/views/landing.html` (Task 3 replaces the whole file, keeping these head lines):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<script>if (location.hash.includes("tgWebAppData")) location.replace("/app" + location.hash)</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeleCal: track calories by just texting</title>
<meta property="og:image" content="{{BASE_URL}}/assets/og.png">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
</head>
<body>
<a href="https://t.me/{{BOT_USERNAME}}?start=access">Request access</a>
</body>
</html>
```

- [ ] **Step 3: Write the failing tests.** `src/web/server.test.ts`:

```ts
// src/web/server.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { createFetchHandler, renderLanding } from "./server"

let handle: (request: Request) => Promise<Response>

beforeEach(() => {
  const db = createTestDb()
  handle = createFetchHandler({
    usersRepo: new UsersRepository(db),
    foodLogsRepo: new FoodLogsRepository(db),
    botUsername: "TeleCalTestBot",
    baseUrl: "https://telecal.example",
  })
})

const get = (path: string) => handle(new Request(`http://localhost${path}`))

describe("renderLanding", () => {
  test("fills both placeholders everywhere", () => {
    const out = renderLanding("{{BOT_USERNAME}} {{BASE_URL}} {{BOT_USERNAME}}", {
      botUsername: "Bot",
      baseUrl: "https://x.example",
    })
    expect(out).toBe("Bot https://x.example Bot")
  })

  test("escapes values for HTML attributes", () => {
    const out = renderLanding('<a href="{{BASE_URL}}">', { botUsername: "Bot", baseUrl: 'https://x.example/"><script>' })
    expect(out).not.toContain("<script>")
    expect(out).toContain("&quot;&gt;&lt;script&gt;")
  })
})

describe("routes", () => {
  test("/ serves the landing page with values filled in", async () => {
    const res = await get("/")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("https://t.me/TeleCalTestBot?start=access")
    expect(body).toContain("https://telecal.example/assets/og.png")
    expect(body).not.toContain("{{")
  })

  test("/ redirects Telegram Web App launches to /app", async () => {
    const body = await (await get("/")).text()
    expect(body).toContain('location.replace("/app" + location.hash)')
  })

  test("/app and /app/ serve the Mini App", async () => {
    for (const path of ["/app", "/app/"]) {
      const res = await get(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("telegram-web-app.js")
    }
  })

  test("/assets/favicon.svg is served as SVG with caching", async () => {
    const res = await get("/assets/favicon.svg")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400")
  })

  test("asset paths outside the pattern are 404", async () => {
    for (const path of ["/assets/../config.ts", "/assets/%2e%2e%2fconfig.ts", "/assets/x.html", "/assets/missing.png", "/assets/Favicon.svg"]) {
      expect((await get(path)).status).toBe(404)
    }
  })

  test("/api routes still require auth", async () => {
    expect((await get("/api/today")).status).toBe(401)
  })

  test("unknown paths are 404", async () => {
    expect((await get("/nope")).status).toBe(404)
  })
})
```

- [ ] **Step 4: Run them and confirm they fail.** `bun test src/web/server.test.ts` → FAIL, `createFetchHandler` is not exported.

- [ ] **Step 5: Implement.** Replace `src/web/server.ts` with:

```ts
// src/web/server.ts
import { readFileSync } from "fs"
import { join } from "path"
import { config } from "../config"
import { UsersRepository } from "../db/repositories/users"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { validateInitData, extractAuthHeader, TelegramUser } from "./auth"
import { createApiHandlers } from "./api"

export interface WebServerDeps {
  usersRepo: UsersRepository
  foodLogsRepo: FoodLogsRepository
  /** Without the @. Fills {{BOT_USERNAME}} in the landing page. */
  botUsername: string
  /** APP_URL without a trailing slash. Fills {{BASE_URL}}. */
  baseUrl: string
}

const VIEWS_DIR = join(import.meta.dir, "views")
const PUBLIC_DIR = join(import.meta.dir, "public")

// The name pattern is the traversal guard: no slashes, dots only before the extension.
const ASSET_PATH = /^\/assets\/([a-z0-9-]+\.(svg|png|jpg))$/
const ASSET_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function renderLanding(template: string, values: { botUsername: string; baseUrl: string }): string {
  return template
    .replaceAll("{{BOT_USERNAME}}", escapeAttribute(values.botUsername))
    .replaceAll("{{BASE_URL}}", escapeAttribute(values.baseUrl))
}

function loadLanding(values: { botUsername: string; baseUrl: string }): string | null {
  try {
    return renderLanding(readFileSync(join(VIEWS_DIR, "landing.html"), "utf-8"), values)
  } catch (error) {
    console.error("[web] landing page unavailable:", error)
    return null
  }
}

export function createFetchHandler(deps: WebServerDeps) {
  const { usersRepo, foodLogsRepo } = deps
  const api = createApiHandlers({ usersRepo, foodLogsRepo })
  // Rendered once: the template and both values are fixed for the process lifetime.
  const landing = loadLanding({ botUsername: deps.botUsername, baseUrl: deps.baseUrl })

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/" || path === "/index.html") {
      if (landing === null) {
        return new Response("Service unavailable", { status: 503 })
      }
      return new Response(landing, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    if (path === "/app" || path === "/app/") {
      return serveMiniApp()
    }

    const asset = path.match(ASSET_PATH)
    if (asset) {
      return serveAsset(asset[1], asset[2])
    }

    // API routes require authentication
    if (path.startsWith("/api/")) {
      const initData = extractAuthHeader(request)
      const user = initData
        ? validateInitData(initData, config.telegram.botToken)
        : null

      if (!user) {
        return jsonResponse({ error: "Unauthorized" }, 401)
      }

      return handleApiRoute(path, url, user, api)
    }

    return new Response("Not found", { status: 404 })
  }
}

export function startWebServer(deps: WebServerDeps) {
  return Bun.serve({
    port: config.web.port,
    fetch: createFetchHandler(deps),
  })
}

async function serveMiniApp(): Promise<Response> {
  const file = Bun.file(join(VIEWS_DIR, "app.html"))

  if (!(await file.exists())) {
    return new Response("Mini App not found", { status: 404 })
  }

  return new Response(file, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

async function serveAsset(name: string, extension: string): Promise<Response> {
  const file = Bun.file(join(PUBLIC_DIR, name))

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": ASSET_TYPES[extension],
      "Cache-Control": "public, max-age=86400",
    },
  })
}
```

Keep the existing `handleApiRoute` and `jsonResponse` functions from the old file unchanged, below these.

- [ ] **Step 6: Update the caller so the app still boots.** In `src/index.ts`, replace

```ts
const { bot, usersRepo, foodLogsRepo, pendingRepo, aiService } = createBot()

// Start web server
const webServer = startWebServer({ usersRepo, foodLogsRepo })
```

with

```ts
const { bot, usersRepo, foodLogsRepo, pendingRepo, aiService } = createBot()

// Fetches the bot's own username (getMe) for the landing page's t.me links.
// bot.start() below reuses it instead of calling getMe again.
await bot.init()

// Start web server
const webServer = startWebServer({
  usersRepo,
  foodLogsRepo,
  botUsername: bot.botInfo.username,
  baseUrl: config.web.baseUrl,
})
```

- [ ] **Step 7: Run tests.** `bun test` → all pass.

- [ ] **Step 8: Commit.**

```bash
git add src/web/server.ts src/web/server.test.ts src/web/views/landing.html src/web/public/favicon.svg src/index.ts
git commit -m "feat(web): landing route at /, Mini App at /app, static assets

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The landing page

**Files:**
- Replace: `src/web/views/landing.html`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: placeholders `{{BOT_USERNAME}}` and `{{BASE_URL}}` (Task 2); assets `/assets/favicon.svg`, `/assets/og.png`, `/assets/shot-log.jpg`, `/assets/shot-today.jpg`, `/assets/shot-charts.jpg` (Task 4 / owner).
- Produces: nothing code-level. Task 2's tests must keep passing.

Screenshots may not exist yet. Each `<img>` has `onerror="this.remove()"`, so a missing file shows the striped placeholder frame with its label instead of a broken image.

- [ ] **Step 1: Replace `src/web/views/landing.html` with:**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<script>if (location.hash.includes("tgWebAppData")) location.replace("/app" + location.hash)</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TeleCal: track calories by just texting</title>
<meta name="description" content="Tell TeleCal what you ate, in your own words. It estimates calories and protein, asks when it's unsure, and keeps your log. All inside Telegram.">
<link rel="canonical" href="{{BASE_URL}}/">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#F8F6FF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0F0C1A" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="TeleCal">
<meta property="og:title" content="TeleCal: track calories by just texting">
<meta property="og:description" content="AI calorie and protein tracking inside Telegram. Free during beta.">
<meta property="og:url" content="{{BASE_URL}}/">
<meta property="og:image" content="{{BASE_URL}}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<style>
  :root {
    color-scheme: light;
    --pg:#F8F6FF; --surface:#FFFFFF; --ink:#1B1530; --mut:#665F80; --line:#E4DEF7;
    --acc:#6D4AFF; --acc-ink:#FFFFFF; --acc-soft:rgba(109,74,255,.10); --acc-text:#5233D6;
    --chat:#ECE8FB; --frame:#1B1530; --nav-bg:rgba(248,246,255,.85);
    --stripe-a:#ECE8FB; --stripe-b:#E4DEF7;
    --shadow:rgba(27,21,48,.35);
    --r-lg:28px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --pg:#0F0C1A; --surface:#17132A; --ink:#EEEAFB; --mut:#A39DBD; --line:#2A2444;
      --acc:#8B6DFF; --acc-soft:rgba(139,109,255,.16); --acc-text:#B7A4FF;
      --chat:#221C3A; --nav-bg:rgba(15,12,26,.82);
      --stripe-a:#1D1833; --stripe-b:#241E3D;
      --shadow:rgba(0,0,0,.6);
    }
  }
  * { box-sizing:border-box; margin:0; padding:0 }
  html { scroll-behavior:smooth; scroll-padding-top:72px }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior:auto } }
  body { background:var(--pg); color:var(--ink); font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased }
  .wrap { max-width:1080px; margin:0 auto; padding:0 24px }
  a { color:inherit; text-decoration:none }
  :focus-visible { outline:2px solid var(--acc); outline-offset:3px; border-radius:8px }

  nav { position:sticky; top:0; z-index:10; background:var(--nav-bg); backdrop-filter:saturate(180%) blur(14px); -webkit-backdrop-filter:saturate(180%) blur(14px); border-bottom:1px solid var(--line) }
  nav .wrap { display:flex; align-items:center; gap:28px; height:60px }
  .brand { display:flex; align-items:center; gap:9px; font-weight:700; font-size:17px; letter-spacing:-.01em }
  nav .links { display:flex; gap:24px; font-size:14.5px; color:var(--mut); margin-left:auto }
  nav .links a:hover { color:var(--ink) }
  .btn { display:inline-flex; align-items:center; gap:8px; background:var(--acc); color:var(--acc-ink); font-weight:600; border-radius:999px; padding:12px 22px; font-size:15.5px; transition:transform .15s, box-shadow .15s }
  .btn:hover { transform:translateY(-1px); box-shadow:0 6px 18px rgba(109,74,255,.28) }
  .btn.sm { padding:8px 16px; font-size:14px }
  .btn.ghost { background:transparent; color:var(--acc-text) }
  .btn.ghost:hover { box-shadow:none; background:var(--acc-soft) }

  .hero { text-align:center; padding:84px 0 0; overflow:hidden }
  .eyebrow { display:inline-block; font-size:13px; font-weight:600; color:var(--acc-text); background:var(--acc-soft); border-radius:999px; padding:5px 12px; margin-bottom:22px }
  .hero h1 { font-size:clamp(40px,6.4vw,68px); line-height:1.03; letter-spacing:-.035em; font-weight:750; max-width:12ch; margin:0 auto 20px }
  .hero .lede { font-size:19px; color:var(--mut); max-width:34em; margin:0 auto 30px }
  .hero .ctas { display:flex; justify-content:center; gap:6px; flex-wrap:wrap }

  .device { background:var(--frame); border-radius:44px; padding:10px; box-shadow:0 0 0 1px var(--line), 0 40px 80px -30px var(--shadow) }
  .screen { position:relative; aspect-ratio:720/1560; border-radius:34px; overflow:hidden; background:repeating-linear-gradient(135deg,var(--stripe-a) 0 14px,var(--stripe-b) 14px 28px); display:grid; place-items:center }
  .screen::before { content:attr(data-label); color:var(--mut); font-size:13px; padding:24px; text-align:center }
  .screen img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:top }
  .hero-device { width:min(340px,86%); margin:56px auto 0; border-radius:48px 48px 0 0; padding-bottom:0; height:min(520px,125vw); overflow:hidden }
  .hero-device .screen { border-radius:38px 38px 0 0; aspect-ratio:auto; height:100% }
  /* Natural height, pinned to the top; the device's fixed height crops the bottom. */
  .hero-device .screen img { height:auto; bottom:auto }

  section { padding:104px 0 }
  .sec-head { text-align:center; max-width:640px; margin:0 auto 52px }
  .kicker { font-size:13px; font-weight:650; letter-spacing:.06em; text-transform:uppercase; color:var(--acc-text); margin-bottom:10px }
  .sec-head h2 { font-size:clamp(30px,4vw,42px); letter-spacing:-.03em; line-height:1.1 }
  .sec-head p { color:var(--mut); font-size:17px; margin-top:12px }

  .steps { display:grid; grid-template-columns:repeat(3,1fr); gap:20px }
  .step { background:var(--surface); border-radius:var(--r-lg); padding:28px; border:1px solid var(--line) }
  .step .n { width:34px; height:34px; border-radius:50%; background:var(--acc); color:#fff; display:grid; place-items:center; font-weight:700; font-size:15px; margin-bottom:18px }
  .step h3 { font-size:19px; letter-spacing:-.01em; margin-bottom:6px }
  .step p { color:var(--mut); font-size:15px }
  .step .q { margin-top:16px; display:inline-block; font-size:13.5px; background:var(--chat); border-radius:14px 14px 14px 5px; padding:7px 11px; color:var(--ink) }

  .showcase { display:grid; grid-template-columns:1fr 1.1fr; gap:48px; align-items:center; background:var(--surface); border:1px solid var(--line); border-radius:36px; padding:56px }
  .showcase h2 { font-size:clamp(28px,3.4vw,38px); letter-spacing:-.03em; line-height:1.1; margin-bottom:16px }
  .showcase p { color:var(--mut); font-size:16.5px; margin-bottom:10px }
  .showcase b { color:var(--ink) }
  .pair { display:flex; gap:20px; justify-content:center }
  .pair .device { width:230px }
  .pair .offset { margin-top:56px }

  .features { background:var(--surface); border-top:1px solid var(--line); border-bottom:1px solid var(--line) }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:var(--r-lg); overflow:hidden }
  .feat { background:var(--surface); padding:30px 28px }
  .ic { width:42px; height:42px; border-radius:13px; background:var(--acc-soft); color:var(--acc); display:grid; place-items:center; margin-bottom:16px }
  .feat h3 { font-size:17px; margin-bottom:5px; letter-spacing:-.01em }
  .feat p { color:var(--mut); font-size:15px }

  .price { max-width:460px; margin:0 auto; background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg); padding:36px; text-align:center; box-shadow:0 30px 60px -40px var(--shadow) }
  .tag { font-size:13px; font-weight:650; color:var(--acc-text); background:var(--acc-soft); border-radius:999px; padding:4px 11px; display:inline-block }
  .price .amt { font-size:56px; font-weight:750; letter-spacing:-.04em; margin:14px 0 2px }
  .price .per { color:var(--mut); margin-bottom:24px }
  .price ul { list-style:none; text-align:left; margin:0 auto 28px; display:grid; gap:10px; max-width:300px }
  .price li { display:flex; gap:10px; font-size:15.5px }
  .price li svg { flex:none; margin-top:3px; color:var(--acc) }
  .price small { display:block; color:var(--mut); font-size:13.5px; margin-top:16px }

  .faq { max-width:720px; margin:0 auto }
  details { border-bottom:1px solid var(--line); padding:20px 4px }
  summary { list-style:none; cursor:pointer; font-weight:600; font-size:17px; display:flex; justify-content:space-between; gap:16px }
  summary::-webkit-details-marker { display:none }
  summary::after { content:"+"; color:var(--acc); font-weight:400; font-size:22px; line-height:1 }
  details[open] summary::after { content:"\2212" }
  details p { color:var(--mut); margin-top:10px; font-size:15.5px }
  details b { color:var(--ink) }

  .band { background:#6D4AFF; color:#fff; border-radius:36px; padding:64px 32px; text-align:center; max-width:1032px; margin:0 auto }
  .band h2 { font-size:clamp(28px,4vw,40px); letter-spacing:-.03em; margin-bottom:10px }
  .band p { opacity:.85; margin-bottom:28px; font-size:17px }
  .band .btn { background:#fff; color:#5233D6 }

  footer { padding:48px 0 56px; color:var(--mut); font-size:14px }
  footer .wrap { display:flex; gap:24px; align-items:center; flex-wrap:wrap }
  footer .sp { flex:1 }
  footer a:hover { color:var(--ink) }

  @media (max-width:780px) {
    .wrap { padding:0 16px }
    nav .links { display:none }
    nav .wrap { justify-content:space-between }
    .hero { padding-top:56px }
    .hero .lede { font-size:17px }
    .steps, .grid { grid-template-columns:1fr }
    section { padding:72px 0 }
    .showcase { grid-template-columns:1fr; padding:32px 20px; gap:32px }
    .pair { gap:12px }
    .pair .device { width:calc(50% - 6px); padding:6px; border-radius:30px }
    .pair .screen { border-radius:24px }
    .pair .offset { margin-top:32px }
    .band { margin:0 16px; padding:48px 20px }
  }
</style>
</head>
<body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="mark" viewBox="0 0 24 24"><rect width="24" height="24" rx="7" fill="#6D4AFF"/><path d="M6.5 8.5a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-3.2L8.6 17.6c-.4.3-.9 0-.9-.4v-2.3a3 3 0 0 1-1.2-2.4z" fill="#fff"/><circle cx="12" cy="10.2" r="1.7" fill="#6D4AFF"/></symbol>
  <symbol id="check" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</svg>

<nav aria-label="Main"><div class="wrap">
  <a class="brand" href="#top"><svg width="28" height="28" aria-hidden="true"><use href="#mark"/></svg>TeleCal</a>
  <div class="links"><a href="#how">How it works</a><a href="#progress">Progress</a><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a></div>
  <a class="btn sm" href="https://t.me/{{BOT_USERNAME}}?start=access">Request access</a>
</div></nav>

<main id="top">
<header class="hero"><div class="wrap">
  <span class="eyebrow">Free during beta · Invite-only</span>
  <h1>Track calories by just texting.</h1>
  <p class="lede">Tell TeleCal what you ate, in your own words. It estimates calories and protein, asks when it's unsure, and keeps your log. All inside Telegram.</p>
  <div class="ctas"><a class="btn" href="https://t.me/{{BOT_USERNAME}}?start=access">Request access</a><a class="btn ghost" href="#how">See how it works</a></div>

  <div class="device hero-device">
    <div class="screen" data-label="/log conversation">
      <img src="/assets/shot-log.jpg" width="720" height="1560" alt="A TeleCal chat in Telegram. The user types chicken adobo with rice, the bot asks how much, then lists calories and protein per item with Log, Change and Cancel buttons." onerror="this.remove()">
    </div>
  </div>
</div></header>

<section id="how"><div class="wrap">
  <div class="sec-head"><div class="kicker">How it works</div><h2>Three messages, not a food database.</h2><p>No barcode scanning, no searching through 40 kinds of rice.</p></div>
  <div class="steps">
    <div class="step"><div class="n">1</div><h3>Say what you ate</h3><p>Type it the way you'd text a friend. Mixed dishes and home cooking are fine.</p><span class="q">two eggs, toast, black coffee</span></div>
    <div class="step"><div class="n">2</div><h3>It asks if it matters</h3><p>When a detail changes the number, like portion size or how it was cooked, you get one quick question.</p><span class="q">Fried or boiled?</span></div>
    <div class="step"><div class="n">3</div><h3>Tap to log</h3><p>Check the breakdown and tap once. Your daily total and goal progress update right away.</p><span class="q">Log 360 cal · 18 g</span></div>
  </div>
</div></section>

<section id="progress" style="padding-top:0"><div class="wrap">
  <div class="showcase">
    <div>
      <div class="kicker">Your progress</div>
      <h2>Know where you stand, today and this week.</h2>
      <p><b>/today</b> shows every item, your totals and how close you are to your calorie and protein goals.</p>
      <p>Tap <b>View Charts</b> for week and month trends in a mini app that opens right inside Telegram.</p>
    </div>
    <div class="pair">
      <div class="device"><div class="screen" data-label="/today summary">
        <img src="/assets/shot-today.jpg" width="720" height="1560" loading="lazy" alt="The /today message in Telegram: logged items, calorie and protein totals, goal progress and a View Charts button." onerror="this.remove()">
      </div></div>
      <div class="device offset"><div class="screen" data-label="Charts mini app">
        <img src="/assets/shot-charts.jpg" width="720" height="1560" loading="lazy" alt="The TeleCal mini app inside Telegram showing a week of daily calories as a bar chart." onerror="this.remove()">
      </div></div>
    </div>
  </div>
</div></section>

<section id="features" class="features"><div class="wrap">
  <div class="sec-head"><div class="kicker">Features</div><h2>Everything a food log needs. Nothing it doesn't.</h2></div>
  <div class="grid">
    <div class="feat"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c.6 3.2 5 5 5 10a5 5 0 0 1-10 0c0-2.3 1.2-3.8 2.4-4.8.2 1.6 1 2.6 2.1 3 .1-3.2-.8-5.6.5-8.2z"/></svg></div><h3>Calories and protein</h3><p>Every item gets both, so you can hit a protein target as well as a calorie limit.</p></div>
    <div class="feat"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.5-2.2 1.9-2.2 3.1"/><path d="M12 16.4h.01"/></svg></div><h3>Asks when unsure</h3><p>Follow-up questions instead of silent guesses, for the details that move the number.</p></div>
    <div class="feat"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg></div><h3>Daily goals</h3><p>Set calorie and protein goals. /today shows where you stand at a glance.</p></div>
    <div class="feat"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 20h16"/><path d="M7 16v-5"/><path d="M12 16V7"/><path d="M17 16v-8"/></svg></div><h3>Charts in Telegram</h3><p>Week and month trends open in a built-in mini app. No extra app to install.</p></div>
    <div class="feat"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg></div><h3>Gentle reminders</h3><p>An optional daily nudge at the time you choose, so a skipped meal doesn't become a skipped week.</p></div>
    <div class="feat"><div class="ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4.5h-4.5"/></svg></div><h3>Never loses an entry</h3><p>If the AI is briefly unavailable, your meal is queued and retried automatically.</p></div>
  </div>
</div></section>

<section id="pricing"><div class="wrap">
  <div class="sec-head"><div class="kicker">Pricing</div><h2>Free while we're in beta.</h2></div>
  <div class="price">
    <span class="tag">Beta</span>
    <div class="amt">$0</div><div class="per">while TeleCal is invite-only</div>
    <ul>
      <li><svg width="16" height="16" aria-hidden="true"><use href="#check"/></svg>Unlimited meal logging</li>
      <li><svg width="16" height="16" aria-hidden="true"><use href="#check"/></svg>Calories and protein</li>
      <li><svg width="16" height="16" aria-hidden="true"><use href="#check"/></svg>Goals, reminders and charts</li>
    </ul>
    <a class="btn" href="https://t.me/{{BOT_USERNAME}}?start=access">Request access</a>
    <small>Paid plans may come later. Beta users will hear about them first.</small>
  </div>
</div></section>

<section id="faq" style="padding-top:0"><div class="wrap">
  <div class="sec-head"><div class="kicker">FAQ</div><h2>Questions</h2></div>
  <div class="faq">
    <details open><summary>How accurate are the estimates?</summary><p>They're AI estimates from your description, not lab measurements. For common foods they land close, and more detail (portion, cooking method) makes them better. TeleCal is a tracking aid, not medical advice.</p></details>
    <details><summary>Does it know local dishes?</summary><p>Yes. Describe anything, like sinigang, a Jollibee Chickenjoy meal or your mom's pasta, and it will ask about portions when it needs to.</p></details>
    <details><summary>What happens to my data?</summary><p>Your food log is stored on TeleCal's server. To estimate a meal, its description is sent to an AI provider (OpenAI, Anthropic or Google). Nothing else about you is shared.</p></details>
    <details><summary>Why Telegram?</summary><p>You already have it open. There's nothing to install, no new account, and it works the same on your phone, desktop and the web.</p></details>
    <details><summary>Can I fix a mistake or log yesterday's dinner?</summary><p>Yes. Edit or delete today's entries, and log to yesterday or any past date with <b>/log yesterday</b> or <b>/log jan 31</b>.</p></details>
    <details><summary>How do I get access?</summary><p>Tap Request access. It opens TeleCal in Telegram, where you send a request with one tap. You'll get a message in the same chat once you're approved.</p></details>
  </div>
</div></section>

<div class="band">
  <h2>Your next meal is a text away.</h2>
  <p>Request access and start logging in Telegram today.</p>
  <a class="btn" href="https://t.me/{{BOT_USERNAME}}?start=access">Request access</a>
</div>
</main>

<footer><div class="wrap">
  <a class="brand" href="#top" style="font-size:15px"><svg width="22" height="22" aria-hidden="true"><use href="#mark"/></svg>TeleCal</a>
  <span class="sp"></span>
  <span>Made in Manila</span>
  <a href="https://t.me/{{BOT_USERNAME}}">Open in Telegram</a>
  <span>© 2026 TeleCal</span>
</div></footer>

</body>
</html>
```

- [ ] **Step 2: Ignore raw screenshots.** Append to `.gitignore`:

```
# Raw phone screenshots; build-landing-assets.sh writes the committed versions
scripts/screenshots/
```

- [ ] **Step 3: Check for emojis.** `perl -CSD -ne 'print "$.: $_" if /[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]/' src/web/views/landing.html` → no output.

- [ ] **Step 4: Run tests.** `bun test src/web` → all pass.

- [ ] **Step 5: Look at it.** Serve the page without starting the bot (no Telegram calls; `.env` supplies the config the import needs):

```bash
bun -e 'import { createFetchHandler } from "./src/web/server"; import { createTestDb } from "./src/db/test-helpers"; import { UsersRepository } from "./src/db/repositories/users"; import { FoodLogsRepository } from "./src/db/repositories/food-logs"; const db = createTestDb(); Bun.serve({ port: 3999, fetch: createFetchHandler({ usersRepo: new UsersRepository(db), foodLogsRepo: new FoodLogsRepository(db), botUsername: "TeleCalBot", baseUrl: "http://localhost:3999" }) }); console.log("http://localhost:3999")'
```

Check at 375 px and 1280 px wide, light and dark (`prefers-color-scheme` in devtools rendering panel): no horizontal scroll, the hero phone shows a striped frame labelled "/log conversation", the nav links hide on narrow screens, and `http://localhost:3999/#tgWebAppData=x` lands on `/app#tgWebAppData=x`.

- [ ] **Step 6: Commit.**

```bash
git add src/web/views/landing.html .gitignore
git commit -m "feat(web): landing page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Link-preview image and asset script

**Files:**
- Create: `scripts/og.html`
- Create: `scripts/build-landing-assets.sh`
- Create (generated): `src/web/public/og.png`

**Interfaces:**
- Produces: `src/web/public/og.png` (1200×630). The script also writes `shot-log.jpg`, `shot-today.jpg`, `shot-charts.jpg` when raw files exist in `scripts/screenshots/`.

- [ ] **Step 1: Create `scripts/og.html`:**

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box }
  body { width:1200px; height:630px; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif; color:#1B1530;
         background:radial-gradient(900px 600px at 95% 110%, rgba(109,74,255,.28), transparent 60%), #F8F6FF; display:flex; align-items:center; padding:0 80px; gap:56px }
  .copy { flex:1 }
  .brand { display:flex; align-items:center; gap:14px; font-size:30px; font-weight:700; margin-bottom:44px }
  h1 { font-size:76px; line-height:1.02; letter-spacing:-.04em; font-weight:750; margin-bottom:24px }
  p { font-size:28px; color:#665F80 }
  .chat { width:400px; display:flex; flex-direction:column; gap:14px }
  .b { font-size:24px; line-height:1.35; padding:16px 22px; border-radius:28px; max-width:92% }
  .me { align-self:flex-end; background:#6D4AFF; color:#fff; border-bottom-right-radius:8px }
  .bot { align-self:flex-start; background:#fff; border-bottom-left-radius:8px; box-shadow:0 2px 6px rgba(27,21,48,.08) }
  .btn { align-self:flex-start; background:#6D4AFF; color:#fff; font-weight:600; font-size:22px; border-radius:16px; padding:14px 22px }
</style></head><body>
  <div class="copy">
    <div class="brand"><svg width="52" height="52" viewBox="0 0 24 24"><rect width="24" height="24" rx="7" fill="#6D4AFF"/><path d="M6.5 8.5a3 3 0 0 1 3-3h5a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-3.2L8.6 17.6c-.4.3-.9 0-.9-.4v-2.3a3 3 0 0 1-1.2-2.4z" fill="#fff"/><circle cx="12" cy="10.2" r="1.7" fill="#6D4AFF"/></svg>TeleCal</div>
    <h1>Track calories by just texting.</h1>
    <p>AI calorie and protein tracking inside Telegram.</p>
  </div>
  <div class="chat">
    <div class="b me">chicken adobo with rice</div>
    <div class="b bot">Chicken adobo, 2 pcs<br>Steamed rice, 1 cup<br><b>625 cal · 42 g protein</b></div>
    <div class="btn">Log 625 cal · 42 g</div>
  </div>
</body></html>
```

- [ ] **Step 2: Create `scripts/build-landing-assets.sh`:**

```bash
#!/usr/bin/env bash
# Rebuilds the landing page's images in src/web/public/. macOS only (sips, Chrome).
# Run from the repo root:  bash scripts/build-landing-assets.sh
#
# Raw phone screenshots go in scripts/screenshots/ (gitignored), named
# shot-log, shot-today and shot-charts with any image extension. Missing ones are skipped.
set -euo pipefail

OUT=src/web/public
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --screenshot="$OUT/og.png" "file://$PWD/scripts/og.html" 2>/dev/null
echo "wrote $OUT/og.png"

for name in shot-log shot-today shot-charts; do
  src=$(ls scripts/screenshots/"$name".* 2>/dev/null | head -1 || true)
  if [ -z "$src" ]; then
    echo "skip $name (no scripts/screenshots/$name.*)"
    continue
  fi
  sips -s format jpeg -s formatOptions 85 --resampleWidth 720 "$src" --out "$OUT/$name.jpg" >/dev/null
  echo "wrote $OUT/$name.jpg"
done
```

- [ ] **Step 3: Run it.** `bash scripts/build-landing-assets.sh` → prints `wrote src/web/public/og.png` and three `skip` lines.

- [ ] **Step 4: Check the image.** `sips -g pixelWidth -g pixelHeight src/web/public/og.png` → 1200 × 630. Open it (Read tool on the PNG) and confirm the text isn't clipped and nothing overlaps.

- [ ] **Step 5: Check it's served.** Add to the `routes` block in `src/web/server.test.ts`:

```ts
  test("/assets/og.png is served as PNG", async () => {
    const res = await get("/assets/og.png")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
  })
```

Run `bun test src/web/server.test.ts` → pass.

- [ ] **Step 6: Commit.**

```bash
git add scripts/og.html scripts/build-landing-assets.sh src/web/public/og.png src/web/server.test.ts
git commit -m "feat(web): link-preview image and asset build script

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `access_requests` table and repository

**Files:**
- Modify: `src/db/schema.sql` (after the `allowed_users` table)
- Create: `src/db/repositories/access-requests.ts`
- Test: `src/db/repositories/access-requests.test.ts`

**Interfaces:**
- Produces:

```ts
export type AccessRequestStatus = "pending" | "approved" | "declined"
export interface AccessRequest {
  telegram_id: number
  username: string | null
  first_name: string | null
  status: AccessRequestStatus
  requested_at: string
  decided_at: string | null
  decided_by: number | null
}
export type RequestResult = "created" | "already_pending" | "declined"
export class AccessRequestsRepository {
  constructor(db: Database)
  find(telegramId: number): AccessRequest | null
  request(telegramId: number, username: string | null | undefined, firstName: string | null | undefined): RequestResult
  decide(telegramId: number, status: "approved" | "declined", adminId: number): AccessRequest | null
  listPending(limit: number): AccessRequest[]
}
```

- [ ] **Step 1: Add the table.** In `src/db/schema.sql`, after the `allowed_users` table:

```sql
-- Access requests from non-allowlisted users (deep link from the landing page)
CREATE TABLE IF NOT EXISTS access_requests (
  telegram_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | declined
  requested_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by INTEGER
);
```

- [ ] **Step 2: Write the failing tests.** `src/db/repositories/access-requests.test.ts`:

```ts
// src/db/repositories/access-requests.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../test-helpers"
import { AccessRequestsRepository } from "./access-requests"

const USER = 42
const ADMIN = 1
let repo: AccessRequestsRepository

beforeEach(() => {
  repo = new AccessRequestsRepository(createTestDb())
})

describe("request", () => {
  test("creates a pending request with the user's names", () => {
    expect(repo.request(USER, "maria", "Maria")).toBe("created")
    expect(repo.find(USER)).toMatchObject({ telegram_id: USER, username: "maria", first_name: "Maria", status: "pending", decided_by: null })
  })

  test("stores missing names as null", () => {
    repo.request(USER, undefined, undefined)
    expect(repo.find(USER)).toMatchObject({ username: null, first_name: null })
  })

  test("a second request while pending is already_pending", () => {
    repo.request(USER, "maria", "Maria")
    expect(repo.request(USER, "maria", "Maria")).toBe("already_pending")
  })

  test("a declined user stays declined", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "declined", ADMIN)
    expect(repo.request(USER, "maria", "Maria")).toBe("declined")
    expect(repo.find(USER)?.status).toBe("declined")
  })

  test("an approved user who was later removed can request again", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "approved", ADMIN)
    expect(repo.request(USER, "maria2", "Maria")).toBe("created")
    expect(repo.find(USER)).toMatchObject({ status: "pending", username: "maria2", decided_at: null, decided_by: null })
  })
})

describe("decide", () => {
  test("approves a pending request and records who decided", () => {
    repo.request(USER, "maria", "Maria")
    const decided = repo.decide(USER, "approved", ADMIN)
    expect(decided).toMatchObject({ status: "approved", decided_by: ADMIN })
    expect(decided?.decided_at).not.toBeNull()
  })

  test("returns null when the request is not pending", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "approved", ADMIN)
    expect(repo.decide(USER, "declined", 2)).toBeNull()
    expect(repo.find(USER)).toMatchObject({ status: "approved", decided_by: ADMIN })
  })

  test("returns null when there is no request", () => {
    expect(repo.decide(USER, "approved", ADMIN)).toBeNull()
  })
})

describe("listPending", () => {
  test("lists only pending requests, capped by limit", () => {
    repo.request(1, "a", "A")
    repo.request(2, "b", "B")
    repo.request(3, "c", "C")
    repo.decide(2, "approved", ADMIN)
    expect(repo.listPending(10).map((r) => r.telegram_id)).toEqual([1, 3])
    expect(repo.listPending(1)).toHaveLength(1)
  })
})

describe("find", () => {
  test("returns null for an unknown user", () => {
    expect(repo.find(999)).toBeNull()
  })
})
```

- [ ] **Step 3: Run them and confirm they fail.** `bun test src/db/repositories/access-requests.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement.** `src/db/repositories/access-requests.ts`:

```ts
// src/db/repositories/access-requests.ts
import { Database } from "bun:sqlite"

export type AccessRequestStatus = "pending" | "approved" | "declined"

export interface AccessRequest {
  telegram_id: number
  username: string | null
  first_name: string | null
  status: AccessRequestStatus
  requested_at: string
  decided_at: string | null
  decided_by: number | null
}

/** created = admins should be notified; the other two are not new requests. */
export type RequestResult = "created" | "already_pending" | "declined"

export class AccessRequestsRepository {
  constructor(private db: Database) {}

  find(telegramId: number): AccessRequest | null {
    const stmt = this.db.prepare("SELECT * FROM access_requests WHERE telegram_id = ?")
    return (stmt.get(telegramId) as AccessRequest | null) ?? null
  }

  request(
    telegramId: number,
    username: string | null | undefined,
    firstName: string | null | undefined
  ): RequestResult {
    const existing = this.find(telegramId)
    if (existing?.status === "pending") return "already_pending"
    // Declined is sticky so a declined user can't re-notify admins; /admin add still works.
    if (existing?.status === "declined") return "declined"

    // No row, or approved and since removed from the allowlist: (re)open as pending.
    const stmt = this.db.prepare(`
      INSERT INTO access_requests (telegram_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        status = 'pending',
        requested_at = datetime('now'),
        decided_at = NULL,
        decided_by = NULL
    `)
    stmt.run(telegramId, username ?? null, firstName ?? null)
    return "created"
  }

  /** Acts only on a pending request, so a second admin's tap is a no-op (null). */
  decide(telegramId: number, status: "approved" | "declined", adminId: number): AccessRequest | null {
    const stmt = this.db.prepare(`
      UPDATE access_requests
      SET status = ?, decided_at = datetime('now'), decided_by = ?
      WHERE telegram_id = ? AND status = 'pending'
    `)
    const result = stmt.run(status, adminId, telegramId)
    return result.changes === 0 ? null : this.find(telegramId)
  }

  listPending(limit: number): AccessRequest[] {
    const stmt = this.db.prepare(`
      SELECT * FROM access_requests
      WHERE status = 'pending'
      ORDER BY requested_at, telegram_id
      LIMIT ?
    `)
    return stmt.all(limit) as AccessRequest[]
  }
}
```

- [ ] **Step 5: Run tests.** `bun test` → all pass.

- [ ] **Step 6: Commit.**

```bash
git add src/db/schema.sql src/db/repositories/access-requests.ts src/db/repositories/access-requests.test.ts
git commit -m "feat(db): access_requests table and repository

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Access flow pieces — help text, keyboards, admin notifier, decision handler

**Files:**
- Create: `src/bot/help.ts`
- Create: `src/bot/access.ts`
- Test: `src/bot/access.test.ts`

**Interfaces:**
- Consumes: `AccessRequestsRepository`, `AccessRequest` (Task 5); `AllowedUsersRepository.add(telegramId, addedBy)`, `isAllowed(telegramId)`; `smartEdit` from `src/bot/utils/smart-reply.ts`.
- Produces (from `src/bot/help.ts`): `export const HELP_TEXT: string`.
- Produces (from `src/bot/access.ts`):

```ts
export const ACCESS_REQUEST_DATA = "access:req"
export const INVITE_PROMPT: string
export const REQUEST_SENT: string
export const REQUEST_PENDING: string
export const ALREADY_PENDING: string
export const NOT_APPROVED: string
export const INVITE_ONLY: string
export const APPROVED_MESSAGE: string
export const DECLINED_MESSAGE: string
export function requestAccessKeyboard(): InlineKeyboard
export function decisionKeyboard(telegramId: number): InlineKeyboard
export function parseDecision(data: string | undefined): { status: "approved" | "declined"; telegramId: number } | null
export function formatAccessRequest(req: Pick<AccessRequest, "telegram_id" | "username" | "first_name">): string
export type NotifyAdmins = (req: AccessRequest) => Promise<void>
export function createAdminNotifier(api: Pick<Api, "sendMessage">, adminIds: number[]): NotifyAdmins
export async function sendPendingRequests(repo: AccessRequestsRepository, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>): Promise<void>
export interface AccessDecisionDeps { accessRequestsRepo: AccessRequestsRepository; allowedUsersRepo: AllowedUsersRepository; adminIds: number[] }
export function createAccessDecisionHandler(deps: AccessDecisionDeps): (ctx: Context) => Promise<void>
```

- [ ] **Step 1: Create `src/bot/help.ts`.** Copy the string verbatim from the `/start` handler in `src/bot/index.ts`:

```ts
// src/bot/help.ts
// Shared by /start and the access-approval message.
export const HELP_TEXT =
  "Welcome to TeleCal! 🍽️\n\n" +
  "Track your calories and protein with AI-powered estimation.\n\n" +
  "Commands:\n" +
  "/log - Log what you ate\n" +
  "/today - See today's calories and protein\n" +
  "/week - See past 7 days\n" +
  "/month - See past 30 days\n" +
  "/edit - Edit a food entry\n" +
  "/delete - Delete a food entry\n" +
  "/pending - View pending estimations\n" +
  "/usage - See your AI token usage\n" +
  "/settings - Change preferences\n\n" +
  'Tip: Type "cancel" to abort any active conversation.'
```

- [ ] **Step 2: Write the failing tests.** `src/bot/access.test.ts`:

```ts
// src/bot/access.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Api, Context } from "grammy"
import { createTestDb } from "../db/test-helpers"
import { AccessRequestsRepository } from "../db/repositories/access-requests"
import { AllowedUsersRepository } from "../db/repositories/allowed-users"
import {
  APPROVED_MESSAGE,
  DECLINED_MESSAGE,
  createAccessDecisionHandler,
  createAdminNotifier,
  decisionKeyboard,
  formatAccessRequest,
  parseDecision,
  requestAccessKeyboard,
  sendPendingRequests,
} from "./access"

const USER = 42
const ADMIN = 1
let accessRequestsRepo: AccessRequestsRepository
let allowedUsersRepo: AllowedUsersRepository

beforeEach(() => {
  const db = createTestDb()
  accessRequestsRepo = new AccessRequestsRepository(db)
  allowedUsersRepo = new AllowedUsersRepository(db)
})

function decisionCtx(data: string, from: { id: number; username?: string; first_name: string }) {
  return {
    from,
    chat: { id: from.id, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    api: { sendMessage: mock(() => Promise.resolve({})) },
  }
}

const handler = () => createAccessDecisionHandler({ accessRequestsRepo, allowedUsersRepo, adminIds: [ADMIN] })
const admin = { id: ADMIN, username: "boss", first_name: "Ray" }

describe("keyboards and parsing", () => {
  test("request keyboard has one Request access button", () => {
    expect(requestAccessKeyboard().inline_keyboard).toEqual([[{ text: "Request access", callback_data: "access:req" }]])
  })

  test("decision keyboard round-trips through parseDecision", () => {
    const [[approve, decline]] = decisionKeyboard(USER).inline_keyboard as { text: string; callback_data: string }[][]
    expect(approve.text).toBe("Approve")
    expect(decline.text).toBe("Decline")
    expect(parseDecision(approve.callback_data)).toEqual({ status: "approved", telegramId: USER })
    expect(parseDecision(decline.callback_data)).toEqual({ status: "declined", telegramId: USER })
  })

  test("parseDecision rejects anything else", () => {
    for (const data of [undefined, "access:req", "access:ok:", "access:ok:12x", "log:ok:1"]) {
      expect(parseDecision(data)).toBeNull()
    }
  })
})

describe("formatAccessRequest", () => {
  test("includes name, handle and id", () => {
    expect(formatAccessRequest({ telegram_id: USER, username: "maria", first_name: "Maria" })).toBe(
      "Access request: Maria (@maria), id 42"
    )
  })

  test("copes with missing names", () => {
    expect(formatAccessRequest({ telegram_id: USER, username: null, first_name: null })).toBe("Access request: Unknown, id 42")
  })
})

describe("createAdminNotifier", () => {
  test("messages every admin with decision buttons and survives a failed send", async () => {
    accessRequestsRepo.request(USER, "maria", "Maria")
    const sendMessage = mock((chatId: number) => (chatId === 2 ? Promise.reject(new Error("blocked")) : Promise.resolve({})))
    const notify = createAdminNotifier({ sendMessage } as unknown as Pick<Api, "sendMessage">, [ADMIN, 2, 3])

    await notify(accessRequestsRepo.find(USER)!)

    expect(sendMessage).toHaveBeenCalledTimes(3)
    const [chatId, text, options] = sendMessage.mock.calls[0] as unknown as [number, string, { reply_markup: unknown }]
    expect(chatId).toBe(ADMIN)
    expect(text).toBe("Access request: Maria (@maria), id 42")
    expect(options.reply_markup).toEqual(decisionKeyboard(USER))
  })
})

describe("sendPendingRequests", () => {
  test("says so when there are none", async () => {
    const reply = mock(() => Promise.resolve())
    await sendPendingRequests(accessRequestsRepo, reply)
    expect(reply).toHaveBeenCalledWith("No pending requests.")
  })

  test("sends one message with buttons per pending request", async () => {
    accessRequestsRepo.request(USER, "maria", "Maria")
    accessRequestsRepo.request(43, "juan", "Juan")
    const reply = mock(() => Promise.resolve())
    await sendPendingRequests(accessRequestsRepo, reply)
    expect(reply).toHaveBeenCalledTimes(2)
    expect(reply.mock.calls[0]).toEqual(["Access request: Maria (@maria), id 42", decisionKeyboard(USER)] as never)
  })
})

describe("createAccessDecisionHandler", () => {
  beforeEach(() => {
    accessRequestsRepo.request(USER, "maria", "Maria")
  })

  test("approve allowlists the user, edits the admin message and tells the user", async () => {
    const ctx = decisionCtx(`access:ok:${USER}`, admin)
    await handler()(ctx as unknown as Context)

    expect(allowedUsersRepo.isAllowed(USER)).toBe(true)
    expect(accessRequestsRepo.find(USER)?.status).toBe("approved")
    expect(ctx.editMessageText).toHaveBeenCalledWith("Access request: Maria (@maria), id 42\n\nApproved by @boss", undefined)
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(USER, APPROVED_MESSAGE)
  })

  test("decline does not allowlist and sends the decline message", async () => {
    const ctx = decisionCtx(`access:no:${USER}`, admin)
    await handler()(ctx as unknown as Context)

    expect(allowedUsersRepo.isAllowed(USER)).toBe(false)
    expect(accessRequestsRepo.find(USER)?.status).toBe("declined")
    expect(ctx.editMessageText).toHaveBeenCalledWith("Access request: Maria (@maria), id 42\n\nDeclined by @boss", undefined)
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(USER, DECLINED_MESSAGE)
  })

  test("a non-admin is refused and nothing changes", async () => {
    const ctx = decisionCtx(`access:ok:${USER}`, { id: 77, first_name: "Eve" })
    await handler()(ctx as unknown as Context)

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "Admins only." })
    expect(allowedUsersRepo.isAllowed(USER)).toBe(false)
    expect(accessRequestsRepo.find(USER)?.status).toBe("pending")
  })

  test("a second decision answers Already and sends nothing", async () => {
    await handler()(decisionCtx(`access:ok:${USER}`, admin) as unknown as Context)
    const second = decisionCtx(`access:no:${USER}`, admin)
    await handler()(second as unknown as Context)

    expect(second.answerCallbackQuery).toHaveBeenCalledWith({ text: "Already approved." })
    expect(second.api.sendMessage).not.toHaveBeenCalled()
    expect(accessRequestsRepo.find(USER)?.status).toBe("approved")
  })

  test("an allowlisted user pressing an old Request access button is told they're in", async () => {
    const ctx = decisionCtx("access:req", { id: USER, first_name: "Maria" })
    await handler()(ctx as unknown as Context)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: "You already have access." })
  })

  test("still succeeds when the user can't be messaged", async () => {
    const ctx = decisionCtx(`access:ok:${USER}`, admin)
    ctx.api.sendMessage = mock(() => Promise.reject(new Error("bot was blocked by the user")))
    await handler()(ctx as unknown as Context)
    expect(allowedUsersRepo.isAllowed(USER)).toBe(true)
  })
})
```

- [ ] **Step 3: Run them and confirm they fail.** `bun test src/bot/access.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement.** `src/bot/access.ts`:

```ts
// src/bot/access.ts
// The access-request flow: a non-allowlisted user taps Request access (see the
// allowlist middleware), admins get a DM with Approve / Decline, and the
// decision handler here applies it.
import { InlineKeyboard, type Api, type Context } from "grammy"
import type { AccessRequest, AccessRequestsRepository } from "../db/repositories/access-requests"
import type { AllowedUsersRepository } from "../db/repositories/allowed-users"
import { HELP_TEXT } from "./help"
import { smartEdit } from "./utils/smart-reply"

export const ACCESS_REQUEST_DATA = "access:req"

export const INVITE_PROMPT = "TeleCal is invite-only while in beta. Want in?"
export const REQUEST_SENT = "Request sent. You'll get a message here once you're approved."
export const REQUEST_PENDING = "Your request is in. You'll get a message here once you're approved."
export const ALREADY_PENDING = "Already requested. Hang tight."
export const NOT_APPROVED = "Your request wasn't approved."
export const INVITE_ONLY = "TeleCal is invite-only."
export const APPROVED_MESSAGE = `You're in.\n\n${HELP_TEXT}`
export const DECLINED_MESSAGE = "Thanks for your interest. TeleCal can't take you on right now."

const MAX_PENDING_SHOWN = 10

export function requestAccessKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Request access", ACCESS_REQUEST_DATA)
}

export function decisionKeyboard(telegramId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Approve", `access:ok:${telegramId}`)
    .text("Decline", `access:no:${telegramId}`)
}

export function parseDecision(
  data: string | undefined
): { status: "approved" | "declined"; telegramId: number } | null {
  const match = data?.match(/^access:(ok|no):(\d+)$/)
  if (!match) return null
  return { status: match[1] === "ok" ? "approved" : "declined", telegramId: Number(match[2]) }
}

export function formatAccessRequest(
  req: Pick<AccessRequest, "telegram_id" | "username" | "first_name">
): string {
  const name = req.first_name?.trim() || "Unknown"
  const handle = req.username ? ` (@${req.username})` : ""
  return `Access request: ${name}${handle}, id ${req.telegram_id}`
}

export type NotifyAdmins = (req: AccessRequest) => Promise<void>

export function createAdminNotifier(api: Pick<Api, "sendMessage">, adminIds: number[]): NotifyAdmins {
  return async (req) => {
    for (const adminId of adminIds) {
      try {
        await api.sendMessage(adminId, formatAccessRequest(req), {
          reply_markup: decisionKeyboard(req.telegram_id),
        })
      } catch (error) {
        // Usually an admin who never started the bot. /admin requests still lists it.
        console.error(`[access] could not notify admin ${adminId}:`, error)
      }
    }
  }
}

/** /admin requests: one message per pending request, each with its own buttons. */
export async function sendPendingRequests(
  repo: AccessRequestsRepository,
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>
): Promise<void> {
  const pending = repo.listPending(MAX_PENDING_SHOWN)
  if (pending.length === 0) {
    await reply("No pending requests.")
    return
  }
  for (const req of pending) {
    await reply(formatAccessRequest(req), decisionKeyboard(req.telegram_id))
  }
}

export interface AccessDecisionDeps {
  accessRequestsRepo: AccessRequestsRepository
  allowedUsersRepo: AllowedUsersRepository
  adminIds: number[]
}

/** Handles access: callbacks that get past the allowlist (admins and allowlisted users). */
export function createAccessDecisionHandler(deps: AccessDecisionDeps) {
  const { accessRequestsRepo, allowedUsersRepo, adminIds } = deps

  return async (ctx: Context): Promise<void> => {
    const data = ctx.callbackQuery?.data
    if (data === ACCESS_REQUEST_DATA) {
      await ctx.answerCallbackQuery({ text: "You already have access." })
      return
    }

    const decision = parseDecision(data)
    if (!decision) {
      await ctx.answerCallbackQuery()
      return
    }

    const adminId = ctx.from?.id
    if (!adminId || !adminIds.includes(adminId)) {
      await ctx.answerCallbackQuery({ text: "Admins only." })
      return
    }

    const decided = accessRequestsRepo.decide(decision.telegramId, decision.status, adminId)
    if (!decided) {
      const current = accessRequestsRepo.find(decision.telegramId)
      await ctx.answerCallbackQuery({ text: current ? `Already ${current.status}.` : "Request not found." })
      return
    }

    if (decided.status === "approved") {
      allowedUsersRepo.add(decided.telegram_id, adminId)
    }

    await ctx.answerCallbackQuery()
    const by = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name ?? String(adminId)
    const verb = decided.status === "approved" ? "Approved" : "Declined"
    await smartEdit(ctx, `${formatAccessRequest(decided)}\n\n${verb} by ${by}`)

    try {
      await ctx.api.sendMessage(
        decided.telegram_id,
        decided.status === "approved" ? APPROVED_MESSAGE : DECLINED_MESSAGE
      )
    } catch (error) {
      // The decision stands; the user just won't hear about it until they message the bot.
      console.error(`[access] could not message user ${decided.telegram_id}:`, error)
    }
  }
}
```

- [ ] **Step 5: Run tests.** `bun test src/bot/access.test.ts` → all pass. If the `editMessageText` assertions fail only on the second argument, check what `smartEdit` passes when no options are given (it forwards `options`, i.e. `undefined`), and match that.

- [ ] **Step 6: Commit.**

```bash
git add src/bot/help.ts src/bot/access.ts src/bot/access.test.ts
git commit -m "feat(bot): access request notifier and admin decision handler

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The gate for non-allowlisted users

**Files:**
- Modify: `src/bot/middleware/allowlist.ts` (full rewrite below)
- Test: `src/bot/middleware/allowlist.test.ts` (new)

**Interfaces:**
- Consumes: from Task 6 `ACCESS_REQUEST_DATA`, `INVITE_PROMPT`, `REQUEST_SENT`, `REQUEST_PENDING`, `ALREADY_PENDING`, `NOT_APPROVED`, `INVITE_ONLY`, `requestAccessKeyboard`, `NotifyAdmins`; from Task 5 `AccessRequestsRepository`.
- Produces:

```ts
export interface AllowlistDeps {
  allowedUsersRepo: AllowedUsersRepository
  accessRequestsRepo: AccessRequestsRepository
  adminIds: number[]
  notifyAdmins: NotifyAdmins
}
export function createAllowlistMiddleware(deps: AllowlistDeps): (ctx: Context, next: NextFunction) => Promise<void>
```

(The spec lists positional parameters; this takes one deps object with `adminIds` added, so tests don't depend on `ADMIN_USERS` in `.env`.)

- [ ] **Step 1: Write the failing tests.** `src/bot/middleware/allowlist.test.ts`:

```ts
// src/bot/middleware/allowlist.test.ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import {
  ALREADY_PENDING,
  INVITE_ONLY,
  INVITE_PROMPT,
  NOT_APPROVED,
  REQUEST_PENDING,
  REQUEST_SENT,
  requestAccessKeyboard,
} from "../access"
import { createAllowlistMiddleware } from "./allowlist"

const ADMIN = 1
const MEMBER = 2
const STRANGER = 42
let accessRequestsRepo: AccessRequestsRepository
let allowedUsersRepo: AllowedUsersRepository
let notifyAdmins: ReturnType<typeof mock>
let gate: ReturnType<typeof createAllowlistMiddleware>

beforeEach(() => {
  const db = createTestDb()
  accessRequestsRepo = new AccessRequestsRepository(db)
  allowedUsersRepo = new AllowedUsersRepository(db)
  allowedUsersRepo.add(MEMBER, ADMIN)
  notifyAdmins = mock(() => Promise.resolve())
  gate = createAllowlistMiddleware({ allowedUsersRepo, accessRequestsRepo, adminIds: [ADMIN], notifyAdmins })
})

function messageCtx(userId: number, text = "/start") {
  return {
    from: { id: userId, first_name: "Maria", username: "maria" },
    chat: { id: userId, type: "private" },
    message: { text },
    reply: mock(() => Promise.resolve()),
  }
}

function callbackCtx(userId: number, data: string) {
  return {
    from: { id: userId, first_name: "Maria", username: "maria" },
    chat: { id: userId, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

async function run(ctx: object) {
  const next = mock(() => Promise.resolve())
  await gate(ctx as unknown as Context, next)
  return next
}

describe("allowed users", () => {
  test("admins pass through", async () => {
    expect(await run(messageCtx(ADMIN))).toHaveBeenCalled()
  })

  test("allowlisted users pass through", async () => {
    expect(await run(messageCtx(MEMBER))).toHaveBeenCalled()
  })

  test("updates with no sender are dropped", async () => {
    const next = await run({ chat: { id: 5, type: "channel" } })
    expect(next).not.toHaveBeenCalled()
  })
})

describe("strangers", () => {
  test("/start gets the invite prompt with a Request access button", async () => {
    const ctx = messageCtx(STRANGER)
    const next = await run(ctx)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(INVITE_PROMPT, { reply_markup: requestAccessKeyboard() })
  })

  test("any other message gets the same prompt", async () => {
    const ctx = messageCtx(STRANGER, "/log")
    await run(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(INVITE_PROMPT, { reply_markup: requestAccessKeyboard() })
  })

  test("a stranger with a pending request is told so, without a button", async () => {
    accessRequestsRepo.request(STRANGER, "maria", "Maria")
    const ctx = messageCtx(STRANGER)
    await run(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(REQUEST_PENDING, undefined)
  })

  test("Request access creates a request, confirms it and notifies admins once", async () => {
    const ctx = callbackCtx(STRANGER, "access:req")
    const next = await run(ctx)

    expect(next).not.toHaveBeenCalled()
    expect(accessRequestsRepo.find(STRANGER)).toMatchObject({ status: "pending", username: "maria", first_name: "Maria" })
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    expect(ctx.editMessageText).toHaveBeenCalledWith(REQUEST_SENT, undefined)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
    expect((notifyAdmins.mock.calls[0] as unknown[])[0]).toMatchObject({ telegram_id: STRANGER })
  })

  test("a second tap does not notify again", async () => {
    await run(callbackCtx(STRANGER, "access:req"))
    const second = callbackCtx(STRANGER, "access:req")
    await run(second)
    expect(second.answerCallbackQuery).toHaveBeenCalledWith({ text: ALREADY_PENDING })
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
  })

  test("a declined user tapping does not notify", async () => {
    accessRequestsRepo.request(STRANGER, "maria", "Maria")
    accessRequestsRepo.decide(STRANGER, "declined", ADMIN)
    const ctx = callbackCtx(STRANGER, "access:req")
    await run(ctx)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: NOT_APPROVED })
    expect(notifyAdmins).not.toHaveBeenCalled()
  })

  test("other buttons are answered instead of left spinning", async () => {
    const ctx = callbackCtx(STRANGER, "settings:goal")
    await run(ctx)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: INVITE_ONLY })
  })
})
```

- [ ] **Step 2: Run them and confirm they fail.** `bun test src/bot/middleware/allowlist.test.ts` → FAIL (old signature takes a repo, not a deps object).

- [ ] **Step 3: Implement.** Replace `src/bot/middleware/allowlist.ts` with:

```ts
// src/bot/middleware/allowlist.ts
import { Context, NextFunction } from "grammy"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import {
  ACCESS_REQUEST_DATA,
  ALREADY_PENDING,
  INVITE_ONLY,
  INVITE_PROMPT,
  NOT_APPROVED,
  REQUEST_PENDING,
  REQUEST_SENT,
  requestAccessKeyboard,
  type NotifyAdmins,
} from "../access"
import { smartEdit, smartReply } from "../utils/smart-reply"

export interface AllowlistDeps {
  allowedUsersRepo: AllowedUsersRepository
  accessRequestsRepo: AccessRequestsRepository
  adminIds: number[]
  notifyAdmins: NotifyAdmins
}

/**
 * Admins and allowlisted users continue down the chain. Everyone else is
 * handled entirely here and never reaches the rest of the bot (so no users
 * row is created for them): they get the invite prompt, and its button
 * files an access request.
 */
export function createAllowlistMiddleware(deps: AllowlistDeps) {
  const { allowedUsersRepo, accessRequestsRepo, adminIds, notifyAdmins } = deps

  async function handleRequest(ctx: Context, userId: number): Promise<void> {
    const result = accessRequestsRepo.request(userId, ctx.from?.username, ctx.from?.first_name)
    if (result === "already_pending") {
      await ctx.answerCallbackQuery({ text: ALREADY_PENDING })
      return
    }
    if (result === "declined") {
      await ctx.answerCallbackQuery({ text: NOT_APPROVED })
      return
    }
    await ctx.answerCallbackQuery()
    await smartEdit(ctx, REQUEST_SENT)
    await notifyAdmins(accessRequestsRepo.find(userId)!)
  }

  return async (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id
    if (!userId) return

    if (adminIds.includes(userId) || allowedUsersRepo.isAllowed(userId)) {
      return next()
    }

    if (ctx.callbackQuery) {
      if (ctx.callbackQuery.data === ACCESS_REQUEST_DATA) {
        return handleRequest(ctx, userId)
      }
      await ctx.answerCallbackQuery({ text: INVITE_ONLY })
      return
    }

    if (!ctx.chat) return

    if (accessRequestsRepo.find(userId)?.status === "pending") {
      await smartReply(ctx, REQUEST_PENDING)
      return
    }
    await smartReply(ctx, INVITE_PROMPT, { reply_markup: requestAccessKeyboard() })
  }
}
```

- [ ] **Step 4: Run the gate tests.** `bun test src/bot/middleware/allowlist.test.ts` → all pass. (`src/bot/index.ts` still calls the old signature; Task 8 fixes it. Bun doesn't type-check, so the rest of the suite still runs.)

- [ ] **Step 5: Commit.**

```bash
git add src/bot/middleware/allowlist.ts src/bot/middleware/allowlist.test.ts
git commit -m "feat(bot): invite gate lets strangers request access

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Wire it into the bot and `/admin`

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `src/bot/commands/admin.ts`

**Interfaces:**
- Consumes: `createAllowlistMiddleware(deps: AllowlistDeps)` (Task 7); `createAdminNotifier`, `createAccessDecisionHandler`, `sendPendingRequests` (Task 6); `HELP_TEXT` (Task 6); `AccessRequestsRepository` (Task 5).
- Produces: `createAdminCommand(repo: AllowedUsersRepository, usageRepo: UsageRepository, deps: AdminDeps, accessRequestsRepo: AccessRequestsRepository)`.

- [ ] **Step 1: Wire `src/bot/index.ts`.**

Add imports:

```ts
import { AccessRequestsRepository } from "../db/repositories/access-requests"
import { createAccessDecisionHandler, createAdminNotifier } from "./access"
import { HELP_TEXT } from "./help"
```

Replace

```ts
  bot.use(createAllowlistMiddleware(allowedUsersRepo))
```

with

```ts
  const accessRequestsRepo = new AccessRequestsRepository(db)
  bot.use(
    createAllowlistMiddleware({
      allowedUsersRepo,
      accessRequestsRepo,
      adminIds: config.adminUsers,
      notifyAdmins: createAdminNotifier(bot.api, config.adminUsers),
    })
  )
```

Replace the whole `bot.command("start", ...)` block with:

```ts
  bot.command("start", async (ctx) => {
    await smartReply(ctx, HELP_TEXT)
  })
```

Change the admin registration to pass the new repo:

```ts
  bot.command("admin", createAdminCommand(allowedUsersRepo, usageRepo, { foodLogsRepo, usersRepo, aiService }, accessRequestsRepo))
```

In the `callback_query:data` router, add before `return next()`:

```ts
    if (data?.startsWith("access:")) {
      return createAccessDecisionHandler({ accessRequestsRepo, allowedUsersRepo, adminIds: config.adminUsers })(ctx)
    }
```

- [ ] **Step 2: Update `src/bot/commands/admin.ts`.**

Add imports:

```ts
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import { sendPendingRequests } from "../access"
```

Change the signature:

```ts
export function createAdminCommand(
  repo: AllowedUsersRepository,
  usageRepo: UsageRepository,
  deps: AdminDeps,
  accessRequestsRepo: AccessRequestsRepository
) {
```

Add `"/admin requests\n" +` after `"/admin list\n" +` in the help text.

In `case "add"`, after `repo.add(targetId, userId)`:

```ts
        // Close any pending request so the two paths can't disagree.
        accessRequestsRepo.decide(targetId, "approved", userId)
```

Add a case before `default`:

```ts
      case "requests": {
        await sendPendingRequests(accessRequestsRepo, (text, keyboard) =>
          smartReply(ctx, text, keyboard ? { reply_markup: keyboard } : undefined)
        )
        break
      }
```

- [ ] **Step 3: Type-check.** Before Step 1, run `bunx tsc --noEmit -p . > /tmp/tsc-before.txt 2>&1 || true`. Now run `bunx tsc --noEmit -p . > /tmp/tsc-after.txt 2>&1 || true` and `diff /tmp/tsc-before.txt /tmp/tsc-after.txt`. Any new error in a file this plan touched must be fixed. If `bunx tsc` can't run (no network to fetch TypeScript), note that and continue.

- [ ] **Step 4: Run all tests.** `bun test` → all pass.

- [ ] **Step 5: Boot check.** With the owner's **test** bot token in the environment (never the production token): `TELEGRAM_BOT_TOKEN=<test token> DB_PATH=data/test.db bun run start` → logs `Database initialized`, `Web server running on port 3000`, `Bot @<testbot> started`. `curl -s localhost:3000/ | grep -c "t.me/<testbot>?start=access"` → 4 or more. Stop it with Ctrl-C. If no test token is available, skip this step and report that it was skipped.

- [ ] **Step 6: Commit.**

```bash
git add src/bot/index.ts src/bot/commands/admin.ts
git commit -m "feat(bot): wire access requests, /admin requests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md`
- Modify (do not stage): `CLAUDE.md`

- [ ] **Step 1: README features.** In `README.md` under `## Features`, replace

```
- **Mini App** - Interactive charts via Telegram Web App
```

with

```
- **Landing page** - Public page at `/` with a Request access button that deep-links into the bot
- **Mini App** - Interactive charts via Telegram Web App, served at `/app`
```

and replace

```
- **Access control** - Allowlist system for private use
```

with

```
- **Access control** - Allowlist, plus in-bot access requests that admins approve with one tap
```

- [ ] **Step 2: README commands.** In the Bot Commands table, change the `/admin` row's description to `Manage allowed users and access requests, view AI usage and cost, backfill protein (admin only)`.

- [ ] **Step 3: README landing assets.** Add a section before `## Testing`:

```markdown
## Landing page assets

`src/web/public/` holds the landing page's images. To regenerate them (macOS, needs Google Chrome):

1. Put raw phone screenshots in `scripts/screenshots/` as `shot-log`, `shot-today` and `shot-charts` (any image format).
2. Run `bash scripts/build-landing-assets.sh`. It renders `og.png` from `scripts/og.html` and writes 720 px JPEGs.
3. Commit the files in `src/web/public/`.
```

- [ ] **Step 4: CLAUDE.md (leave unstaged).** In `CLAUDE.md`:
  - Replace `- \`middleware/allowlist.ts\` - Access control via allowed_users table` with `- \`middleware/allowlist.ts\` - Gate: allowlisted users pass; strangers get an invite prompt and can file an access request (\`access.ts\` handles admin Approve/Decline)`.
  - Replace the Web Server bullets `- Mini App for viewing charts` and `- Single-page app at \`views/app.html\`` with `- Landing page at \`/\` (\`views/landing.html\`, \`{{BOT_USERNAME}}\`/\`{{BASE_URL}}\` filled at startup); images in \`public/\` served at \`/assets/*\`` and `- Mini App at \`/app\` (\`views/app.html\`); \`config.web.miniAppUrl\` points the View Charts buttons there`.
  - Under Database Tables, after `allowed_users`, add `- \`access_requests\` - Requests from non-allowlisted users (pending → approved | declined)`.

  `CLAUDE.md` already holds the owner's own uncommitted edits, so don't stage it. Report that these edits are waiting there alongside the owner's.

- [ ] **Step 5: Commit README only.**

```bash
git add README.md
git commit -m "docs: landing page, access requests, asset script

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After the plan: owner checklist (not for the implementer)

- Take the three screenshots per the spec's shot list, drop them in `scripts/screenshots/`, run `bash scripts/build-landing-assets.sh`, commit `src/web/public/shot-*.jpg`.
- Confirm or change the flagged copy: the FAQ's "Nothing else about you is shared", "Made in Manila", the Jollibee example.
- Run the full loop on the test bot: stranger `/start` → Request access → admin Approve → stranger can `/log`; an old View Charts button still opens the Mini App.
- Only then push to `main` (production deploy).
