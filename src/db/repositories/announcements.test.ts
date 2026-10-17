// src/db/repositories/announcements.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../test-helpers"
import { AnnouncementsRepository } from "./announcements"

let repo: AnnouncementsRepository

beforeEach(() => {
  repo = new AnnouncementsRepository(createTestDb())
})

describe("AnnouncementsRepository", () => {
  test("nobody has received an announcement until it's marked sent", () => {
    expect(repo.hasReceived("privacy", 42)).toBe(false)
    repo.markSent("privacy", 42)
    expect(repo.hasReceived("privacy", 42)).toBe(true)
  })

  test("receipts are per announcement", () => {
    repo.markSent("privacy", 42)
    expect(repo.hasReceived("other", 42)).toBe(false)
  })

  test("marking twice is harmless", () => {
    repo.markSent("privacy", 42)
    repo.markSent("privacy", 42)
    expect(repo.countSent("privacy")).toBe(1)
  })
})
