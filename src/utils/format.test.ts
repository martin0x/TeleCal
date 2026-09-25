// src/utils/format.test.ts
import { describe, test, expect } from "bun:test"
import { formatUsd, formatTokens, escapeHtml, formatItemsSummary, shortHash } from "./format"

describe("formatUsd", () => {
  test("uses two decimals at or above one cent", () => {
    expect(formatUsd(1.844)).toBe("$1.84")
    expect(formatUsd(0.01)).toBe("$0.01")
  })

  test("uses four decimals below one cent, so small spend is not rendered as zero", () => {
    expect(formatUsd(0.0043)).toBe("$0.0043")
    expect(formatUsd(0.000078)).toBe("$0.0001")
  })

  test("renders a true zero plainly", () => {
    expect(formatUsd(0)).toBe("$0.00")
  })
})

describe("formatTokens", () => {
  test("groups thousands below 10k", () => {
    expect(formatTokens(21300)).toBe("21,300")
    expect(formatTokens(950)).toBe("950")
  })

  test("abbreviates at and above 100k", () => {
    expect(formatTokens(186200)).toBe("186.2k")
    expect(formatTokens(1500000)).toBe("1500.0k")
  })
})

describe("escapeHtml", () => {
  test("escapes the three characters Telegram's HTML mode requires", () => {
    expect(escapeHtml("mac & cheese <3 >_<")).toBe("mac &amp; cheese &lt;3 &gt;_&lt;")
  })

  test("leaves quotes and apostrophes alone", () => {
    expect(escapeHtml(`Here's "it"`)).toBe(`Here's "it"`)
  })
})

describe("formatItemsSummary", () => {
  const items = [
    { description: "2 scrambled eggs", calories: 180, emoji: "🍳" },
    { description: "Black coffee", calories: 5, emoji: "☕" },
  ]

  test("puts items in a blockquote with a bold total beneath", () => {
    expect(formatItemsSummary(items)).toBe(
      "<blockquote>🍳 2 scrambled eggs — 180 cal\n☕ Black coffee — 5 cal</blockquote>\n" +
        "<b>Total: 185 cal</b>"
    )
  })

  test("escapes descriptions", () => {
    const out = formatItemsSummary([{ description: "Mac & cheese", calories: 400, emoji: "🧀" }])
    expect(out).toContain("🧀 Mac &amp; cheese — 400 cal")
  })

  test("falls back to 🍽️ when an item has no emoji", () => {
    expect(formatItemsSummary([{ description: "Rice", calories: 200 }])).toContain("🍽️ Rice — 200 cal")
    expect(formatItemsSummary([{ description: "Rice", calories: 200, emoji: null }])).toContain(
      "🍽️ Rice — 200 cal"
    )
  })

  test("strikes through items and total when struck", () => {
    expect(formatItemsSummary(items, { struck: true })).toBe(
      "<blockquote><s>🍳 2 scrambled eggs — 180 cal\n☕ Black coffee — 5 cal</s></blockquote>\n" +
        "<b><s>Total: 185 cal</s></b>"
    )
  })

  test("contains no width-dependent rule", () => {
    expect(formatItemsSummary(items)).not.toContain("─")
  })

  test("tolerates a non-string description without throwing", () => {
    expect(
      formatItemsSummary([{ description: 42 as unknown as string, calories: 1 }])
    ).toContain("🍽️ 42 — 1 cal")
  })
})

describe("shortHash", () => {
  test("is 8 lowercase hex characters", () => {
    expect(shortHash("anything")).toMatch(/^[0-9a-f]{8}$/)
  })

  test("is deterministic", () => {
    expect(shortHash("2026-09-25|[]")).toBe(shortHash("2026-09-25|[]"))
  })

  test("differs for different input", () => {
    expect(shortHash("a")).not.toBe(shortHash("b"))
  })
})
