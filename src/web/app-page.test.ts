// src/web/app-page.test.ts
// The Mini App is one static HTML page, so nothing typechecks its script.
// These catch a syntax error and a macro the page has no label for.
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MACROS } from "../macros"

const html = readFileSync(join(import.meta.dir, "views/app.html"), "utf8")
// The page's own script: the <script> block without a src.
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).at(-1) ?? ""

describe("Mini App page", () => {
  test("has an inline script, and it parses", () => {
    expect(script.length).toBeGreaterThan(1000)
    expect(() => new Function(script)).not.toThrow()
  })

  test("labels every registry macro, with its column", () => {
    for (const m of MACROS) expect(script).toContain(`${m.key}: { column: '${m.column}',`)
  })

  test("builds the metric toggle from the user's macros", () => {
    expect(script).toContain("tracked_macros")
    expect(script).toContain("dailyMacros")
    expect(html).not.toContain('data-metric="protein"')
  })
})

describe("Foods tab", () => {
  test("is hidden until /api/user says the library is on, and ?tab=foods opens it", () => {
    expect(html).toContain('<button class="tab hidden" data-tab="foods" id="foods-tab">Foods</button>')
    expect(script).toContain("food_library")
    expect(script).toContain("get('tab')")
  })

  test("talks to /api/foods with PATCH and DELETE", () => {
    expect(script).toContain("'/api/foods'")
    expect(script).toContain("'PATCH'")
    expect(script).toContain("'DELETE'")
  })

  test("puts food names in the page as text, never as HTML", () => {
    expect(script).toContain("name.textContent = food.name")
    expect(script).not.toMatch(/innerHTML\s*=\s*`[^`]*food\.name/)
  })

  test("labels every macro on the edit form", () => {
    for (const m of MACROS) expect(script).toMatch(new RegExp(`${m.key}: \\{ column: '${m.column}',[^}]*form: '`))
  })

  test("uses no optional chaining or nullish coalescing (old Telegram webviews)", () => {
    expect(script).not.toContain("?.")
    expect(script).not.toContain("??")
  })

  test("shares one user load across tabs, and reports network failures instead of throwing", () => {
    expect(script).toContain("function loadUser()")
    expect(script).toContain("status: 0")
    expect(script).toContain("Could not load your foods.")
  })

  test("says the session expired when a foods request gets a 401", () => {
    expect(script).toContain("Your session expired. Close and reopen the app.")
    expect(script).toContain("status === 401")
    // api() hands its status on, so loadFoods can tell a 401 apart.
    expect(script).toMatch(/err\.status = res\.status;\s*throw err;/)
  })
})
