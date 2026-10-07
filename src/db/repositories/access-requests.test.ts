// src/db/repositories/access-requests.test.ts
import { describe, test, expect, beforeEach } from "bun:test"
import { createTestDb } from "../test-helpers"
import { AccessRequestsRepository } from "./access-requests"

const USER = 42
const ADMIN = 1
let repo: AccessRequestsRepository

beforeEach(() => {
  repo = new AccessRequestsRepository(createTestDb())
})

describe("request", () => {
  test("creates a pending request with the user's names", () => {
    expect(repo.request(USER, "maria", "Maria")).toBe("created")
    expect(repo.find(USER)).toMatchObject({ telegram_id: USER, username: "maria", first_name: "Maria", status: "pending", decided_by: null })
  })

  test("stores missing names as null", () => {
    repo.request(USER, undefined, undefined)
    expect(repo.find(USER)).toMatchObject({ username: null, first_name: null })
  })

  test("a second request while pending is already_pending", () => {
    repo.request(USER, "maria", "Maria")
    expect(repo.request(USER, "maria", "Maria")).toBe("already_pending")
  })

  test("a declined user stays declined", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "declined", ADMIN)
    expect(repo.request(USER, "maria", "Maria")).toBe("declined")
    expect(repo.find(USER)?.status).toBe("declined")
  })

  test("an approved user who was later removed can request again", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "approved", ADMIN)
    expect(repo.request(USER, "maria2", "Maria")).toBe("created")
    expect(repo.find(USER)).toMatchObject({ status: "pending", username: "maria2", decided_at: null, decided_by: null })
  })
})

describe("decide", () => {
  test("approves a pending request and records who decided", () => {
    repo.request(USER, "maria", "Maria")
    const decided = repo.decide(USER, "approved", ADMIN)
    expect(decided).toMatchObject({ status: "approved", decided_by: ADMIN })
    expect(decided?.decided_at).not.toBeNull()
  })

  test("returns null when the request is not pending", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "approved", ADMIN)
    expect(repo.decide(USER, "declined", 2)).toBeNull()
    expect(repo.find(USER)).toMatchObject({ status: "approved", decided_by: ADMIN })
  })

  test("returns null when there is no request", () => {
    expect(repo.decide(USER, "approved", ADMIN)).toBeNull()
  })
})

describe("markApproved", () => {
  test("approves a pending request", () => {
    repo.request(USER, "maria", "Maria")
    repo.markApproved(USER, ADMIN)
    expect(repo.find(USER)).toMatchObject({ status: "approved", decided_by: ADMIN })
    expect(repo.find(USER)?.decided_at).not.toBeNull()
  })

  test("approves a declined request", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "declined", ADMIN)
    repo.markApproved(USER, 2)
    expect(repo.find(USER)).toMatchObject({ status: "approved", decided_by: 2 })
  })

  test("leaves decided_by unchanged when already approved", () => {
    repo.request(USER, "maria", "Maria")
    repo.decide(USER, "approved", ADMIN)
    repo.markApproved(USER, 2)
    expect(repo.find(USER)).toMatchObject({ status: "approved", decided_by: ADMIN })
  })

  test("is a no-op when there is no row", () => {
    repo.markApproved(USER, ADMIN)
    expect(repo.find(USER)).toBeNull()
  })
})

describe("listPending", () => {
  test("lists only pending requests, capped by limit", () => {
    repo.request(1, "a", "A")
    repo.request(2, "b", "B")
    repo.request(3, "c", "C")
    repo.decide(2, "approved", ADMIN)
    expect(repo.listPending(10).map((r) => r.telegram_id)).toEqual([1, 3])
    expect(repo.listPending(1)).toHaveLength(1)
  })
})

describe("find", () => {
  test("returns null for an unknown user", () => {
    expect(repo.find(999)).toBeNull()
  })
})
