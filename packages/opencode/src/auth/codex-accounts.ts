import fs from "fs/promises"
import path from "path"
import { Global } from "../global"

export type Account = {
  refresh: string
  access?: string
  expires?: number
  accountId?: string
  email?: string
  addedAt: number
  lastUsed: number
  cooldownUntil?: number
  cooldownReason?: "rate-limit" | "auth-failure"
}

export type Store = {
  version: number
  accounts: Account[]
  activeIndex: number
}

export type Seed = {
  refresh?: string
  access?: string
  expires?: number
  accountId?: string
  email?: string
}

export type Insert = {
  refresh: string
  access?: string
  expires?: number
  accountId?: string
  email?: string
}

export const COOLDOWN = {
  rate: 5 * 60 * 60 * 1000,
  auth: 2 * 60 * 1000,
  skew: 60 * 1000,
}

const VERSION = 1
const FILE = path.join(Global.Path.data, "openai-codex-accounts.json")

function normalizeAccount(raw?: Partial<Account>): Account | undefined {
  if (!raw?.refresh || typeof raw.refresh !== "string") return
  const time = Date.now()
  const email = typeof raw.email === "string" && raw.email.length > 0 ? raw.email.toLowerCase() : undefined
  const reason =
    raw.cooldownReason === "rate-limit" || raw.cooldownReason === "auth-failure" ? raw.cooldownReason : undefined

  return {
    refresh: raw.refresh,
    access: typeof raw.access === "string" && raw.access.length > 0 ? raw.access : undefined,
    expires: typeof raw.expires === "number" ? raw.expires : undefined,
    accountId: typeof raw.accountId === "string" && raw.accountId.length > 0 ? raw.accountId : undefined,
    email,
    addedAt: typeof raw.addedAt === "number" ? raw.addedAt : time,
    lastUsed: typeof raw.lastUsed === "number" ? raw.lastUsed : 0,
    cooldownUntil: typeof raw.cooldownUntil === "number" ? raw.cooldownUntil : undefined,
    cooldownReason: reason,
  }
}

function dedupe(list: Account[]): Account[] {
  const map = new Map<string, Account>()
  for (const item of list) {
    const key = item.refresh || item.email || `${map.size}`
    const existing = map.get(key)
    if (!existing) {
      map.set(key, item)
      continue
    }
    const prevUsed = existing.lastUsed || 0
    const nextUsed = item.lastUsed || 0
    map.set(key, nextUsed > prevUsed ? item : existing)
  }
  return Array.from(map.values())
}

function normalizeStore(raw?: Partial<Store>): Store {
  const accounts = Array.isArray(raw?.accounts)
    ? dedupe(
        raw.accounts
          .map((item) => normalizeAccount(item))
          .filter((item): item is Account => !!item),
      )
    : []
  const activeIndex =
    accounts.length === 0
      ? 0
      : Math.min(Math.max(typeof raw?.activeIndex === "number" ? raw.activeIndex : 0, 0), accounts.length - 1)

  return {
    version: VERSION,
    accounts,
    activeIndex,
  }
}

export async function read(): Promise<Store> {
  const file = Bun.file(FILE)
  const data = await file.json().catch(() => undefined)
  return normalizeStore(data as Partial<Store> | undefined)
}

export async function write(store: Store): Promise<Store> {
  const normalized = normalizeStore(store)
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  await Bun.write(FILE, JSON.stringify(normalized, null, 2), { mode: 0o600 })
  await fs.chmod(FILE, 0o600).catch(() => {})
  return normalized
}

export async function ensure(seed?: Seed): Promise<Store> {
  const store = await read()
  const before = JSON.stringify(store)
  const next = merge(store, seed)
  if (before === JSON.stringify(next)) return next
  return write(next)
}

export async function clear(): Promise<Store> {
  return write({ version: VERSION, accounts: [], activeIndex: 0 })
}

export function merge(store: Store, seed?: Seed): Store {
  if (!seed?.refresh) return store
  const time = Date.now()
  const email = seed.email ? seed.email.toLowerCase() : undefined
  const index = store.accounts.findIndex((item) => item.refresh === seed.refresh)

  if (index >= 0) {
    const current = store.accounts[index]
    store.accounts[index] = {
      ...current,
      refresh: seed.refresh,
      access: seed.access ?? current.access,
      expires: seed.expires ?? current.expires,
      accountId: seed.accountId ?? current.accountId,
      email: email ?? current.email,
      addedAt: current.addedAt ?? time,
    }
    store.activeIndex = index
    return store
  }

  store.accounts.push({
    refresh: seed.refresh,
    access: seed.access,
    expires: seed.expires,
    accountId: seed.accountId,
    email,
    addedAt: time,
    lastUsed: time,
  })
  store.activeIndex = store.accounts.length - 1
  return store
}

export function upsert(store: Store, insert: Insert): { store: Store; index: number } {
  const time = Date.now()
  const email = insert.email ? insert.email.toLowerCase() : undefined
  const index = store.accounts.findIndex((item) => {
    if (item.refresh === insert.refresh) return true
    if (email && item.email && item.email === email) return true
    return false
  })

  if (index >= 0) {
    const current = store.accounts[index]
    store.accounts[index] = {
      ...current,
      refresh: insert.refresh,
      access: insert.access ?? current.access,
      expires: insert.expires ?? current.expires,
      accountId: insert.accountId ?? current.accountId,
      email: email ?? current.email,
      lastUsed: time,
      cooldownReason: undefined,
      cooldownUntil: undefined,
    }
    return { store, index }
  }

  store.accounts.push({
    refresh: insert.refresh,
    access: insert.access,
    expires: insert.expires,
    accountId: insert.accountId,
    email,
    addedAt: time,
    lastUsed: time,
  })
  return { store, index: store.accounts.length - 1 }
}

export function order(store: Store): number[] {
  if (store.accounts.length === 0) return []
  const time = Date.now()
  const available = store.accounts
    .map((_, index) => index)
    .filter((index) => {
      const account = store.accounts[index]
      if (account.cooldownUntil && account.cooldownUntil > time) return false
      return true
    })

  if (available.length === 0) {
    return store.accounts.map((_, index) => index)
  }

  const active = available.includes(store.activeIndex) ? [store.activeIndex] : []
  const rest = available
    .filter((index) => index !== store.activeIndex)
    .sort((a, b) => (store.accounts[a].lastUsed || 0) - (store.accounts[b].lastUsed || 0))
  return [...active, ...rest]
}

export function retry(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after")
  if (!header) return fallback
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(fallback, seconds * 1000)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(fallback, date - Date.now())
  return fallback
}
