import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { createTestDb } from "../test-helpers"
import { ApiTokensRepository, hashToken } from "./api-tokens"

let db: Database
let repo: ApiTokensRepository

beforeEach(() => {
  db = createTestDb()
  repo = new ApiTokensRepository(db)
})

describe("ApiTokensRepository", () => {
  test("an issued token finds its user", () => {
    const token = repo.issue(111)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(repo.findUser(token)).toBe(111)
  })

  test("stores only the hash, never the token", () => {
    const token = repo.issue(111)
    const rows = db.prepare("SELECT * FROM api_tokens").all() as Record<string, unknown>[]

    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(hashToken(token))
    expect(JSON.stringify(rows)).not.toContain(token)
  })

  test("issuing again replaces the earlier token", () => {
    const first = repo.issue(111)
    const second = repo.issue(111)

    expect(second).not.toBe(first)
    expect(repo.findUser(first)).toBeNull()
    expect(repo.findUser(second)).toBe(111)
  })

  test("revoke turns the token off and reports whether there was one", () => {
    const token = repo.issue(111)

    expect(repo.revoke(111)).toBe(true)
    expect(repo.findUser(token)).toBeNull()
    expect(repo.revoke(111)).toBe(false)
  })

  test("tokens are per user", () => {
    const a = repo.issue(111)
    const b = repo.issue(222)
    repo.revoke(111)

    expect(repo.findUser(a)).toBeNull()
    expect(repo.findUser(b)).toBe(222)
  })

  test("an unknown token finds nobody", () => {
    repo.issue(111)
    expect(repo.findUser("not-a-token")).toBeNull()
    expect(repo.findUser("")).toBeNull()
  })

  test("a lookup records when the token was last used", () => {
    const token = repo.issue(111)
    const lastUsed = () => (db.prepare("SELECT last_used_at FROM api_tokens").get() as { last_used_at: string | null }).last_used_at

    expect(lastUsed()).toBeNull()
    repo.findUser(token)
    expect(lastUsed()).not.toBeNull()
  })
})
