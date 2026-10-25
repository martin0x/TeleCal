// src/db/repositories/group-badges.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../test-helpers"
import { GroupBadgesRepository } from "./group-badges"

const GROUP = -100
const OTHER_GROUP = -200

let repo: GroupBadgesRepository

beforeEach(() => {
  repo = new GroupBadgesRepository(createTestDb())
})

describe("GroupBadgesRepository", () => {
  test("a member has no badge until they set one", () => {
    expect(repo.get(GROUP, 42)).toBeNull()
    expect(repo.set(GROUP, 42, "🦊")).toBe(true)
    expect(repo.get(GROUP, 42)).toBe("🦊")
  })

  test("badges are per group", () => {
    repo.set(GROUP, 42, "🦊")
    expect(repo.get(OTHER_GROUP, 42)).toBeNull()
    expect(repo.set(OTHER_GROUP, 42, "🐼")).toBe(true)
    expect(repo.get(GROUP, 42)).toBe("🦊")
  })

  test("setting again replaces the badge", () => {
    repo.set(GROUP, 42, "🦊")
    expect(repo.set(GROUP, 42, "🐼")).toBe(true)
    expect(repo.get(GROUP, 42)).toBe("🐼")
  })

  test("another member's emoji in the same group is refused", () => {
    repo.set(GROUP, 42, "🦊")
    expect(repo.set(GROUP, 43, "🦊")).toBe(false)
    expect(repo.get(GROUP, 43)).toBeNull()
    expect(repo.set(OTHER_GROUP, 43, "🦊")).toBe(true)
  })

  test("re-setting your own emoji is fine", () => {
    repo.set(GROUP, 42, "🦊")
    expect(repo.set(GROUP, 42, "🦊")).toBe(true)
  })

  test("clearing frees the emoji for others", () => {
    repo.set(GROUP, 42, "🦊")
    repo.clear(GROUP, 42)
    expect(repo.get(GROUP, 42)).toBeNull()
    expect(repo.set(GROUP, 43, "🦊")).toBe(true)
  })
})
