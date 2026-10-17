# Quota guard — compatibility and upgrade guide

The quota guard ships inside this extension at `src/quota-guard/`. Each provider's guard is
**off by default**. `quotaGuardCodexEnabled` and `quotaGuardCommandCodeEnabled` override the
legacy `quotaGuardEnabled`; an unset provider switch inherits the legacy switch, and if all three
are unset that provider defaults OFF. When both providers resolve OFF, command-only mode keeps
`/quota-guard on|off` available for changing persistent settings, but constructs no coordinator,
resolves no credentials, and decorates nothing. When either is ON, the runtime seam is installed and
manual holds apply to both known providers.

This document is for the operator. It exists because the guard depends on a handful of seams in the
installed pi build, and the way those seams can break is *silent*.

## Why silent drift is the dangerous case

The guard admits traffic by injecting a per-request `fetch` into the model runtime, so the last thing
it can inspect before a request leaves is that request. Three of the seams it needs are cheap to
observe — the runtime exposes `stream`/`streamSimple`, a public `getAuth(model)`, and the api ids it
reasons about. The fourth is not: whether the caller-supplied `fetch` is still the thing that builds
the outgoing request.

If that fourth seam moved, the guard would be installed, look healthy, and **gate nothing**. A guard
that fails open is worse than no guard, because everything downstream trusts it. So the guard's
response to an unmet seam is to **refuse activation** — never to fall back to dispatching unguarded
requests. A refusal is a feature.

## After a pi upgrade, run these in order

From the repository root:

```bash
npm run check:quota-host      # does the installed pi still expose the seams the guard needs?
npm --prefix quota-guard test # the guard's own suite (host-independent, fake transports)
npm run test:quota            # the same suite through the repo script
```

Then read the results:

| Outcome | What it means | What to do |
| --- | --- | --- |
| All three pass | The installed pi matches the seams the guard needs | Nothing. Re-enable if you had disabled it. |
| `check:quota-host` fails | The host moved in a way the guard relies on | **Leave the guard off.** The output names the resolved host path, its version, and each failed check. Report that output before repairing anything. |
| The guard suite fails | A code defect, not host drift | The failing test name is the whole story; report it. |

Keep the guard off until the host check passes. Enabling it against an unmet seam does not degrade
gracefully — it refuses at activation, and you get the refusal message instead of a quiet bypass,
which is the intended behaviour but not a working guard.

## Reading a refusal

Quota admission refusals also emit transient stderr diagnostics. `phase=read` carries the normalized
read code; `phase=assessment` carries the policy state and reason, plus the limiting window and next
check when known (bounded and escaped, so provider-controlled text cannot forge a second line):

```
Quota guard: provider=openai-codex phase=read code=unavailable
Quota guard: provider=openai-codex phase=assessment state=wait reason=unknown-reserve limitingWindow=primary_window nextCheckAt=2026-10-17T12:00:30.000Z
```

This distinguishes an unreadable quota surface from a successful read that policy refused — a refusal
can follow a healthy read. The lines are written after the pause or lane release, and a failing
stderr write never changes the refusal; dispatch remains fail-closed in both cases.

A window with no reserve and no calibratable estimate is its own terminal refusal: the error code is
`unconfigured`, it names the missing window ids, and the retry answers immediately instead of parking
on a hold only configuration can lift. The provider hold stays latched until a successful fresh check
commits a resume, and the terminal record is retired only once an admission observes the provider
open, so operator recovery is unchanged: seed `quotaGuardReserveUnits` for the named windows and
restart Pi.

Admission is refused by two independent triggers, and they are in different units. The percentage
thresholds (`warn 20`, `pause 3`, `resume 20` of the headroom that REMAINS, each test inclusive) are
percentages; the per-window reserve is `cap - used <= reserve`, in that window's own units. Because the
two do not share a scale, the reserve dominates whenever it exceeds that window's 3%: a 3-credit seed on a
14-credit window refuses with roughly 21% of its headroom left, which is why the shipped seeds sit below 3%
of each cap (monthly 2, weekly 1, fiveHour 0.4). A seed only fills an uncalibrated reserve - two rising
observations replace it with `2 x max delta` - so the effective refusal point settles on whichever trigger
is reached first.

A window whose usage falls only at the end of its period (a monthly pool) cannot satisfy the resume
threshold mid-cycle, so a pause it causes lasts until the reset. `/quota-guard resume` applies the same
threshold and will refuse, and the hold lives in memory, so only a restart clears it.

