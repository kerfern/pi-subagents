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

## Honest limits

- The host check proves what can be observed **offline**, with synthetic credentials and fake
  transports. It does not certify a real end-to-end request against a live provider, and it cannot
  certify providers or request paths that do not exist yet.
- Version metadata identifies which build the evidence came from. It is not proof of anything: a
  build claiming a familiar version but missing a seam is still refused, and a test pins exactly that.
- `fetch` does not cover WebSockets. Codex is forced onto SSE for this reason; an unsupported
  transport is refused rather than assumed guarded.
- The guard does not self-repair. Nothing rewrites guard code, patches the SDK, or runs on a timer; a
  stale lock in its durable store is reported with the exact command to clear it, and that is
  deliberate — an automatic reclaim protocol that can silently break mutual exclusion is a worse
  trade than one manual step in a rare recovery path.

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

For Codex, a caller must also supply the verified meter scope (`codexLimits`) — without it a Codex
attempt is refused rather than attributed to the wrong window.

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
  "stateDir": "/absolute/path/to/quota-guard-state"   // optional; see below
}
```

Then restart pi. The setting is read at extension load, so an already-running session keeps its old answer.

Check it took effect:

```
/quota-guard status
```

- `enabled, installed` → it is live and gating.
- `enabled, not installed` → the switch is on but installation failed. The reason is on stderr at startup and from `quotaGuardInstallFailure()`. The usual cause is that pi was started through the bare `pi` binary rather than the harness entry point, so the runtime hook is absent.
- `disabled` → your settings file is not being read from where you put it.

**Deactivate.** Delete the line or set it to `false`, and restart pi. With it off the package is inert: no coordinator is constructed, no hook is looked up, no runtime is decorated, nothing is written. There is no half-on state.

**Two optional keys, and what happens without them:**

- `stateDir` — an absolute path the guard may keep its durable pause/wake record in (created `0700` / `0600`, secret-free). Supplied, checkpoints and backoff survive a restart and `status.wake` is real. Absent, the guard still gates exactly the same and reports `wake: null`: it simply does not persist or self-recover. That is a documented limitation, not a silent failure.
- `codexLimits` — the verified Codex meter scope. Without it, a Codex attempt is **refused** rather than attributed to the wrong window. CommandCode needs nothing extra, but note its API exposes no stable account id, so all CommandCode traffic runs as **one provider-wide lane** and therefore serialises.

**Manual control while it is on:** `/quota-guard pause` latches the fleet — admitted work drains, nothing is aborted; `/quota-guard resume` reopens only if a fresh check passes; `/quota-guard enable` re-asserts the switch in-session.
