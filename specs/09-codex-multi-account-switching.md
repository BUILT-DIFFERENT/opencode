# Codex Multi-Account Failover Plan

## Goal
Add multi-account OpenAI Codex OAuth support so OpenCode automatically switches accounts when one is rate-limited (429) or temporarily unauthorized (401/403), while preserving the existing Codex OAuth flow and keeping credentials secure.

## Scope
- Applies only to the Codex OAuth flow in `packages/opencode/src/plugin/codex.ts` (provider: `openai`).
- Covers: account persistence, account selection, cooldowns, request routing, and auth refresh.
- Non-goals: global rate-limiting changes or provider-level retries outside Codex OAuth.

## Current State (opencode)
- `packages/opencode/src/plugin/codex.ts` supports a single OAuth account and injects its access token into requests.
- Refresh is handled inline when the access token expires.
- No persistent store exists for multiple accounts.

## Design Overview
### Placement
Primary implementation should live in `packages/opencode/src/plugin/codex.ts` because:
- It already owns the Codex OAuth flow.
- It already rewrites requests to the Codex endpoint and manipulates headers.
- It is the narrowest surface area for Codex-only behavior.

Alternative (not recommended unless we want cross-provider reuse): implement switching at the provider layer or in `SessionRetry`, but this couples generic retry behavior with Codex-specific account state.

### Data Model
Create a Codex account store with these fields (adapted from the private repo, but normalized):
- `refresh` (string, required)
- `access` (string, optional)
- `expires` (number, optional)
- `accountId` (string, optional)
- `email` (string, optional)
- `addedAt` (number)
- `lastUsed` (number)
- `cooldownUntil` (number, optional)
- `cooldownReason` ("rate-limit" | "auth-failure" | undefined)

Store structure:
- `version` (number)
- `accounts` (CodexAccount[])
- `activeIndex` (number)

Concrete file format (example, redacted):
```json
{
  "version": 1,
  "activeIndex": 0,
  "accounts": [
    {
      "refresh": "...",
      "access": "...",
      "expires": 1730000000000,
      "accountId": "org_123",
      "email": "user@example.com",
      "addedAt": 1730000000000,
      "lastUsed": 1730000000000
    }
  ]
}
```

### Persistence (Security)
Persist the store in a dedicated secure file with `0600` permissions (same pattern as `Auth.set`). This avoids the general `Storage` tree for secrets and keeps permissions explicit.
Suggested location:
- `path.join(Global.Path.data, "openai-codex-accounts.json")`
- Keep the filename stable so users can back it up easily.

### Account Selection
- Build an attempt order each request: active account first, then other non-cooled-down accounts ordered by least recently used.
- If all accounts are on cooldown, fall back to the full list in a stable order (active first).
- Update `lastUsed` and `activeIndex` on successful requests.

### Cooldowns
- `rate-limit` cooldown: use `Retry-After` header if present; otherwise use a conservative fallback (e.g., 5 hours from the private implementation).
- `auth-failure` cooldown: short backoff (e.g., 2 minutes) for 401/403 or token refresh failures.

### Token Refresh
- Refresh when `expires` is within a skew window (e.g., 60 seconds).
- After refresh, update account fields and (if needed) `accountId`.
- Persist the refreshed account and update the active auth record via `input.client.auth.set`.

## Implementation Plan
### 1) Add a Codex account store module
Create `packages/opencode/src/auth/codex-accounts.ts` (or similar):
- Define Zod schema(s) for account and store.
- Implement `readStore`, `writeStore`, `normalizeStore`, `dedupeAccounts`.
- Implement `upsertFromTokens(tokens)`, `ensureStoreSeeded(auth)`.
- Add helpers:
  - `buildAttemptOrder(store)`
  - `getRetryAfterMs(response, fallback)`
  - `ensureAccountAccess(store, index)` (refresh access token if needed)

Clarify schema usage:
- `Auth.Oauth` does not include `email`, so do **not** write `email` into `Auth.set`; keep email only in the codex account store.
- If we want `email` in `Auth`, update the Zod schema first (not recommended for this change).

File IO specifics:
- `readStore` should tolerate missing file or corrupt JSON by returning an empty normalized store.
- `writeStore` should always normalize + dedupe before writing.
- Use `fs.mkdir(path.dirname(file), { recursive: true })` and `Bun.write(file, data, { mode: 0o600 })`.
- Avoid `Storage` because it writes JSON without secure permissions.

Account identity details:
- Prefer `refresh` as the primary dedupe key.
- If no matching refresh token, use `email` as a secondary key (lowercased).
- If neither is present, treat it as a new account.

Security:
- Use `Bun.write(file, json, { mode: 0o600 })` and `fs.mkdir(..., { recursive: true })`.
- Avoid logging token values.

### 2) Wire store into Codex auth loader
In `packages/opencode/src/plugin/codex.ts`:
- On `auth.loader`, call `ensureStoreSeeded` using the current OAuth auth (if any).
- Keep filtering allowed Codex models and zeroing costs as today.

Provider ID consistency:
- The plugin advertises `provider: "openai"` and the CLI saves OAuth under `openai`.
- Ensure any calls to `input.client.auth.set` use `{ path: { id: "openai" } }` (not `"codex"`), to avoid desync between the auth file and the account store.