A refusal names the host build and every contract that failed, for example:

```
Quota guard: refusing to activate on @earendil-works/pi-coding-agent@1.1.0 — the host changed in a
way this guard relies on.
  - ...: runtime does not expose a public getAuth(model)
  - ...: required api "openai-codex-responses" is missing from the catalog
  Run `npm run check:quota-host` for the full host-conformance evidence, then repair the boundary in
  src/quota-guard/ and re-run it. See docs/quota-guard-compatibility.md. The guard never falls back
  to dispatching unguarded requests.
```

The refusal is produced by `checkHostCompatibility` in `src/quota-guard/compatibility.ts`, a pure
function of a host descriptor — it makes no request and reads no credentials.

Two other refusals are worth recognizing:

- A **dispatch refusal for a provider whose quota surface is not served here** names the provider, the
  route and the status, and says the guard cannot read that provider's quota. Its code is
  `unsupported` (see
  [CommandCode's quota surface](#commandcodes-quota-surface-live-status)).
  It refuses only that provider while its automatic guard is ON; the peer's automatic state remains
  independent, which is why this code is distinct from a root-wide pause.
- `status()` reports it explicitly in that provider's status (for example
  `status.providers.commandcode.unsupported`) and `/quota-guard status` prints an `unsupported`
  marker. It is not a root-wide pause: the peer provider remains independently available.

## Honest limits

- The host check proves what can be observed **offline**, with synthetic credentials and fake
  transports. It does not certify a real end-to-end request against a live provider, and it cannot
  certify providers or request paths that do not exist yet. The one deliberate exception is the
  operator-run live certification described below.
- Version metadata identifies which build the evidence came from. It is not proof of anything: a
  build claiming a familiar version but missing a seam is still refused, and a test pins exactly that.
- `fetch` does not cover WebSockets. Codex is forced onto SSE for this reason; an unsupported
  transport is refused rather than assumed guarded.
- Unguarded models are forwarded with `provider`/`api` pinned: a plain object as a copy, anything else
  through a thin wrapper that answers those two keys and delegates the rest. The wrapper is a `Proxy`,
  so a class-backed model whose prototype getters or methods touch **private** (`#`) fields can fail
  through it — the receiver is the wrapper, and a private brand check is failed by a proxy. This
  affects a shape the SDK already degrades: its own model copy drops prototype members.
- The guard does not self-repair. Nothing rewrites guard code, patches the SDK, or runs on a timer; a
  stale lock in its durable store is reported with the exact command to clear it, and that is
  deliberate — an automatic reclaim protocol that can silently break mutual exclusion is a worse
  trade than one manual step in a rare recovery path.
- CommandCode runs as a **single provider-wide lane**, because its API exposes no stable account id
  to key a lane on. All CommandCode traffic therefore shares one lane and serialises. This is a
  deliberate trade — a lane keyed on no verified identity would be a guess — and a per-account lane
  becomes possible only if CommandCode ever exposes a stable account id.
- **CommandCode's quota surface is served again (verified 2026-10-18)**, so its automatic lane is
  reachable and guarded dispatch admits. A quota route answering 404 would still refuse that provider
  as `unsupported`, which is no longer this provider's case. When
  `quotaGuardCommandCodeEnabled` is OFF, dispatch is intentionally unguarded (manual pause still
  applies). This is deliberate and dated, not a silent bypass: see
  [CommandCode's quota surface](#commandcodes-quota-surface-live-status).
- **Durability ceiling: a *fresh* pause is not recorded at all.** A pause reaches the durable store
  only when it can name at least one checkpoint, and nothing in the guard can enumerate pending
  effects yet. The store refuses a checkpoint-less pause by design, so the guard raises
  `CheckpointUnavailableError` and records nothing, rather than handing over an empty checkpoint list
  and letting the store's validation reject it — the refusal is deliberate, not incidental. Concretely,
  **after a restart a fresh pause is lost: its reason, its generation and its resume deadline are
  gone, no pending continuation is restored, and a paused root comes back open rather than paused.**
  Only a pause already present in a manifest (with a checkpoint in it) is reinstated, exactly as
  before. Where the wake machine refuses to record a pause, `status.wake.durable` is `false` and
  `/quota-guard status` prints `(not durable)`; with no manifest at all it reports `wake: null`. The
  guard deliberately does not fabricate a checkpoint id to make a pause look restorable: a reinstated
  pause that cannot name the work it was waiting for would be worse than the honest gap.
- For a provider whose automatic guard is ON, a fresh check can only re-read scopes the guard has
  **actually seen**. The reserve estimator is keyed by lane and the account FIFO's lane set is
  private, so the guard retains the last scope it was handed (credential included, in memory only)
  and re-reads *that* one on manual resume. It cannot enumerate or guess scopes: resume before an
  enabled provider has reached `admit` finds no retained scope and refuses. A provider whose
  automatic guard is OFF can have its manual hold cleared without a quota read, because OFF means
  dispatch is intentionally unguarded.

## CommandCode's quota surface (live status)

**Current: served.** Verified live on **2026-10-18** against the pinned origin
`https://api.commandcode.ai`: `GET /alpha/billing/credits` and `GET /alpha/billing/subscriptions` both
answer **200** with the same credential that serves models, and the guard parses them into real windows —
`monthly` (cap taken from `COMMANDCODE_MONTHLY_POOLS` for the reported plan), `fiveHour` and `weekly`
with their own caps and resets. Guarded CommandCode dispatch is enabled and admits; a refusal now comes
from policy (threshold or reserve) or from an unreadable read, never from a missing route.

Historically, on **2026-10-09**, those same routes answered **404** and guarded dispatch refused as
`unsupported`. That record is kept below, dated, because it no longer describes the API
([original probe evidence](./quota-guard-commandcode-unsupported.md), superseded). The 2026-10-09 probe: 

| Route | Status (2026-10-09) |
| --- | --- |
| `/alpha/whoami` | 404 |
| `/alpha/billing/credits` | 404 |
| `/alpha/billing/subscriptions` | 404 |
| `/alpha/usage/summary` | 404 |
| `/internal/billing/credits` | 404 |
| `/internal/billing/subscriptions` | 404 |
| `/models` | 200, same key |

The 404s come from the application itself (`X-Powered-By: Hono`), not from a WAF or an edge rule, and
`/models` answering 200 with the same key proves the credential is fine and that model serving works.
So this said exactly one thing: **the quota routes were not served here.** It did *not* say the vendor
has no API, and it was not a claim about CommandCode's model endpoints.

**Superseded 2026-10-18:** both billing routes now answer 200 and the guard reads them, so the
conclusion above no longer holds for this provider.

### What the guard does about it

- A quota route answering **404** is reported as **`unsupported`** — its own code, scoped to the
  provider. `status()` names it (see [Reading a refusal](#reading-a-refusal)), so an operator sees an
  unsupported provider rather than a merely unavailable one.
- An `unsupported` read refuses only that provider's attempt. Auth, schema, network, 5xx, quota, and
  unknown-reserve automatic holds are provider-local too; a failure in one lane does not pause or
  block its peer.
- **No silent unguarding while guarded.** With `quotaGuardCommandCodeEnabled: true`, the guard never
  falls back to CommandCode dispatch without a successful gate. If CommandCode's automatic guard is
  OFF, ordinary unguarded pass-through is intentional; a manual hold still blocks it.

### Re-enabling CommandCode

Nothing here is permanent, and re-enabling is a certification rather than a flag. It requires live
certification of all three:

1. **Scoped quota** — `node quota-guard/certify-live.mjs commandcode` succeeds against the live
   endpoint and prints real windows/caps/resets for the plan the account is actually on. The monthly
   cap stays the guard's own `COMMANDCODE_MONTHLY_POOLS` entry, never a provider number.
2. **Reserve** — the rolling windows carry enough real movement for the estimator to calibrate, or the
   operator supplies `quotaGuardReserveUnits`. An uncalibrated reserve keeps the guard closed.
3. **Gate** — a full guarded dispatch through the gate, after `check:quota-host` passes, with the quota
   read happening on the real route.

**All three hold as of 2026-10-18**: `node quota-guard/certify-live.mjs commandcode` prints real windows,
the operator supplies `quotaGuardReserveUnits` (the estimator's own values take over once they calibrate),
and a guarded dispatch through the gate returns a real completion. CommandCode's automatic guard is ON.
When a provider has not been certified, leave its guard OFF if unguarded dispatch is intended, or ON if
fail-closed refusal is intended; OFF must not be mistaken for guarded protection. Re-check after any
CommandCode or pi upgrade: this record is dated, and it expires with the provider's API.

## Certifying against live quotas (operator-authorised)

Everything above is offline: synthetic credentials, fake transports, no request leaving the machine.
`quota-guard/certify-live.mjs` is the one deliberate exception, and it exists because the adapters had
only ever been exercised against fixtures. It is the only thing in this package that talks to a
provider, and it is a separate command the operator runs on purpose rather than anything the guard
does for itself.

What it does, in full: it reads the credential from the environment of the shell that runs it, calls
the same `readQuota` the guard calls, and prints the normalised result — provider, scope, each
window's `id`/`used`/`cap`/`resetAt`, the reserve state, the thresholds it was assessed against, and
how many requests it made.

- **Read-only.** One bearer-authenticated `GET` per endpoint, to the pinned first-party origins only:
  `https://api.commandcode.ai/alpha/billing/credits` and `/alpha/billing/subscriptions` for
  CommandCode, `https://chatgpt.com/backend-api/wham/usage` for Codex. Nothing is written, purchased
  or sent anywhere else, and a redirect is refused rather than followed.
- **No secrets on stdout.** Never the credential, an `Authorization` header, or a raw response body —
  only normalised numbers and window ids. It reads only the variables you export: never `auth.json`,
  `settings.json`, the keychain, or anything under `~/.pi`.
- **Never automatic.** Not by the guard, not by the test suite — `quota-guard/test/certify-live.test.ts`
  injects a fake transport and asserts that nothing is sent — not by CI, and not by `prepublishOnly`.
- **Refuses rather than guesses.** No provider, an unknown provider, or a missing credential is a
  refusal that names the variable, never a fallback, and a malformed meter scope is refused before any
  request, so a typo cannot spend one. A refused argument is reported by shape and never echoed: a key
  passed positionally instead of exported cannot land in scrollback, CI logs, or a pasted bug report.

Run it from the repository root, with the credential exported in that shell only:

```bash
node quota-guard/certify-live.mjs --dry-run commandcode   # readiness only: prints origins/paths, sends nothing
node quota-guard/certify-live.mjs commandcode             # one read-only GET per endpoint
node quota-guard/certify-live.mjs codex
```

| Provider | Environment required |
| --- | --- |
| `commandcode` | `COMMANDCODE_API_KEY` |
| `codex` | `CODEX_ACCESS_TOKEN`, `CODEX_ACCOUNT_ID` (the `chatgpt-account-id` header), `CODEX_LIMITS` (the verified meter scope, as JSON) |

`CODEX_LIMITS` is required for the reason given under [First run](#first-run--what-to-expect): the
meter ids come from the account's own usage response and the guard does not guess them, so a
certification that supplied none could not attribute a read to a window.

Certification proves exactly one thing: that the adapters' pinned origins, headers, deadline and
parsing still agree with the provider's live schema, so the numbers it prints are the ones the provider
returned. It proves nothing beyond that.

- **Not reserve calibration.** The run builds a fresh estimator, so every window comes back
  `unknown (one read)`; a certification says nothing about how much headroom the guard will hold back.
- **Not dispatch coverage.** It reads quota directly. No `admit`, no dispatch, no wake, and no host
  binding is exercised.

For CommandCode the monthly cap is not one of the provider-reported fields. The provider reports the
plan, the remaining monthly credits, the rolling windows and their resets; the cap is looked up in the
guard's own `COMMANDCODE_MONTHLY_POOLS` table by that plan, and the success line says so.

`--dry-run` sends nothing, so it verifies nothing: it prints the plan and exits non-zero when a
variable is missing, and is a readiness check only. The live run exits non-zero on any refusal, which
is what makes it usable as a check rather than an observation. Exit codes: `0` certified, `1` refused
or failed, `2` usage.

| Outcome | What it means | What to do |
| --- | --- | --- |
| The windows and caps print | The pinned origins, headers, deadline and parsing still agree with the live API | Treat the reported windows as real. For CommandCode the monthly cap is the guard's own table entry for the reported plan, not a provider number. The reserve stays uncalibrated: one read cannot size it. Certify again after a provider or host upgrade. |
| A refusal (`schema`, `auth`, `rate-limited`, `unavailable`, `timeout`, `aborted`) | The provider changed shape, or refused the credential | **The guard stays closed.** A refusal certifies nothing: the guard keeps refusing rather than attributing an unrecognised shape to a window. Report the code and the provider, never the credential. |
| `unsupported` | A quota route answered 404: this provider's quota surface is not served here | **That provider's automatic guard refuses dispatch.** Its peer stays independent. Certify scoped quota, reserve and gate before enabling that provider's guard (see [Re-enabling CommandCode](#re-enabling-commandcode)). Not CommandCode's case since 2026-10-18: its routes answer 200 and its guard is enabled. |

## Enabling the guard

Only after the host check passes:

```jsonc
// subagents.json — legacy fallback; per-provider overrides may differ
{ "quotaGuardEnabled": true }
```

In a session, persistent provider switches can be changed without editing JSON:

```
/quota-guard on codex
/quota-guard off commandcode
```

`on|off` writes explicit provider settings to the current project's `.pi/subagents.json`, preserves
other settings, and takes effect after restarting Pi. Omit the target to set both providers:
`/quota-guard on` or `/quota-guard off`. The command remains available in command-only mode while
both providers are OFF; in that state it does not construct a coordinator, resolve credentials, or
decorate the runtime. A failed settings write is reported and does not claim success.

For immediate temporary holds, use:

```
/quota-guard status
/quota-guard pause [all|codex|commandcode]
/quota-guard resume [all|codex|commandcode]
```

Omitting a pause/resume target means `all`. Manual holds still apply when a provider's automatic
guard is OFF. They do not change the persistent switches. See [Manual control while installed](#manual-control-while-installed) for drain, status, and resume behavior.

For Codex, set the verified meter scope (`quotaGuardCodexLimits`) too — without it a Codex attempt
is refused rather than attributed to the wrong window. For provider-specific settings and reserve
example, see [Activating and deactivating](#activating-and-deactivating).

## First run — what to expect

Two things happen the moment the guard starts gating, and both look like a bug if you have not been
told to expect them.

**Each guarded provider starts closed and opens only once it can size a reserve.** The guard will
not admit that provider's traffic until it knows how much headroom to hold back. On first sight of an
unmeasured quota window, the estimator returns `null`, `assess` returns `wait` with reason
`unknown-reserve`, and that provider receives an automatic hold. The peer provider is unaffected.
An unknown reserve is never treated as zero: admitting traffic on a window whose burn rate is unknown
is the exact failure the guard exists to prevent.

A reserve becomes known once the estimator has at least two observations of the same window with the
same cap and reset, and has seen the counter move. It then holds twice the largest positive increment
out of up to five, ignoring refills — a decrease, or a change of scope or reset, clears what it had
and starts over. While a provider is automatically held for an unknown reserve, blind retries do not
create new observations. Use a targeted `/quota-guard resume codex` or `resume commandcode` to make a
fresh check against the last observed scope, or configure a conservative operator seed. The affected
provider stays closed until the reserve can be sized; its peer remains independent.

**On an idle account, retrying does not help — assert a reserve.** Every observation the estimator
gets happens inside dispatch, and dispatch is what the pause blocks, so on a fresh install over an
account that is not spending anything nothing ever moves and the reserve stays unknown forever. No
amount of retrying, and no amount of waiting, will free it: the only thing that would is a *different*
client spending quota in the same window. That is a deadlock, not the designed steady state, and the
way out is `quotaGuardReserveUnits`. Set it to your best estimate of the units one dispatch burns in
each window, and the guard opens on the first check. Get the window ids from
`node quota-guard/certify-live.mjs --dry-run` — for CommandCode they are `monthly`, `fiveHour` and
`weekly`; for Codex, `<meter-id>.primary_window` and `<meter-id>.secondary_window`.

**Codex needs its meter scope supplied.** `quotaGuardCodexLimits` is the set of verified meter ids and windows
for the account — which metered features are real, and that each is read from `primary_window` and
`secondary_window`. The meter ids come from the account's own usage response, and the guard
deliberately does not guess them: without the scope it cannot attribute a read to the right window, so
a Codex attempt is refused rather than attributed to the wrong one. What you see is a thrown refusal,
quoted here verbatim:

```text
Quota guard: no verified Codex meter scope configured; pass codexLimits to installQuotaGuard
```

The refusal applies only to Codex automatic state, so a missing scope stops Codex rather than
gating nothing; CommandCode remains independent.

## Child-runtime coverage

The runtime hook intercepts the shared SDK `ModelRuntime` prototype used by parent, `runAgent`, and
`resumeAgent` sessions. The regression test `test/quota-subagent-runtime.test.ts` exercises normal
text-generation through the real inherited runtime and built-in provider transports using fake HTTP.
This covers guarded and OFF provider behavior, but does not certify live provider APIs. Auxiliary
`classify`, image-generation, and deferred-stream operations are outside this guard's coverage.

## Activating and deactivating

The feature is called the **quota guard**. Two names matter:

| What | Name |
| --- | --- |
| Legacy/global fallback | `quotaGuardEnabled` |
| Codex override | `quotaGuardCodexEnabled` |
| CommandCode override | `quotaGuardCommandCodeEnabled` |
| The command | `/quota-guard` (`on|off [all|codex|commandcode]`, `status`, `pause|resume [all|codex|commandcode]`) |
| The code | `src/quota-guard/` in this repo; the harness side is `extensions/runtime-hook.mjs` |

For each provider, a defined provider-specific boolean wins; otherwise it inherits the effective
`quotaGuardEnabled` value, and if that is also unset it defaults OFF. Existing project-over-global
precedence applies to each key. Thus a provider override can enable one provider while the other stays
OFF, even if the legacy fallback is true.

**Activate.** In project-local `.pi/subagents.json` or the global settings file. This example
explicitly enables Codex and disables CommandCode despite the legacy fallback being true:

```jsonc
{
  "quotaGuardEnabled": true,
  "quotaGuardCodexEnabled": true,
  "quotaGuardCommandCodeEnabled": false,
  "quotaGuardStateDir": "/absolute/path/to/quota-guard-state",
  "quotaGuardCodexLimits": [{ "id": "codex", "windows": ["primary_window", "secondary_window"] }],
  // Operator estimates in the same 0–100 units as Codex used_percent; fallback only.
  "quotaGuardReserveUnits": {
    "codex.primary_window": 3,
    "codex.secondary_window": 3
  }
}
```

Then restart pi. The setting is read at extension load, so an already-running session keeps its old answer.

Check it took effect:

```
/quota-guard status
```

- `enabled, installed` → the seam is live; inspect provider lines for `guarded` vs
  `unguarded`, state, manual/automatic holds, and reserve provenance. OFF means unguarded dispatch
  unless a manual hold matches.
- `enabled, not installed` → the switch is on but installation failed. The reason is on stderr at startup and from `quotaGuardInstallFailure()`. The usual cause is that pi was started through the bare `pi` binary rather than the harness entry point, so the runtime hook is absent.

**The one remaining fail-open path, and how to close it.** Installation can fail *after* startup — the harness publishes the hook before any extension installs a decorator, so the decorator is applied asynchronously after boot and can fail then (a host whose prototype lacks `stream`/`streamSimple`, or a refused double-install). The guard detects that failure, records it and calls `pause('identity')` — but a latch is only consulted *by* the decorator, and the decorator is exactly what failed to install. So in that state the guard cannot block anything, and no change inside the guard fixes it: it has no interception point. The enforcement belongs to the seam owner. Set `QUOTA_GUARD_REQUIRE_SEAM=1` and the harness refuses to continue when a decorator fails to install, for every refusal path except the hook's own completed-duplicate refusal: a missing `ModelRuntime` prototype, a missing dispatch method, a decorator that throws, or one that returns no dispose function. Without the flag the default is to report the failure on stderr and keep running — which means genuinely ungated in the cases where the install left the runtime undecorated.

Without the flag, an install failure that leaves the runtime undecorated leaves pi running with nothing gated, so the flag is the only way to make that condition stop the session. With the flag, every genuine install failure refuses to continue — but one case is deliberately exempt.

A decorator **already present and gating** is not an ungated runtime: a factory resolved, so the seam is assumed covered, and refusing there would end a strict-mode session for a redundant same-process re-load. The harness raises that case as a distinct error type (`pi-harness/extensions/runtime-hook.mjs`), and `decideInstallFailurePolicy` classifies it as a warning in both modes and prints a retained-decoration message rather than "nothing is being gated". Classification is by the refusal the hook reports — its own completed-duplicate branch, never the error's type, `name`, or message — so any other failure still refuses, including a decorator factory that propagates the same error type from some other runtime. The exemption covers a **completed** decoration - the factory replaced BOTH `ModelRuntime.prototype.stream` and `streamSimple` and returned a dispose function. That is an identity check, not proof the wrappers gate correctly, but a no-op or half-wrapped factory is a failure rather than a silent success, and its partial decoration is reverted. An install still in progress is refused as an ordinary failure, because until the factory resolves whether dispatch is wrapped is **unverified** (a factory may wrap before it returns).

**A reload is not a reinstall.** Because pi's `/reload` reloads packages inside the same process, the original decorator stays in place and keeps gating, but the reloaded guard's own `bind` never runs — it binds only on a successful install — so its controls stay unbound, and it logs its own `enabled but NOT installed … nothing is being gated` line for the new binding. Strict mode therefore survives the reload (the harness warns), but treat a reload as needing a **restart** to pick up replaced guard code or settings.
- `disabled` → both effective provider switches are OFF; check settings source if that is unexpected.

**Deactivate.** Run `/quota-guard off` and restart Pi. This writes both provider switches as explicit
`false` values without changing the legacy fallback or other settings. Alternatively, set both
provider switches to `false` in the settings file. A legacy `false` does not override a
provider-specific `true`. When both are OFF, the command-only entry remains available for future
`on`/`off` changes, but no coordinator is constructed, no hook is looked up, no credentials are
resolved, and no runtime is decorated.

**Three optional keys, and what happens without them:**

- `quotaGuardStateDir` — an absolute path the guard may keep its durable pause/wake record in (created `0700` / `0600`, secret-free). Supplied, a pause **already recorded** in that directory is reinstated across a restart, and its deadline, backoff index and checkpoints are what `status.wake` reports. A **fresh** pause made in this session is not recorded, because it cannot name a checkpoint (see the durability ceiling under [Honest limits](#honest-limits)), so it is gone after a restart. Absent, the guard still gates exactly the same and reports `wake: null`: it simply does not persist or self-recover. That is a documented limitation, not a silent failure. A non-absolute path is dropped — a relative path is not a directory the guard can honestly own — so `wake` stays `null`.
- `quotaGuardCodexLimits` — the verified Codex meter scope: the meter ids and the windows each is read from (`primary_window` / `secondary_window`). Without it, a Codex attempt is **refused** rather than attributed to the wrong window (see [First run](#first-run--what-to-expect)). An entry that does not match that shape drops the whole list, so the Codex path stays refusing instead of becoming half-configured. CommandCode needs nothing extra; note that it runs as one provider-wide lane, for the reason given under [Honest limits](#honest-limits).
- `quotaGuardReserveUnits` — an operator-asserted per-window reserve, keyed by window id, in that window's own units. It is how a fresh install over an idle account is unblocked (see [First run](#first-run--what-to-expect)): it fills **only** a window whose reserve the estimator could not compute, and an observed reserve always wins over it, so it never blends with calibration and never turns an observed window back into an unobserved one. Absent, an unknown reserve stays unknown and the guard stays closed — this is not a default and the guard never invents one. An entry that is not a finite number strictly greater than `0` under a non-empty id drops the whole value, so a malformed seed cannot half-configure the guard. A seed of `0` is refused for the same reason an unknown reserve is never treated as zero: for a metered window no dispatch burns nothing, so accepting `0` would silently disable the protection this number exists to provide. **A value that is too small under-protects**: the guard will hold back less than a dispatch actually burns, and the operator owns that risk. Window ids for a real account are visible from `node quota-guard/certify-live.mjs --dry-run`.

### Manual control while installed

`/quota-guard pause [all|codex|commandcode]` and `/quota-guard resume [all|codex|commandcode]`;
omitted target means `all`. A targeted manual hold
blocks only that provider, including when its automatic guard is OFF; `pause all` blocks both.
Pause takes effect for new dispatch immediately. Already-admitted work finishes without abort, while
status shows the manual target and active counts; active counts fall as work drains. Automatic quota,
auth, schema, unsupported, network, and reserve outcomes remain provider-local.

For each requested provider whose automatic guard is ON, resume performs a fresh quota check outside
dispatch against its retained scope(s). It clears guarded holds only after a verified, in-policy
result; unreadable data, an unknown reserve, or no retained scope keeps that provider closed. A
resume before an enabled provider reached `admit` is refused. An OFF provider's manual hold can be
cleared without a quota read. `/quota-guard enable` has no target and applies on the next pi session.
