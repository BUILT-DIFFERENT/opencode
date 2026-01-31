import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import * as Store from "../../src/auth/codex-accounts"

describe("codex accounts store", () => {
  test("writes and reads accounts with secure permissions", async () => {
    const file = path.join(Global.Path.data, "openai-codex-accounts.json")
    await fs.rm(file, { force: true })
    const time = Date.now()
    await Store.write({
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          refresh: "rt-1",
          access: "at-1",
          expires: time + 1000,
          accountId: "acc-1",
          email: "User@Example.com",
          addedAt: time,
          lastUsed: time,
        },
      ],
    })

    const loaded = await Store.read()
    expect(loaded.accounts.length).toBe(1)
    expect(loaded.accounts[0].email).toBe("user@example.com")

    const stat = await fs.stat(file)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test("orders active first and skips cooldown", () => {
    const time = Date.now()
    const store: Store.Store = {
      version: 1,
      activeIndex: 1,
      accounts: [
        {
          refresh: "rt-1",
          addedAt: time,
          lastUsed: time - 1000,
          cooldownUntil: time + 5000,
        },
        {
          refresh: "rt-2",
          addedAt: time,
          lastUsed: time - 2000,
        },
        {
          refresh: "rt-3",
          addedAt: time,
          lastUsed: time - 3000,
        },
      ],
    }
    const order = Store.order(store)
    expect(order[0]).toBe(1)
    expect(order.includes(0)).toBe(false)
    expect(order[1]).toBe(2)
  })

  test("parses retry-after header", () => {
    const response = new Response("", {
      status: 429,
      headers: {
        "retry-after": "2",
      },
    })
    expect(Store.retry(response, 1000)).toBe(2000)
  })
})
