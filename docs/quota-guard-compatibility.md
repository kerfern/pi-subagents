# Quota guard — compatibility and upgrade guide

The quota guard ships inside this extension at `src/quota-guard/`. It is **off by default**
(`quotaGuardEnabled` unset or `false`): while it is off the package is inert, resolves no
credentials, decorates nothing, and registers no commands.

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
  route and the status, and says the guard cannot read that provider's quota, so dispatch is refused
  while the guard is enabled. Its code is `unsupported` (see
  [CommandCode's quota surface](#commandcodes-quota-surface-is-not-served-here-verified-live-2026-10-09)).
  It refuses that provider only: the shared fleet stays open for every other provider, which is the
  point of it being its own code rather than `unavailable`.
- `status()` reports it as its own field, so an operator never has to infer it from a pause. The status
  object carries `unsupported: ["commandcode"]` and `/quota-guard status` prints `unsupported
  commandcode` alongside the ordinary state — an unsupported provider is *not* a paused fleet.

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
- **CommandCode's quota surface is not served at all today**, so the guard refuses its dispatch and the
  lane above is currently unreachable. This is deliberate and dated, not a silent bypass: see
  [CommandCode's quota surface](#commandcodes-quota-surface-is-not-served-here-verified-live-2026-10-09).
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
- A fresh check can only re-read scopes the guard has **actually seen**. The reserve estimator is
  keyed by lane and the account FIFO's lane set is private, so the guard retains the last scope it was
  handed (credential included, in memory only) and re-reads *that* one on a manual resume. It cannot
  enumerate every scope that might exist, and it never guesses one: a resume before any attempt has
  reached `admit` finds no retained scope and refuses, which is the honest answer rather than a check
  against a scope nobody verified.

## CommandCode's quota surface is not served here (verified live, 2026-10-09)

Read this before enabling the guard for `commandcode`. The guard gates a provider by reading its quota
first, and CommandCode's quota routes are **not currently served**, so the guard cannot read one at
all. It therefore **refuses CommandCode dispatch** while it is enabled — and that refusal *is* the
intended behaviour, not a gap. CommandCode is never forwarded ungated.

Verified live on **2026-10-09** against the pinned origin `https://api.commandcode.ai`, one
bearer-authenticated `GET` per route, with the same credential that serves models:

| Route | Status |
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
So this says exactly one thing: **the quota routes are not served here.** It does *not* say the vendor
has no API, and it is not a claim about CommandCode's model endpoints.

### What the guard does about it

- A quota route answering **404** is reported as **`unsupported`** — its own code, scoped to the
  provider. `status()` names it (see [Reading a refusal](#reading-a-refusal)), so an operator sees an
  unsupported provider rather than a merely unavailable one.
- An `unsupported` read **refuses that provider's attempt and leaves the fleet open.** The latch is
  root-wide, so pausing it for one provider's missing quota route would lock out *every* provider.
  The refusal names the provider, the route and the status, and says plainly that the guard cannot
  read this provider's quota, so dispatch is refused while the guard is enabled.
- Everything else is unchanged: `401`/`403` is `auth`, `429` is `rate-limited`, and a `5xx` or a
  network error is still `unavailable` — which still pauses the fleet, because those are systemic
  rather than provider-scoped.
- **No silent unguarding.** The guard does not fall back to dispatching CommandCode ungated, ever. If
  CommandCode dispatch is needed with the guard enabled, its quota surface has to be served first.

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

Until all three hold, leaving CommandCode refused is the honest state. Re-check after any CommandCode
or pi upgrade: this record is dated, and it expires with the provider's API.

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
| `unsupported` | A quota route answered 404: this provider's quota surface is not served here | **The guard still refuses dispatch for that provider, and cannot be re-enabled by a flag.** Certify scoped quota, reserve and gate first (see [Re-enabling CommandCode](#re-enabling-commandcode)); other providers are unaffected and stay admitted. |

## Enabling the guard

Only after the host check passes:

```jsonc
// subagents.json
{ "quotaGuardEnabled": true }
```

In a session:

```
/quota-guard status    # state, reason, active counts, wake state
/quota-guard pause     # latches the fleet; admitted work drains, nothing is aborted
/quota-guard resume    # requires a fresh check to pass before it reopens
/quota-guard enable
```

For Codex, set the verified meter scope (`quotaGuardCodexLimits`) too — without it a Codex attempt
is refused rather than attributed to the wrong window.

## First run — what to expect

Two things happen the moment the guard starts gating, and both look like a bug if you have not been
told to expect them.

**The guard starts closed and opens only once it can size a reserve.** The guard will not admit
traffic until it knows how much headroom to hold back. On the first sight of a quota window the
estimator returns `null` for it, `assess` returns `wait` with reason `unknown-reserve`, and the fleet
latches — so the first attempts after enabling the guard pause rather than dispatch. That is the
designed starting state, not a fault. An unknown reserve is never treated as zero: admitting traffic
on a window whose burn rate is unknown is the exact failure the guard exists to prevent.

A reserve becomes known once the estimator has at least two observations of the same window with the
same cap and reset, and has seen the counter move. It then holds twice the largest positive increment
out of up to five, ignoring refills — a decrease, or a change of scope or reset, clears what it had
and starts over. Until then, waiting and retrying is the intended path, not a stuck session; each
retry gives the estimator another observation, and nothing is dispatched unguarded in the meantime.

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

The refusal also latches the fleet, so a missing scope stops traffic loudly instead of gating nothing.

## Activating and deactivating

The feature is called the **quota guard**. Two names matter:

| What | Name |
| --- | --- |
| The setting (the switch) | `quotaGuardEnabled` |
| The command | `/quota-guard` (subcommands `status`, `pause`, `resume`, `enable`) |
| The code | `src/quota-guard/` in this repo; the harness side is `extensions/runtime-hook.mjs` |

**Activate.** In `subagents.json` — project-local `.pi/subagents.json`, or the global settings file:

```jsonc
{
  "quotaGuardEnabled": true,
  // Optional, and both are read once at extension load. The keys are the settings names, not the
  // guard's internal host-field names.
  "quotaGuardStateDir": "/absolute/path/to/quota-guard-state",
  "quotaGuardCodexLimits": [{ "id": "codex", "windows": ["primary_window", "secondary_window"] }],
  // Only needed on an idle account the estimator cannot calibrate; see First run.
  "quotaGuardReserveUnits": { "monthly": 20, "fiveHour": 8, "weekly": 8 }
}
```

Then restart pi. The setting is read at extension load, so an already-running session keeps its old answer.

Check it took effect:

```
/quota-guard status
```

- `enabled, installed` → it is live and gating.
- `enabled, not installed` → the switch is on but installation failed. The reason is on stderr at startup and from `quotaGuardInstallFailure()`. The usual cause is that pi was started through the bare `pi` binary rather than the harness entry point, so the runtime hook is absent.

**The one remaining fail-open path, and how to close it.** Installation can fail *after* startup — the harness publishes the hook before the runtime prototype exists, so the decorator is applied asynchronously and can fail then (a host whose prototype lacks `stream`/`streamSimple`, or a refused double-install). The guard detects that failure, records it and calls `pause('identity')` — but a latch is only consulted *by* the decorator, and the decorator is exactly what failed to install. So in that state the guard cannot block anything, and no change inside the guard fixes it: it has no interception point. The enforcement belongs to the seam owner. Set `QUOTA_GUARD_REQUIRE_SEAM=1` and the harness refuses to continue when a decorator fails to install, for every refusal path: a missing `ModelRuntime` prototype, a missing dispatch method, an already-decorated prototype, a decorator that throws, or one that returns no dispose function. Without the flag the default is to report the failure on stderr and keep running — which means genuinely ungated only in the cases where the runtime is left undecorated.

Two consequences worth knowing before you set it. First, without the flag an install failure leaves pi running with nothing gated, so the flag is the only way to make that condition stop the session. Second, **with** the flag a redundant double-install also refuses to continue: the runtime is already decorated and gating, so that refusal is unnecessary, but the harness cannot distinguish "someone else is gating" from "nothing is gating". A reload that installs the guard twice will therefore end a strict-mode session; that is the accepted cost of the flag.
- `disabled` → your settings file is not being read from where you put it.

**Deactivate.** Delete the line or set it to `false`, and restart pi. With it off the package is inert: no coordinator is constructed, no hook is looked up, no runtime is decorated, nothing is written. There is no half-on state.

**Three optional keys, and what happens without them:**

- `quotaGuardStateDir` — an absolute path the guard may keep its durable pause/wake record in (created `0700` / `0600`, secret-free). Supplied, a pause **already recorded** in that directory is reinstated across a restart, and its deadline, backoff index and checkpoints are what `status.wake` reports. A **fresh** pause made in this session is not recorded, because it cannot name a checkpoint (see the durability ceiling under [Honest limits](#honest-limits)), so it is gone after a restart. Absent, the guard still gates exactly the same and reports `wake: null`: it simply does not persist or self-recover. That is a documented limitation, not a silent failure. A non-absolute path is dropped — a relative path is not a directory the guard can honestly own — so `wake` stays `null`.
- `quotaGuardCodexLimits` — the verified Codex meter scope: the meter ids and the windows each is read from (`primary_window` / `secondary_window`). Without it, a Codex attempt is **refused** rather than attributed to the wrong window (see [First run](#first-run--what-to-expect)). An entry that does not match that shape drops the whole list, so the Codex path stays refusing instead of becoming half-configured. CommandCode needs nothing extra; note that it runs as one provider-wide lane, for the reason given under [Honest limits](#honest-limits).
- `quotaGuardReserveUnits` — an operator-asserted per-window reserve, keyed by window id, in that window's own units. It is how a fresh install over an idle account is unblocked (see [First run](#first-run--what-to-expect)): it fills **only** a window whose reserve the estimator could not compute, and an observed reserve always wins over it, so it never blends with calibration and never turns an observed window back into an unobserved one. Absent, an unknown reserve stays unknown and the guard stays closed — this is not a default and the guard never invents one. An entry that is not a finite number strictly greater than `0` under a non-empty id drops the whole value, so a malformed seed cannot half-configure the guard. A seed of `0` is refused for the same reason an unknown reserve is never treated as zero: for a metered window no dispatch burns nothing, so accepting `0` would silently disable the protection this number exists to provide. **A value that is too small under-protects**: the guard will hold back less than a dispatch actually burns, and the operator owns that risk. Window ids for a real account are visible from `node quota-guard/certify-live.mjs --dry-run`.

**Manual control while it is on:** `/quota-guard pause` latches the fleet — admitted work drains, nothing is aborted; `/quota-guard resume` re-reads quota for the last scope the guard saw with the same reader and estimator it gates with, so a paused guard can calibrate and reopen; `/quota-guard enable` re-asserts the switch in-session. The check runs *outside* dispatch, which is what breaks the old deadlock where the only observation happened inside `admit` and `admit` itself blocked on the pause. It reopens only on a verified, in-policy read for every window the guard has seen; an unreadable read, an uncalibrated reserve, or no retained scope keeps it closed. Because only observed scopes can be re-checked, a resume before any attempt has reached `admit` is refused.
