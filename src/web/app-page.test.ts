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
