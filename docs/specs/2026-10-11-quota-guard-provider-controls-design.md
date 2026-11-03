# Quota Guard Provider Controls — Design

**Status:** Implemented on `main` (`07bbc57`); acceptance evidence is recorded in the archived implementation plan.
**Date:** 2026-10-11
**Repositories:** `pi-subagents`, `pi-harness`

## Goal

Guard Codex and CommandCode independently. One provider's automatic quota state must not pause or block the other. Operators need explicit controls to pause or resume all managed providers, Codex only, or CommandCode only. The same policy applies to main-session and spawned/resumed subagent text-generation calls.

The operator has selected a Codex reserve estimate of `3` units for each reported window, `codex.primary_window` and `codex.secondary_window`, on the reported 0–100 scale. CommandCode's quota route is currently unsupported; its guard should remain OFF so its dispatch is explicitly unguarded until live quota certification succeeds.

## Current behavior and constraints

- `src/settings.ts` has one opt-in `quotaGuardEnabled` setting and merges global then project `subagents.json` settings.
- `src/index.ts` snapshots that setting and installs `quotaGuardExtension` when enabled.
- `src/quota-guard/coordinator.ts` uses one shared `FleetLatch`. Most quota-read and assessment failures pause the shared fleet; only the known CommandCode 404 is provider-scoped today.
- The unsupported CommandCode route must never be treated as certified. When CommandCode guarding is ON, its 404 refuses CommandCode only. When its control is explicitly OFF, dispatch is permitted unguarded and status must make that explicit.
- `src/agent-runner.ts` passes the parent `ModelRuntime` to `createAgentSession`; ordinary spawned/resumed subagent text-generation therefore should traverse the same runtime hook as main dispatch. Existing faux-backend tests can bypass prototype interception, so they do not prove this path.

## Settings and compatibility

Add `quotaGuardCodexEnabled?: boolean` and `quotaGuardCommandCodeEnabled?: boolean` to `SubagentsSettings`.

Resolution per provider:
1. Explicit provider boolean wins.
2. Otherwise inherit legacy `quotaGuardEnabled` when it is a boolean.
3. Otherwise resolve OFF.

Keep `quotaGuardEnabled` readable for old configuration. Settings snapshots must preserve unset values instead of serializing implicit defaults. A provider-specific OFF is an explicit unguarded choice, not an unknown/default fallback. Unknown provider identity or malformed scope on a guarded attempt remains fail-closed; it must never silently fall through to the OFF lane.

When either provider is guarded, install one runtime seam capable of applying both provider checks and manual holds. If neither provider is guarded and the legacy setting does not enable one, the guard remains inert as today.

## Automatic provider-local behavior

Maintain independent automatic state for `openai-codex` and `commandcode`. A quota threshold, unknown reserve, unsupported endpoint, authentication/schema failure, or provider-specific network/5xx failure may block only that provider's new dispatches. It must not set a root-wide automatic latch that stops the other provider. In-flight admitted work drains normally. An identity that cannot be attributed safely refuses the current attempt before transport; it does not get reclassified as an explicitly disabled provider.

Provider OFF skips quota reads, reserve assessment, and automatic quota holds; dispatch proceeds unguarded. Manual operator holds remain separate and still apply to OFF providers.

## Manual controls and status

Support:

- `/quota-guard pause all|codex|commandcode`
- `/quota-guard resume all|codex|commandcode`
- `/quota-guard status`

Bare `pause` and `resume` remain aliases for `all` to preserve existing behavior. `all` means these two managed providers, not every provider in Pi. A targeted manual pause blocks only its named provider; a global manual pause blocks both, including a provider whose automatic guard is OFF. Resume clears only the requested manual target; guarded providers still require the existing fresh quota/policy check before reopening, while OFF providers reopen unguarded once their manual hold is cleared.

Status must distinguish per provider: guard ON/OFF (OFF explicitly says unguarded), manual pause target, automatic pause reason, unsupported status, reserve source/value, and installation status. No secrets or raw provider payloads are shown.

## Subagent coverage

Apply the exact same provider resolution, automatic state, and manual holds to ordinary main-session and spawned/resumed subagent text-generation. Do not add agent-specific controls. Add a real-runtime integration test that runs a child session using the inherited parent `ModelRuntime`, proving both ON and OFF behavior, provider-local automatic refusal, and targeted/all manual pauses; assert transport invocation counts and that the peer provider remains dispatchable.

Scope excludes auxiliary `classify`, image-generation, and deferred-stream methods. The low-level SDK default `streamFn` fallback is not a supported bypass for `runAgent`/`resumeAgent`; integration tests must prove those paths supply the inherited runtime. Retain strict seam refusal when the runtime decorator cannot install.

## Codex reserve activation

Use operator reserve entries `codex.primary_window: 3` and `codex.secondary_window: 3` in the existing `quotaGuardReserveUnits` setting. These are operator assertions for units one dispatch may burn; they are not inferred from the single live certification read. Calibrated observed reserves continue to win over operator seeds. Document that underestimation under-protects and that the user owns that risk.

Suggested operator state after implementation: Codex guard ON; CommandCode guard OFF/explicitly unguarded; Codex reserve 3 for each window. Do not change protected `settings.json` or auth files as part of implementation.

## Approaches considered

1. **Two explicit provider booleans plus independent automatic states (selected):** smallest clear surface for exactly two providers; legacy global setting remains a fallback.
2. **Provider map/object setting:** more extensible but adds structure without current need.
3. **Keep one shared automatic latch:** rejected because one provider's quota would still affect the other.

## Verification

- Settings tests: each provider flag precedence, legacy compatibility, unset snapshot behavior, all four ON/OFF combinations.
- Coordinator tests: every automatic failure class remains provider-local; disabled provider skips quota read; provider-local and all manual pause/resume behavior.
- Subagent integration: real inherited runtime path for `runAgent` and `resumeAgent`; ON/OFF and pause behavior for both provider identities; no fake-backend-only proof.
- Harness seam tests: supported runtime methods decorated; strict refusal when install fails; no new bypass on child dispatch.
- Run the quota guard suite, `typecheck:quota`, repository typecheck, host checks, repository `npm run check`, harness tests, and `git diff --check`.

## Review boundary

This document is a design only. No product code or operator settings have changed. After approval, create a detailed implementation plan, then implement and verify in serialized, reviewable slices.
