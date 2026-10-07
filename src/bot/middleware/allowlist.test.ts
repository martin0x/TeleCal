// src/bot/middleware/allowlist.test.ts
import { describe, test, expect, beforeEach, spyOn, mock } from "bun:test"
import type { Context } from "grammy"
import { createTestDb } from "../../db/test-helpers"
import { AccessRequestsRepository } from "../../db/repositories/access-requests"
import { AllowedUsersRepository } from "../../db/repositories/allowed-users"
import {
  ALREADY_PENDING,
  GROUP_INVITE_PROMPT,
  INVITE_ONLY,
  INVITE_PROMPT,
  NOT_APPROVED,
  REQUEST_PENDING,
  REQUEST_SENT,
  privateRequestKeyboard,
  requestAccessKeyboard,
} from "../access"
import { personalizeMessage } from "../utils/smart-reply"
import { createAllowlistMiddleware } from "./allowlist"

const ADMIN = 1
const MEMBER = 2
const STRANGER = 42
let accessRequestsRepo: AccessRequestsRepository
let allowedUsersRepo: AllowedUsersRepository
let notifyAdmins: ReturnType<typeof mock>
let gate: ReturnType<typeof createAllowlistMiddleware>

beforeEach(() => {
  const db = createTestDb()
  accessRequestsRepo = new AccessRequestsRepository(db)
  allowedUsersRepo = new AllowedUsersRepository(db)
  allowedUsersRepo.add(MEMBER, ADMIN)
  notifyAdmins = mock(() => Promise.resolve())
  gate = createAllowlistMiddleware({ allowedUsersRepo, accessRequestsRepo, adminIds: [ADMIN], notifyAdmins })
})

function messageCtx(userId: number, text = "/start") {
  return {
    from: { id: userId, first_name: "Maria", username: "maria" },
    chat: { id: userId, type: "private" },
    message: { text },
    reply: mock(() => Promise.resolve()),
  }
}

function groupMessageCtx(userId: number, text: string) {
  return {
    from: { id: userId, first_name: "Maria", username: "maria" },
    chat: { id: -100, type: "group" },
    message: { text },
    me: { username: "TeleCalBot" },
    reply: mock(() => Promise.resolve()),
  }
}

function callbackCtx(userId: number, data: string) {
  return {
    from: { id: userId, first_name: "Maria", username: "maria" },
    chat: { id: userId, type: "private" },
    callbackQuery: { data },
    answerCallbackQuery: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
  }
}

async function run(ctx: object) {
  const next = mock(() => Promise.resolve())
  await gate(ctx as unknown as Context, next)
  return next
}

describe("allowed users", () => {
  test("admins pass through", async () => {
    expect(await run(messageCtx(ADMIN))).toHaveBeenCalled()
  })

  test("allowlisted users pass through", async () => {
    expect(await run(messageCtx(MEMBER))).toHaveBeenCalled()
  })

  test("updates with no sender are dropped", async () => {
    const next = await run({ chat: { id: 5, type: "channel" } })
    expect(next).not.toHaveBeenCalled()
  })
})

describe("strangers", () => {
  test("/start gets the invite prompt with a Request access button", async () => {
    const ctx = messageCtx(STRANGER)
    const next = await run(ctx)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenCalledWith(INVITE_PROMPT, { reply_markup: requestAccessKeyboard() })
  })

  test("any other message gets the same prompt", async () => {
    const ctx = messageCtx(STRANGER, "/log")
    await run(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(INVITE_PROMPT, { reply_markup: requestAccessKeyboard() })
  })

  test("a stranger with a pending request is told so, without a button", async () => {
    accessRequestsRepo.request(STRANGER, "maria", "Maria")
    const ctx = messageCtx(STRANGER)
    await run(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(REQUEST_PENDING, undefined)
  })

  test("a declined stranger is told so, without a button", async () => {
    accessRequestsRepo.request(STRANGER, "maria", "Maria")
    accessRequestsRepo.decide(STRANGER, "declined", ADMIN)
    const ctx = messageCtx(STRANGER)
    await run(ctx)
    expect(ctx.reply).toHaveBeenCalledWith(NOT_APPROVED, undefined)
  })

  test("a private non-message update (e.g. my_chat_member) gets no reply", async () => {
    const ctx = { from: { id: STRANGER, first_name: "Maria" }, chat: { id: STRANGER, type: "private" } }
    const next = await run(ctx)
    expect(next).not.toHaveBeenCalled()
  })

  test("a group command from a stranger gets the group invite prompt with a private-request link", async () => {
    const ctx = groupMessageCtx(STRANGER, "/log")
    const next = await run(ctx)
    expect(next).not.toHaveBeenCalled()
    // smartReply personalizes group messages with the sender's name.
    expect(ctx.reply).toHaveBeenCalledWith(personalizeMessage(GROUP_INVITE_PROMPT, "Maria"), {
      reply_markup: privateRequestKeyboard("TeleCalBot"),
    })
  })

  test("non-command text in a group gets no reply and creates no request", async () => {
    const ctx = groupMessageCtx(STRANGER, "just chatting")
    const next = await run(ctx)
    expect(next).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(accessRequestsRepo.find(STRANGER)).toBeNull()
  })

  test("Request access creates a request, confirms it and notifies admins once", async () => {
    const ctx = callbackCtx(STRANGER, "access:req")
    const next = await run(ctx)

    expect(next).not.toHaveBeenCalled()
    expect(accessRequestsRepo.find(STRANGER)).toMatchObject({ status: "pending", username: "maria", first_name: "Maria" })
    expect(ctx.answerCallbackQuery).toHaveBeenCalled()
    expect(ctx.editMessageText).toHaveBeenCalledWith(REQUEST_SENT, undefined)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
    expect((notifyAdmins.mock.calls[0] as unknown[])[0]).toMatchObject({ telegram_id: STRANGER })
  })

  test("a second tap does not notify again", async () => {
    await run(callbackCtx(STRANGER, "access:req"))
    const second = callbackCtx(STRANGER, "access:req")
    await run(second)
    expect(second.answerCallbackQuery).toHaveBeenCalledWith({ text: ALREADY_PENDING })
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
  })

  test("a declined user tapping does not notify", async () => {
    accessRequestsRepo.request(STRANGER, "maria", "Maria")
    accessRequestsRepo.decide(STRANGER, "declined", ADMIN)
    const ctx = callbackCtx(STRANGER, "access:req")
    await run(ctx)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: NOT_APPROVED })
    expect(notifyAdmins).not.toHaveBeenCalled()
  })

  test("other buttons are answered instead of left spinning", async () => {
    const ctx = callbackCtx(STRANGER, "settings:goal")
    await run(ctx)
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: INVITE_ONLY })
  })

  test("admins are still notified when the confirmation edit fails", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const ctx = callbackCtx(STRANGER, "access:req")
      ctx.editMessageText = mock(() => Promise.reject(new Error("message to edit not found")))
      const next = await run(ctx)

      expect(next).not.toHaveBeenCalled()
      expect(accessRequestsRepo.find(STRANGER)).toMatchObject({ status: "pending" })
      expect(notifyAdmins).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
