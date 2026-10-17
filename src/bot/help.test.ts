// src/bot/help.test.ts
import { describe, test, expect } from "bun:test"
import { config } from "../config"
import { HELP_TEXT } from "./help"

describe("HELP_TEXT", () => {
  test("links to the privacy section of the landing page", () => {
    expect(HELP_TEXT).toContain(`${config.web.baseUrl}/#privacy`)
  })
})
