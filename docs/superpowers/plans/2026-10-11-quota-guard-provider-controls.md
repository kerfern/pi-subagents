# Quota Guard Provider Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Codex and CommandCode independent quota-guard switches, provider-local automatic pauses, targeted manual pause/resume commands, and identical protection for main and subagent text-generation dispatch.

**Architecture:** Resolve one enabled flag per provider, using explicit provider settings before the legacy global setting. Keep automatic pause state provider-local; layer explicit global or provider-specific manual holds over guarded and unguarded routes. Use the existing ModelRuntime interception seam, and prove child sessions inherit it with a real runtime integration test.

**Tech Stack:** TypeScript, Vitest, Node.js `node:test`, existing pi-harness runtime hook; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-11-quota-guard-provider-controls-design.md`

## Global Constraints

- Codex and CommandCode remain the only quota-guarded provider identities.
- Explicit provider OFF permits unguarded dispatch; manual pause still blocks its target.
- Automatic quota outcomes block only the matching provider; no provider-local error may set a root-wide automatic pause.
- Unknown identity or malformed scope on a guarded attempt refuses before transport; never fall through to OFF.
- Codex reserve seeds are operator assertions of `3` units for `codex.primary_window` and `codex.secondary_window`; strictly positive, same 0–100 scale as the reported `used` counters.
- Manual `all` means the two managed providers only. Auxiliary `classify`, image-generation, and deferred-stream methods are out of scope.
- No credential/config protected paths are read or modified; no dependencies added.
- Preserve unset-vs-explicit settings values in snapshots and global/project precedence.

## Review Focus

1. Project `false` versus global `true`: explicit provider false must win and remain false after a settings snapshot; pin this in `test/settings.test.ts`.
2. Legacy-only config: `quotaGuardEnabled: true` must keep both providers guarded, preserving old behavior; pin the fallback in `test/settings.test.ts`.
3. Guard OFF plus manual target pause: provider skips quota transport but manual pause still blocks it; pin both transport count and refusal in coordinator/host tests.
4. Automatic 404/auth/schema/network/5xx/unknown-reserve failures for one provider must not block its peer; pin provider-pair cases in coordinator tests.
5. Child-session path: `runAgent` and `resumeAgent` must inherit the actual runtime hook, not the faux backend's own methods; pin in a real-runtime integration test.

---

### Task 1: Add provider settings with legacy precedence

**Files:**
- Modify: `src/settings.ts` — `SubagentsSettings`, `sanitize`, `applySettings`, `SettingsAppliers`.
- Modify: `src/index.ts` — provider guard state setters and `snapshotSettings()`.
- Test: `test/settings.test.ts` and relevant settings wiring tests.

**Interfaces:**
- Add `quotaGuardCodexEnabled?: boolean` and `quotaGuardCommandCodeEnabled?: boolean`.
- Add provider setters in the quota-guard settings wiring; keep the existing `quotaGuardEnabled` setter as the legacy fallback.
- Resolution: explicit provider boolean → legacy `quotaGuardEnabled` boolean → `false`.

- [ ] Add failing settings tests for project/global merge, explicit provider true/false precedence, legacy fallback, default OFF, and unset snapshot round-trip.
- [ ] Run `npx vitest run test/settings.test.ts`; confirm those new assertions fail before implementation.
- [ ] Add the two optional booleans to `SubagentsSettings`, sanitize only actual booleans, apply provider setters, and include the original optional values (not resolved defaults) in `snapshotSettings()`.
- [ ] Run `npx vitest run test/settings.test.ts`; confirm green.
- [ ] Run `npx tsc --noEmit`; commit settings and tests.

### Task 2A: Build provider-local admission and pause state

**Files:**
- Modify: `src/quota-guard/controller.ts`, `src/quota-guard/coordinator.ts`, `src/quota-guard/root-binding.ts`, and `src/quota-guard/root.ts` (`failIdentity`, `pauseAndThrow`, `resolveScope`).
- Test: `quota-guard/test/controller.test.ts`, `coordinator.test.ts`, `root-binding.test.ts`, and `root.test.ts`.

**Interfaces:**
- Keep provider identities restricted to `openai-codex` and `commandcode`.
- Use one composite `FleetLatch`, not nested latches: track separate manual-all, provider-manual, and provider-automatic holds; provider epochs/counts; and atomically validate relevant epochs plus acquire one lease.
- Preserve account-lane FIFO and in-flight draining. `GuardCoordinator.admit` and fresh checks use the attempt's provider identity; provider failures never become root-wide automatic pauses.
- Preserve existing root `snapshot()`/legacy pause-resume compatibility for Task 2B consumers; expose provider-aware wait/admission/fresh-check operations from the root binding without wiring `index.ts` or `wake.ts` yet.

- [ ] Add failing paired-provider tests: low reserve/threshold, unsupported 404, auth/schema, network/5xx, and unknown reserve on one provider block that provider only; test the reverse direction. For a known provider with malformed account/credential scope, refuse and pause only that provider before transport; truly unassignable attempts refuse without silently passing through as OFF.
- [ ] Add failing hold-composition tests: automatic provider pause is independent; manual `all` blocks both; provider manual pause blocks only its target; in-flight leases drain.
- [ ] From `pi-subagents/quota-guard`, run `node --test --test-timeout=10000 test/coordinator.test.ts test/controller.test.ts test/root-binding.test.ts test/root.test.ts`; confirm red.
- [ ] Implement the composite gate's target-aware waits and atomic lease admission. Route every automatic failure to the provider's automatic hold, fence stale fresh checks by provider epoch, and refuse unattributable identity before transport.
- [ ] From `pi-subagents/quota-guard`, run `node --test --test-timeout=10000 test/coordinator.test.ts test/controller.test.ts test/root-binding.test.ts test/root.test.ts`; confirm green, then commit Task 2A.

### Task 2B: Wire targeted runtime controls and legacy wake safely

**Files:**
- Modify: `src/quota-guard/root.ts`, `index.ts`, `wake.ts`, `host-hook.ts`, `coordinator.ts`, and `controller.ts`.
- Test: `quota-guard/test/root.test.ts`, `wake.test.ts`, `host-hook.test.ts`, `production-wiring.test.ts`, `root-binding.test.ts`, `loader.test.mjs`, `coordinator.test.ts`, and `controller.test.ts`.
- Scope correction: `guardedProviders` must travel through the hook so Task 3 can select OFF providers without changing runtime interception; coordinator exposes synchronous manual-hold refusal for that OFF path. Legacy persisted `manual` is operator-owned, not an automatic wake candidate; explicit `resume all` may clear it and must atomically converge its stored manifest to open.

**Interfaces:**
- Expose the targeted pause/resume API needed by Task 3 without adding command parsing or presentation here.
- When the guard hook is installed, enforce manual holds for either known provider, including the provider whose automatic guard is OFF; otherwise preserve normal unguarded pass-through.
- Targeted resume checks only the target; all-resume checks every enabled provider automatic pause. Clearing an OFF provider's manual hold performs no quota read.
- Legacy root wake/recovery must never clear manual holds or promote a provider-local failure into a global pause. Do not introduce a durable per-provider schema; refuse an unattributable legacy state safely.

- [ ] Add failing runtime/control tests for provider identity routing, OFF-provider manual holds, target-specific and all-target resume checks, and legacy wake safety.
- [ ] From `pi-subagents/quota-guard`, run `node --test --test-timeout=10000 test/root.test.ts test/wake.test.ts test/host-hook.test.ts test/production-wiring.test.ts`; confirm red.
- [ ] Implement only runtime control and wake integration. Do not add Task 3 command syntax or status formatting.
- [ ] Run those focused tests and `node quota-guard/check-host.mjs` from `pi-subagents`; confirm green, then commit Task 2B.

### Task 3: Wire provider controls, commands, and truthful status

**Files:**
- Modify: `src/quota-guard/index.ts` — `QuotaGuardConfig`, `QuotaGuardControls`, installation, command parser, status.
- Modify: `src/index.ts` — pass resolved provider controls into the guard extension.
- Test: `quota-guard/test/host-hook.test.ts`, `quota-guard/test/production-wiring.test.ts`, and new focused command/status tests if those files cannot express the cases clearly.

**Interfaces:**
- Add `GuardTarget = 'all' | 'codex' | 'commandcode'`; map `codex` to provider ID `openai-codex`.
- Command syntax: `/quota-guard pause [all|codex|commandcode]`, `/quota-guard resume [all|codex|commandcode]`; omitted target aliases `all`.
- Keep `/quota-guard status`; show each provider as guarded or explicitly unguarded, plus manual/automatic pause, unsupported status, reserve provenance, and installation status.

- [x] Add failing command tests for all three targets, bare-command alias, invalid target refusal, and matching resume targets.
- [x] Add failing status tests proving OFF is labeled `unguarded` and provider-local automatic failures do not appear as a global pause.
- [x] From `pi-subagents/quota-guard`, run `node --test --test-timeout=10000 test/command-status.test.ts`; confirm the new command/status regressions fail before implementation.
- [x] Wire resolved settings into `quotaGuardExtension`. Register the command and runtime seam whenever at least one provider is guarded; while installed, apply manual holds to either known provider, including one whose automatic guard is OFF. If both providers resolve OFF, preserve inert default-OFF behavior and register no command or hook.
- [x] Implement target parsing, targeted pause/resume, and per-provider status; do not make unsupported CommandCode look admitted when its guard is ON.
- [x] From `pi-subagents/quota-guard`, run `node --test --test-timeout=10000 test/host-hook.test.ts test/production-wiring.test.ts test/command-status.test.ts`; run `node quota-guard/check-host.mjs` from `pi-subagents`; confirm green, then commit Task 3.

### Task 4: Prove real main and subagent dispatch coverage

**Files:**
- Create: `test/quota-subagent-runtime.test.ts`.
- Read/verify: `src/agent-runner.ts` — `runAgent`/`resumeAgent` pass the parent `ModelRuntime` into `createAgentSession`.
- Test host seam: `/Users/kerf/Projects/pi-harness/tests/runtime-hook.test.mjs` and `tests/runtime-seam-preflight.test.mjs`.

**Interfaces:**
- No agent-specific flags. Main and child text-generation use the same provider settings, automatic state, and manual holds.
- The test must use the actual inherited runtime/prototype interception; a fake model backend with own `stream` methods is not sufficient evidence.

- [ ] Add a failing integration test that starts/resumes a child through `runAgent`/`resumeAgent`, issues one Codex and one CommandCode generation through the inherited runtime, and asserts both traverse the quota hook.
- [ ] Parameterize provider ON/OFF, provider-local automatic refusal, targeted pause, and `pause all`; assert quota-read and model-transport counts plus peer-provider availability.
- [ ] Run `npx vitest run test/quota-subagent-runtime.test.ts`; confirm red for the new cases.
- [ ] Implement only the missing runtime/settings plumbing required by the test. Do not expand scope to `classify`, image generation, or deferred streams. Preserve strict install refusal so a missing seam cannot silently bypass guarded dispatch.
- [ ] Run the integration test plus `node --test tests/runtime-hook.test.mjs tests/runtime-seam-preflight.test.mjs` from `pi-harness`; confirm green, then commit each repo's changes separately.

### Task 5: Document controls and operator activation

**Files:**
- Modify: `docs/quota-guard-compatibility.md`.
- Modify: `docs/quota-guard-commandcode-unsupported.md` only if its current behavior wording needs to reflect explicit OFF/unguarded mode.

- [ ] Document provider setting precedence and exact JSON example: Codex ON, CommandCode OFF, with reserve units `codex.primary_window: 3` and `codex.secondary_window: 3`.
- [ ] Document that OFF intentionally permits unguarded dispatch; manual pause still applies; CommandCode ON still refuses until live scoped quota certification succeeds.
- [ ] Document exact pause/resume targets, bare alias behavior, and that automatic failures are provider-local.
- [ ] Document subagent coverage boundary (normal child text-generation covered; auxiliary runtime operations excluded).
- [ ] Run `git diff --check` and any docs lint available; commit docs.

### Task 6: Full acceptance and independent review

- [ ] Run `npx vitest run test/settings.test.ts test/quota-subagent-runtime.test.ts` in `pi-subagents`.
- [ ] From `pi-subagents/quota-guard`, run `node --test --test-timeout=10000 test/coordinator.test.ts test/controller.test.ts test/host-hook.test.ts test/production-wiring.test.ts`.
- [ ] Run `npm run typecheck:quota`, `npx tsc --noEmit`, `node quota-guard/check-host.mjs`, and `npm run check` in `pi-subagents`.
- [ ] Run `npm test` in `pi-harness`.
- [ ] Run `git diff --check`; confirm `git status --short` contains only intended files and report commits for each repo.
- [ ] Request one reviewer pass over provider isolation, legacy precedence, manual pause composition, and real subagent-path proof; fix blocking findings and rerun affected checks.

## Execution Recommendation

Recommend subagent-driven execution with one serial implementer per task and one final reviewer. The change crosses settings, coordinator latches, host controls, and a real child-runtime integration test; writers must stay serialized to avoid conflicting edits to `src/index.ts` and coordinator state.
