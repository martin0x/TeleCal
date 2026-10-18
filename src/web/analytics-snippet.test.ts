// src/web/analytics-snippet.test.ts
import { describe, test, expect } from "bun:test"
import { postHogInit, scrubEvent } from "./analytics-snippet"

const HASH = "#tgWebAppData=user%3D%7B%22id%22%3A42%2C%22first_name%22%3A%22Maria%22%7D%26hash%3Dabc"

describe("scrubEvent", () => {
  test("removes the page's URL fragment from every string in the event", () => {
    const event = {
      event: "$pageview",
      properties: { $current_url: `https://telecal.example/app${HASH}`, tab: "week", nested: [`x${HASH}`] },
    }

    expect(scrubEvent(HASH)(event)).toEqual({
      event: "$pageview",
      properties: { $current_url: "https://telecal.example/app", tab: "week", nested: ["x"] },
    })
  })

  test("drops the person properties PostHog adds on identify", () => {
    const event = {
      event: "$identify",
      properties: { $set_once: { $initial_referrer: "$direct" }, $set: {}, environment: "production" },
      $set_once: { $initial_referrer: "$direct" },
      $set: {},
    }

    expect(scrubEvent("")(event)).toEqual({ event: "$identify", properties: { environment: "production" } })
  })

  test("leaves the event alone when the page has no fragment", () => {
    const event = { properties: { $current_url: "https://telecal.example/app#" } }
    expect(scrubEvent("")(event)).toEqual(event)
    expect(scrubEvent("#")(event)).toEqual(event)
  })
})

describe("postHogInit", () => {
  const script = postHogInit({ apiKey: "phc_test", host: "https://us.i.posthog.com", environment: "production" })

  test("strips the URL fragment from events before they are sent", () => {
    expect(script).toContain("before_send:")
    expect(script).toContain("(location.hash)")
  })

  test("parses as plain JavaScript, with no TypeScript left in the inlined function", () => {
    expect(() => new Function(script)).not.toThrow()
  })
})
