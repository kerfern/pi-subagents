# CommandCode quota was unsupported here — live probe record (2026-10-09)

> **Superseded 2026-10-17.** CommandCode's billing routes now answer 200 and the guard reads them; see
> [Compatibility and upgrade guide](./quota-guard-compatibility.md#commandcodes-quota-surface-live-status).
> Everything below is the dated 2026-10-09 record, kept as evidence for how it was established.

**Status (2026-10-09, superseded): CommandCode quota could not be read.** With
`quotaGuardCommandCodeEnabled: true`, CommandCode dispatch was **refused**, not passed through
unguarded. When its automatic guard was OFF, dispatch was intentionally unguarded unless manually
paused. Codex was unaffected.

**Scope of this claim.** These probes establish that the routes *tested* are not served from *this*
host with *this* credential. They do **not** establish that no CommandCode quota API exists anywhere,
that these routes are permanently gone, or that an API key can never read quota. Re-test before
concluding otherwise; do not re-enable on the strength of any single route returning 200.

Probed: 2026-10-09, read-only, operator-authorised.

## Environment

- Host: `https://api.commandcode.ai` — the same `baseUrl` the working CommandCode model provider uses.
- Credential: the CommandCode API key from the provider config (never printed or recorded).
- Headers: `Authorization: Bearer <key>`, `Accept: application/json`, an explicit `User-Agent`, and
  on `/alpha/*` also `x-command-code-version: 1.0.0` and `x-cli-environment: production` — the
  adapter's own header set.

## Routes

| route | with key | unauthenticated |
|---|---|---|
| `/models` | **200** (OpenAI-style model list) | — |
| `/alpha/whoami` | **404** | — |
| `/alpha/billing/credits` | **404** | — |
| `/alpha/billing/subscriptions` | **404** | — |
| `/alpha/usage/summary` | **404** | — |
| `/internal/billing/credits` | **404** | **404** |
| `/internal/billing/subscriptions` | **404** | **404** |
| `/internal/usage/summary` | **404** | — |
| `/provider/v1/models` | **404** | — |
| `/openapi.json`, `/swagger.json`, `/api-docs`, `/docs`, `/health`, `/api/openapi.json`, `/v1/models`, `/credits`, `/usage`, `/billing/credits`, `/api/billing/credits`, `/` | **404** | — |

The 404s come from the **application**, not the edge: the responses carry `X-Powered-By: Hono` and
`Server: cloudflare`, and a Cloudflare block returns 403 (see below) rather than 404. These routes
are absent from the routing table, not hidden behind a WAF rule.

## Two findings that affect the guard itself

**The user-agent header is load-bearing.** `/models` returns **403** with no explicit `User-Agent`
and **200** with `pi/1.1.0`, `pi-quota-guard/1.0.0`, `curl/8.7.1` or a browser UA. That 403 is
Cloudflare bot protection, not authentication. The guard's adapter sets
`user-agent: pi-quota-guard/1.0.0`, which passes — remove that header and every quota read is
blocked.

**No quota is available in headers.** The `/models` response headers are infrastructure only
(`Server-Timing`, `x-trace-id`, `CF-RAY`, `NEL`, `Report-To`, `alt-svc`, `Access-Control-Allow-Origin`,
`X-Robots-Tag`) and the body carries no quota fields. A header-derived quota read is therefore not
possible on a request the guard already makes — and model-call headers would arrive *after* the
admission decision, so they could not gate it.

## Third-party corroboration (same day)

- `nesszer/Win-CodexBar` uses `/internal/billing/credits` and `/internal/billing/subscriptions` on the
  same host — also 404 here.
- `steipete/CodexBar` describes those billing endpoints as "authenticated with the signed-in Command
  Code web session", offering a manual `cookieHeader` mode. A browser session cookie is **not**
  an acceptable basis for this guard: read-only is not the same as least privilege, and it would mean
  storing session credentials, pinning a host, and matching an account to use them.
- `Khip01/commandcode-bridge` still lists the `/alpha/*` routes — consistent with a stale client.

## Why refusal, not removal

Dropping CommandCode from the guard would have left it running with **no** quota protection while
looking like a fix. The guard therefore refused CommandCode dispatch with a message naming the
provider, the route and the status. A 404 on a quota route is classified `unsupported`, which is scoped to that
provider: it refuses the CommandCode attempt and leaves Codex unaffected. Network and 5xx
automatic holds are provider-local too.

## Re-enabling

Requires live certification of a **scoped** quota read (per-account or per-plan, with a reserve and a
gate) — not merely a route that returns 200. **Met on 2026-10-17**: the scoped reads, the operator
reserve and a full guarded dispatch all certify, so CommandCode's automatic guard is ON again; see the
[compatibility guide](./quota-guard-compatibility.md#commandcodes-quota-surface-live-status).
