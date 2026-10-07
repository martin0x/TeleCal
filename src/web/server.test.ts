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
