// src/utils/format.test.ts
import { describe, test, expect } from "bun:test"
import {
  formatUsd,
  formatTokens,
  escapeHtml,
  formatItemsSummary,
  shortHash,
  sumTotals,
  formatItemLine,
  formatTotals,
  formatGoalProgress,
  createProgressBar,
  formatNumber,
} from "./format"
import { zeroTotals, type MacroKey } from "../macros"

const PROTEIN: MacroKey[] = ["protein"]

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
    { description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" },
    { description: "Black coffee", calories: 5, protein_g: 0, emoji: "☕" },
  ]

  test("puts items in a blockquote with a bold total a blank line beneath", () => {
    expect(formatItemsSummary(items, PROTEIN)).toBe(
      "<blockquote>🍳 2 scrambled eggs — 180 cal · 14 g\n☕ Black coffee — 5 cal · 0 g</blockquote>\n\n" +
        "<b>Total: 185 cal · 14 g protein</b>"
    )
  })

  test("escapes descriptions", () => {
    const out = formatItemsSummary([{ description: "Mac & cheese", calories: 400, protein_g: 18, emoji: "🧀" }], PROTEIN)
    expect(out).toContain("🧀 Mac &amp; cheese — 400 cal · 18 g")
  })

  test("falls back to 🍽️ when an item has no emoji", () => {
    expect(formatItemsSummary([{ description: "Rice", calories: 200, protein_g: 4 }], PROTEIN)).toContain("🍽️ Rice — 200 cal · 4 g")
    expect(formatItemsSummary([{ description: "Rice", calories: 200, protein_g: 4, emoji: null }], PROTEIN)).toContain(
      "🍽️ Rice — 200 cal · 4 g"
    )
  })

  test("renders unknown protein as ? g and leaves it out of the total", () => {
    expect(
      formatItemsSummary([{ description: "Rice", calories: 200 }, { description: "Egg", calories: 70, protein_g: 6 }], PROTEIN)
    ).toBe("<blockquote>🍽️ Rice — 200 cal · ? g\n🍽️ Egg — 70 cal · 6 g</blockquote>\n\n<b>Total: 270 cal · 6 g protein</b>")
  })

  test("strikes through items and total when struck", () => {
    expect(formatItemsSummary(items, PROTEIN, { struck: true })).toBe(
      "<blockquote><s>🍳 2 scrambled eggs — 180 cal · 14 g\n☕ Black coffee — 5 cal · 0 g</s></blockquote>\n\n" +
        "<b><s>Total: 185 cal · 14 g protein</s></b>"
    )
  })

  test("contains no width-dependent rule", () => {
    expect(formatItemsSummary(items, PROTEIN)).not.toContain("─")
  })

  test("tolerates a non-string description without throwing", () => {
    expect(
      formatItemsSummary([{ description: 42 as unknown as string, calories: 1 }], PROTEIN)
    ).toContain("🍽️ 42 — 1 cal · ? g")
  })
})

describe("sumTotals", () => {
  test("sums calories and known protein", () => {
    expect(sumTotals([{ calories: 100, protein_g: 10 }, { calories: 50, protein_g: null }, { calories: 25 }])).toEqual({
      ...zeroTotals(),
      calories: 175,
      protein: 10,
    })
  })

  test("is zero for no items", () => {
    expect(sumTotals([])).toEqual(zeroTotals())
  })
})

describe("formatItemLine", () => {
  test("renders emoji, description, calories and protein", () => {
    expect(formatItemLine({ description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" }, PROTEIN)).toBe(
      "🍳 2 scrambled eggs — 180 cal · 14 g"
    )
  })

  test("falls back to the plate emoji and ? g", () => {
    expect(formatItemLine({ description: "Rice", calories: 200 }, PROTEIN)).toBe("🍽️ Rice — 200 cal · ? g")
  })
})

describe("formatTotals", () => {
  test("spells out protein and groups thousands", () => {
    expect(formatTotals({ ...zeroTotals(), calories: 335, protein: 28 }, PROTEIN)).toBe("335 cal · 28 g protein")
    expect(formatTotals({ ...zeroTotals(), calories: 1450, protein: 1020 }, PROTEIN)).toBe("1,450 cal · 1,020 g protein")
  })
})

describe("createProgressBar", () => {
  test("fills one block per 10 percent, clamped to 10", () => {
    expect(createProgressBar(0)).toBe("░░░░░░░░░░")
    expect(createProgressBar(73)).toBe("███████░░░")
    expect(createProgressBar(100)).toBe("██████████")
    expect(createProgressBar(140)).toBe("██████████")
  })
})

describe("formatGoalProgress", () => {
  const base = { emoji: "📊", label: "Calories", unit: "cal" }

  test("is a single line without a goal", () => {
    expect(formatGoalProgress({ ...base, current: 1450, goal: null })).toBe("📊 Calories: 1,450 cal")
    expect(formatGoalProgress({ ...base, current: 1450, goal: undefined })).toBe("📊 Calories: 1,450 cal")
  })

  test("shows the bar and remaining amount under the goal", () => {
    expect(formatGoalProgress({ ...base, current: 1450, goal: 2000 })).toBe(
      "📊 Calories: 1,450 / 2,000 cal\n███████░░░ 73%\n✨ 550 cal remaining"
    )
  })

  test("shows the overage above the goal", () => {
    expect(formatGoalProgress({ emoji: "💪", label: "Protein", unit: "g", current: 130, goal: 120 })).toBe(
      "💪 Protein: 130 / 120 g\n██████████ 108%\n⚠️ 10 g over goal"
    )
  })

  test("celebrates an exact hit", () => {
    expect(formatGoalProgress({ ...base, current: 2000, goal: 2000 })).toBe(
      "📊 Calories: 2,000 / 2,000 cal\n██████████ 100%\n🎯 Goal reached!"
    )
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

describe("with no macros", () => {
  const items = [
    { description: "2 scrambled eggs", calories: 180, protein_g: 14, emoji: "🍳" },
    { description: "Black coffee", calories: 5, protein_g: 0, emoji: "☕" },
  ]

  test("item lines show calories only", () => {
    expect(formatItemLine(items[0], [])).toBe("🍳 2 scrambled eggs — 180 cal")
  })

  test("totals show calories only", () => {
    expect(formatTotals({ ...zeroTotals(), calories: 335, protein: 28 }, [])).toBe("335 cal")
  })

  test("the summary shows calories only", () => {
    expect(formatItemsSummary(items, [])).toBe(
      "<blockquote>🍳 2 scrambled eggs — 180 cal\n☕ Black coffee — 5 cal</blockquote>\n\n<b>Total: 185 cal</b>"
    )
  })
})

describe("formatGoalProgress without an emoji", () => {
  test("starts with the label", () => {
    expect(formatGoalProgress({ label: "Fat", current: 36, goal: null, unit: "g" })).toBe("Fat: 36 g")
  })
})

describe("formatNumber", () => {
  test("groups thousands", () => {
    expect(formatNumber(1450)).toBe("1,450")
    expect(formatNumber(95)).toBe("95")
  })
})
