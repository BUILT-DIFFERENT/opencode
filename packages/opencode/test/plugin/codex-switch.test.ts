import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { Provider } from "@opencode-ai/sdk"
import { CodexAuthPlugin } from "../../src/plugin/codex"
import { Global } from "../../src/global"
import * as Store from "../../src/auth/codex-accounts"

describe("codex account switching", () => {
  test("switches on rate limit", async () => {
    const file = path.join(Global.Path.data, "openai-codex-accounts.json")
    await fs.rm(file, { force: true })

    const time = Date.now()
    await Store.write({
      version: 1,
      activeIndex: 0,
      accounts: [
        {
          refresh: "rt-a",
          access: "token-a",
          expires: time + 60 * 60 * 1000,
          accountId: "acc-a",
          email: "a@example.com",
          addedAt: time,
          lastUsed: time - 1000,
        },
        {
          refresh: "rt-b",
          access: "token-b",
          expires: time + 60 * 60 * 1000,
          accountId: "acc-b",
          email: "b@example.com",
          addedAt: time,
          lastUsed: time - 2000,
        },
      ],
    })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("authorization")
        if (auth === "Bearer token-a") {
          return new Response("rate", {
            status: 429,
            headers: {
              "retry-after": "1",
            },
          })
        }
        if (auth === "Bearer token-b") {
          return new Response("ok", { status: 200 })
        }
        return new Response("unexpected", { status: 500 })
      },
    })

    const endpoint = `http://127.0.0.1:${server.port}/codex`
    const previous = process.env.OPENCODE_CODEX_ENDPOINT
    process.env.OPENCODE_CODEX_ENDPOINT = endpoint

    const client = {
      auth: {
        set: async () => true,
      },
    } as unknown as PluginInput["client"]

    const plugin = await CodexAuthPlugin({
      client,
      project: {} as unknown as PluginInput["project"],
      directory: process.cwd(),
      worktree: process.cwd(),
      serverUrl: new URL("http://localhost"),
      $: Bun.$,
    })

    const provider = {
      models: {
        "gpt-5.1-codex-max": {
          cost: {
            input: 1,
            output: 1,
            cache: { read: 1, write: 1 },
          },
        },
      },
    } as unknown as Provider

    const getAuth = async () => ({
      type: "oauth" as const,
      refresh: "rt-a",
      access: "token-a",
      expires: time + 60 * 60 * 1000,
      accountId: "acc-a",
    })

    const loaded = await plugin.auth?.loader?.(getAuth, provider)
    const response = await loaded?.fetch?.("https://api.openai.com/v1/responses", { method: "POST" })
    expect(response?.status).toBe(200)

    const stored = await Store.read()
    expect(stored.activeIndex).toBe(1)
    expect(stored.accounts[0].cooldownReason).toBe("rate-limit")

    server.stop()
    if (previous === undefined) {
      delete process.env.OPENCODE_CODEX_ENDPOINT
    } else {
      process.env.OPENCODE_CODEX_ENDPOINT = previous
    }
  })
})
