// src/web/server.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../db/test-helpers"
import { FoodLogsRepository } from "../db/repositories/food-logs"
import { UsersRepository } from "../db/repositories/users"
import { FoodLibraryRepository } from "../db/repositories/food-library"
import { config } from "../config"
import { hashTelegramId } from "../analytics"
import { createFetchHandler, renderLanding } from "./server"
import { createValidInitData } from "./test-helpers"

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
  test("fills both placeholders everywhere, and an empty analytics slot", () => {
    const out = renderLanding("{{BOT_USERNAME}} {{BASE_URL}} {{BOT_USERNAME}}{{ANALYTICS}}", {
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

describe("landing analytics", () => {
  const withAnalytics = (analytics?: { apiKey: string; host: string; environment: string }) =>
    createFetchHandler({
      usersRepo: new UsersRepository(createTestDb()),
      foodLogsRepo: new FoodLogsRepository(createTestDb()),
      botUsername: "TeleCalTestBot",
      baseUrl: "https://telecal.example",
      analytics,
    })

  test("no PostHog script at all without a key", async () => {
    const body = await (await withAnalytics()(new Request("http://localhost/"))).text()
    expect(body).not.toContain("posthog")
  })

  test("with a key, PostHog runs cookieless with autocapture and replay off", async () => {
    const handler = withAnalytics({ apiKey: "phc_test", host: "https://us.i.posthog.com", environment: "production" })
    const body = await (await handler(new Request("http://localhost/"))).text()

    expect(body).toContain('posthog.init("phc_test"')
    expect(body).toContain('"api_host":"https://us.i.posthog.com"')
    expect(body).toContain('"persistence":"memory"')
    expect(body).toContain('"autocapture":false')
    expect(body).toContain('"disable_session_recording":true')
    expect(body).toContain('posthog.register({"environment":"production"})')
    expect(body).toContain('posthog.capture("$pageview")')
    expect(body).toContain("landing_cta_clicked")
  })

  test("config values can't break out of the script", async () => {
    const handler = withAnalytics({ apiKey: "</script><script>alert(1)", host: "https://us.i.posthog.com", environment: "production" })
    const body = await (await handler(new Request("http://localhost/"))).text()
    expect(body).not.toContain("</script><script>alert(1)")
  })

  test("every Request access link is tagged with where it sits on the page", async () => {
    const body = await (await withAnalytics()(new Request("http://localhost/"))).text()
    const placements = [...body.matchAll(/href="https:\/\/t\.me\/TeleCalTestBot\?start=access" data-cta="([a-z]+)"/g)].map((m) => m[1])
    expect(placements).toEqual(["nav", "hero", "pricing", "footer"])
  })
})

describe("mini app analytics", () => {
  const ANALYTICS = { apiKey: "phc_test", host: "https://us.i.posthog.com", environment: "production" }
  const handler = (deps: { analytics?: typeof ANALYTICS; analyticsIdSecret?: string }) =>
    createFetchHandler({
      usersRepo: new UsersRepository(createTestDb()),
      foodLogsRepo: new FoodLogsRepository(createTestDb()),
      botUsername: "TeleCalTestBot",
      baseUrl: "https://telecal.example",
      ...deps,
    })
  const getUser = (h: ReturnType<typeof createFetchHandler>) =>
    h(new Request("http://localhost/api/user", {
      headers: { Authorization: `tg-init-data ${createValidInitData({ id: 42, first_name: "Maria" }, config.telegram.botToken)}` },
    })).then((res) => res.json())

  test("/api/user carries the hashed ID when analytics is on", async () => {
    const user = await getUser(handler({ analytics: ANALYTICS, analyticsIdSecret: "s3cret" }))
    expect(user.analytics_id).toBe(hashTelegramId(42, "s3cret"))
  })

  test("/api/user has a null analytics_id when analytics is off", async () => {
    const user = await getUser(handler({}))
    expect(user.analytics_id).toBeNull()
  })

  test("/app has no PostHog script at all without a key", async () => {
    const body = await (await handler({})(new Request("http://localhost/app"))).text()
    expect(body).not.toContain("posthog")
    expect(body).not.toContain("{{")
  })

  test("/app with a key defines a cookieless PostHog that waits for analytics_id", async () => {
    const body = await (await handler({ analytics: ANALYTICS })(new Request("http://localhost/app"))).text()
    expect(body).toContain("window.telecalAnalytics")
    expect(body).toContain('posthog.init("phc_test"')
    expect(body).toContain('"persistence":"memory"')
    expect(body).toContain('"autocapture":false')
    expect(body).toContain('"disable_session_recording":true')
    expect(body).toContain('posthog.register({"environment":"production"})')
    expect(body).toContain("posthog.identify(analyticsId)")
    expect(body).not.toContain("{{")
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

  test("/ says fat, fiber and added sugar can be switched on", async () => {
    const body = await (await get("/")).text()
    expect(body).toContain("Fat, fiber and added sugar can be switched on too.")
    expect(body).toContain("Calories, protein, fat, fiber and added sugar</li>")
  })

  test("/ has a privacy FAQ entry that names PostHog", async () => {
    const body = await (await get("/")).text()
    const entry = body.match(/<details id="privacy"[\s\S]*?<\/details>/)?.[0] ?? ""

    expect(entry).toContain("PostHog")
    expect(entry).toContain("/settings")
    expect(entry).not.toContain("Nothing else about you is shared")
  })

  test("/ carries Open Graph and Twitter card tags with absolute image URLs", async () => {
    const body = await (await get("/")).text()
    const meta = (key: string) =>
      body.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`))?.[1]

    expect(meta("og:image")).toBe("https://telecal.example/assets/og.png")
    expect(meta("og:image:type")).toBe("image/png")
    expect(meta("og:image:alt")).toStartWith("TeleCal: track calories by just texting.")
    expect(meta("og:locale")).toBe("en_US")
    expect(meta("twitter:image")).toBe(meta("og:image"))
    expect(meta("twitter:image:alt")).toBe(meta("og:image:alt"))
    expect(meta("twitter:title")).toBe(meta("og:title"))
    expect(meta("twitter:description")).toBe(meta("og:description"))
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

  test("/assets/og.png is served as PNG", async () => {
    const res = await get("/assets/og.png")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
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

describe("/api/foods", () => {
  const USER = { id: 42, first_name: "Maria" }
  let foodsHandle: (request: Request) => Promise<Response>
  let library: FoodLibraryRepository

  beforeEach(() => {
    const db = createTestDb()
    library = new FoodLibraryRepository(db)
    const users = new UsersRepository(db)
    users.upsert(42, "maria")
    library.upsertMany(42, [{ name: "Quaker Oats", serving: "1 serving", serving_amount: null, serving_unit: null, calories: 150, protein_g: 5, fat_g: 3, fiber_g: 4, added_sugar_g: null }], "import")
    foodsHandle = createFetchHandler({
      usersRepo: users,
      foodLogsRepo: new FoodLogsRepository(db),
      foodLibraryRepo: library,
      foodLibraryEnabled: true,
      botUsername: "TeleCalTestBot",
      baseUrl: "https://telecal.example",
    })
  })

  function call(method: string, path: string, body?: unknown, auth = true) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (auth) headers.Authorization = `tg-init-data ${createValidInitData(USER, config.telegram.botToken)}`
    return foodsHandle(new Request(`http://localhost${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }))
  }

  test("GET lists, PATCH edits, DELETE deletes", async () => {
    const list = await call("GET", "/api/foods")
    expect(list.status).toBe(200)
    const [oats] = (await list.json()).foods

    const patched = await call("PATCH", `/api/foods/${oats.id}`, { calories: 160 })
    expect(patched.status).toBe(200)
    expect((await patched.json()).food.calories).toBe(160)

    const deleted = await call("DELETE", "/api/foods", { ids: [oats.id] })
    expect(await deleted.json()).toEqual({ deleted: 1 })
  })

  test("a body that isn't JSON is a 400; a wrong method is a 405; no auth is a 401", async () => {
    const bad = await foodsHandle(
      new Request("http://localhost/api/foods", {
        method: "DELETE",
        headers: { Authorization: `tg-init-data ${createValidInitData(USER, config.telegram.botToken)}` },
        body: "not json",
      })
    )
    expect(bad.status).toBe(400)
    expect((await call("POST", "/api/foods", {})).status).toBe(405)
    expect((await call("GET", "/api/foods/1")).status).toBe(405)
    expect((await call("GET", "/api/foods", undefined, false)).status).toBe(401)
  })

  test("with the library off, every /api/foods path is a 404, whatever the method", async () => {
    const db = createTestDb()
    const users = new UsersRepository(db)
    users.upsert(42, "maria")
    foodsHandle = createFetchHandler({
      usersRepo: users,
      foodLogsRepo: new FoodLogsRepository(db),
      foodLibraryRepo: new FoodLibraryRepository(db),
      foodLibraryEnabled: false,
      botUsername: "TeleCalTestBot",
      baseUrl: "https://telecal.example",
    })
    expect((await call("POST", "/api/foods", {})).status).toBe(404)
    expect((await call("PUT", "/api/foods", {})).status).toBe(404)
    expect((await call("GET", "/api/foods")).status).toBe(404)
    expect((await call("DELETE", "/api/foods", { ids: [1] })).status).toBe(404)
    expect((await call("PATCH", "/api/foods/1", { calories: 1 })).status).toBe(404)
    expect((await call("GET", "/api/foods/1")).status).toBe(404)
  })
})