### 3) Update Codex fetch to use account switching
Replace the single-account fetch path with the switching flow:
- Build base headers with any existing request headers, excluding `Authorization`.
- Rewrite requests to `CODEX_API_ENDPOINT` (existing behavior).
- If store has no accounts, fall back to current auth (existing behavior).
- Else, iterate accounts in attempt order:
  - `ensureAccountAccess` (refresh token if needed)
  - Set `Authorization: Bearer <access>` and `ChatGPT-Account-Id` if present
  - Perform fetch
  - On `401/403`: mark auth-failure cooldown and continue
  - On `429`: mark rate-limit cooldown (with retry-after) and continue
  - On success: update lastUsed + activeIndex, persist store, and update `Auth` via `input.client.auth.set`
- If all accounts fail, return the last response (or fallback to the current auth) to preserve existing error behavior.

Header handling details:
- Keep every header except `Authorization` from the incoming request.
- Do not mutate `init.headers` in place; build a new `Headers` object.
- Always set `authorization` (lowercase) to avoid duplicate header keys.

Cooldown matrix (explicit):
- `401/403` from Codex endpoint → `auth-failure` cooldown, continue to next account.
- `429` from Codex endpoint → `rate-limit` cooldown, continue to next account if another exists.
- Network error during fetch or refresh → treat as `auth-failure` cooldown for that account.
- Any non-429/401/403 response → treat as success (let caller handle errors like 400/500).

Concurrency note:
- Multiple concurrent requests can race on store writes; last write wins.
- Keep operations idempotent and tolerate stale `activeIndex` values.

### 4) Account enrollment during OAuth
When `authorize` completes:
- Upsert the new account into the store (refresh/access/expires/accountId/email).
- Set it as active and persist the store.
- Update active auth record via `input.client.auth.set` so the rest of the system sees the new account.

Minimal multi-account UX:
- Implement the prompt in the `opencode auth login` CLI flow (not inside the plugin) so server-only usage never blocks.
- After successful login, prompt the user with: **“Log into another account?”** (yes/no).
- If “yes”, repeat the normal login flow and append the account.
- Only show the prompt when running interactively (TTY, not CI, not `OPENCODE_NON_INTERACTIVE=1`).

CLI integration points:
- Add the prompt in `packages/opencode/src/cli/cmd/auth.ts`, inside `handlePluginAuth`, only after a successful OAuth login for provider `openai`.
- Use `prompts.confirm({ message: "Log into another account?", active: false })`.
- If “yes”, call `method.authorize(...)` again and run the same callback flow, looping until the user says “no” or cancels.

Avoid surprises:
- Keep the initial “Select provider” flow unchanged.
- Do not auto-open multiple browser windows at once; only one active OAuth flow at a time.

### 5) Optional UX / management hooks
If we want a first-class UX later:
- Add a CLI command (e.g., `opencode auth add --provider openai`) to re-run the OAuth flow and append accounts.
- Add a simple list/remove command for stored accounts (email/accountId + lastUsed + cooldown status).

These are optional but helpful for discoverability.

### 6) Tests
Add tests under `packages/opencode/test/plugin` (or a new unit-test file for the store module):
- Pure unit tests for store helpers: normalize/dedupe, attempt order, retry-after parsing.
- Integration-style test for switching behavior:
  - Spin up a local `Bun.serve` server that returns 429 for account A and 200 for account B.
  - Override the Codex endpoint in the test by injecting a URL (requires refactoring to allow dependency injection).
  - Assert that the second account is used and `activeIndex` updates.

Avoid mocks by using a real local HTTP server and deterministic responses.

Endpoint override for tests:
- Consider reading `process.env.OPENCODE_CODEX_ENDPOINT` inside the plugin (default to the current Codex endpoint).
- This avoids hard-coded network calls in tests and makes it easy to simulate responses.

### 7) Migration & Backward Compatibility
- On first run after upgrade, seed the store from the existing single-account OAuth auth entry.
- If the store is empty or corrupted, continue using the current auth to avoid regressions.

Corruption handling specifics:
- If JSON parsing fails, log a warning and continue with an empty store (do not crash auth flow).
- If `activeIndex` is out of bounds after normalization, clamp to 0.

### 8) Observability
- Add structured log lines when:
  - switching accounts due to rate limit
  - applying cooldowns
  - refreshing tokens
- Do not log tokens or raw headers.

Suggested log fields:
- `accountIndex`, `accountId` (if present), `cooldownReason`, `cooldownUntil`, `status`
- Avoid `email` unless the user explicitly opts into more verbose logs.

## Open Questions / Decisions
- **Prompting location:** implement the yes/no prompt in the CLI flow that runs `opencode auth login` (preferred) vs in the plugin (avoid blocking server-only usage).
- **Cooldown defaults:** confirm acceptable values (e.g., 5h for rate-limit, 2m for auth-failure).

## Success Criteria
- Multiple Codex OAuth accounts can be added and persist across runs.
- When a Codex account is rate-limited, the next account is used automatically.
- No regressions for single-account users or API-key users.
- Tokens are stored securely with restrictive file permissions.

## Implementation Checklist
- Create `packages/opencode/src/auth/codex-accounts.ts` with read/write/normalize helpers.
- Add secure file path under `Global.Path.data` with 0600 permissions.
- Update `packages/opencode/src/plugin/codex.ts` to seed store in `auth.loader`.
- Replace single-account fetch logic with multi-account switching flow.
- Ensure `input.client.auth.set` uses provider id `"openai"`.
- Add OAuth success upsert to the store and persist active account.
- Add CLI prompt in `packages/opencode/src/cli/cmd/auth.ts` after successful `openai` OAuth login.
- Add tests for store helpers and multi-account switching with a local `Bun.serve`.
