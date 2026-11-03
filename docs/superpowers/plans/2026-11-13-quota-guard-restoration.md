# Quota Guard Restoration Implementation Plan

> **Status: Planned — not executed.** No code from this plan exists. It closes the design question that
> kept TODOs #14–#17 blocked ("no process-restart restoration API") using APIs verified in the
> installed Pi 1.5.0 SDK. Sizes and check names below are proposals, not results.

**Goal:** Make a paused, interrupted guard recoverable across a process restart: reinstate the
transcript position, the fleet's holds and identities, attached children, and dependency structure —
without ever claiming an effect that was actually lost.

**What "restored" means, precisely:** a validated session branch plus reinstated guard state. It does
**not** mean an interrupted inference, tool execution, child process, or workflow worker resumed.
Those are recorded as lost and block the same automatic recovery a live reservation would.

**Grounding:** `dist/core/session-manager.d.ts` (Pi 1.5.0) exposes an append-only session tree:
`getLeafId()`, `getLeafEntry()`, `getEntry(id)`, `getBranch(fromId?)`, `getEntries()`, `getEntryCount()`,
`branch(branchFromId)`, `resetLeaf()`, `appendCustomEntry(customType, data?)`, `buildSessionContext()`,
`buildSessionProjection()`, `getTree()`. `branch()` moves the leaf pointer and never modifies or
deletes entries, so a checkpoint is a *branch selection*, not a truncation. Reopening a session selects
the last physical entry, so a pointer move alone is not durable and must be followed by an appended,
secret-free anchor; extension contexts hand out a **readonly** manager, and `navigateTree` selects a
user message's *parent* — hence anchors are non-context custom entries, and root restoration is an
explicit command, not a decorator side effect.

## Global constraints

- Provider-local admission, manual holds, identity fail-closed behaviour, and the harness startup
  barrier (`declared`/`strict`) are unchanged.
- Never reconstruct credentials, quota observations, or reservation amounts. A restored lane's
  estimator samples reset to unknown; configured reserve seeds are retained.
- Checkpoints carry allowlisted metadata only: `0700` directory, `0600` files, no credential material,
  unknown keys stripped on write — the same rules `store.ts` already enforces.
- No live provider calls, no paid dispatch, no dependency additions. Synthetic credentials and fake
  transports only.
- Lost in-flight reservations stay unknown and keep automatic recovery closed. Only a fresh verified
  attempt can rebind a credential or reopen a lane.

## Design

Checkpoints live beside the existing wake manifest, in `quotaGuardStateDir/checkpoints/<digest>.json`,
and are referenced from `Manifest.checkpoints` (already versioned and CAS-checked by generation).

Fields: schema version, Pi version and session-format version, checkpoint id, root id, session id and
path, anchor entry id, ancestry/projection digest, manifest generation, fleet generation, provider and
lane descriptors, manual and automatic holds, child identities plus configuration fingerprints,
dependency edges and queue order, result-entry references with consumption flags, and an explicit
`lost` list naming interrupted effects.

Capture only at safe persisted boundaries and at hold/dependency transitions: fence fleet mutations,
drain admitted requests, append the secret-free anchor, sync the referenced session file, write the
checkpoint atomically, then CAS-update the manifest. An unfinished call is never written as completed.

Load validates schema, digests, generations, session/header identity, entry ancestry, configuration
and graph completeness **before** any mutation, and distinguishes absent storage from present-but-invalid
storage (`store.read()` currently collapses both to `null`, which is not good enough for recovery).

## Tasks

### Task 1 (#14): checkpoint store and fleet state export

**Files:** `src/quota-guard/checkpoint.ts` (new), `store.ts`, `controller.ts`, `wake.ts`.
**Interfaces:** `validateCheckpoint`, `readCheckpoint`, `writeCheckpoint`,
`FleetLatch.exportState()/restoreState()`, `RootWake.recordPause()`.
**Tests:** `quota-guard/test/checkpoint.test.ts` (new), `store.test.ts`, `wake.test.ts`.
**Acceptance (offline):** write/read roundtrip across process reopen; file modes; unknown keys and
secret-shaped values absent from disk; crash-boundary fault injection leaves either the old or the new
checkpoint, never a partial one; stale generation rejected; historical session entries unchanged.

### Task 2 (#15): root binding, readiness and `/quota-guard restore`

**Files:** `src/index.ts`, `src/quota-guard/{index,root-binding,root,host-hook,coordinator}.ts`.
**Interfaces:** root identity bound at `session_start`; dispatch refused until a bound guard is ready;
`restoreLanes/checkQuorum`; `/quota-guard restore <id>` reporting truthful recovery status.
**Constraints:** do not await `session_start` inside decorator installation; do not weaken the startup
barrier; refuse rebinding a root whose fleet is live.
**Tests:** `quota-guard/test/production-wiring.test.ts`, `command-status.test.ts`,
`test/quota-root-restore.test.ts` (new).
**Acceptance:** premature dispatch refused; a cancelled restoration stays held; the projected context
after `navigateTree` equals the checkpoint's projection digest.

### Task 3 (#16): attach durable guarded children

**Files:** `src/agent-runner.ts`, `src/agent-manager.ts`, `src/types.ts`.
**Interfaces:** extract session preparation into a no-prompt `openGuardedChild`; add
`attachCheckpointChildren`. Validate an existing file before `SessionManager.open`, because a missing
path silently creates a fresh session. Attach interrupted records without running them; nonpersistent
children are explicitly lost.
**Tests:** `test/quota-child-checkpoint.test.ts` (new), `test/quota-subagent-runtime.test.ts`.
**Acceptance:** attachment issues zero model requests (assert the fake transport is untouched), and a
subsequent explicitly requested turn still crosses the guard.

### Task 4 (#17): restore fleet dependency structure

**Files:** `src/agent-manager.ts`, `src/group-join.ts`, `src/workflow/host.ts`, `src/workflow/task.ts`,
`src/index.ts`, `src/quota-guard/checkpoint.ts`.
**Interfaces:** dependency snapshot/restore registered at the actual ownership, wait and join
transitions. Restore ids, membership, ordering, deadlines and proven result references — never inferred
promise relationships. A missing or lost prerequisite stays blocked.
**Tests:** `test/quota-fleet-restore.test.ts` (new), `test/group-join.test.ts`.
**Acceptance:** restored graph equals the snapshot exactly; no duplicate completion delivery; a
snapshot naming a missing node is rejected rather than repaired.

## Failure modes (all fail closed)

| Condition | Answer |
| --- | --- |
| Stale manifest or fleet generation | Refuse recovery, keep holds, report the reason |
| Corrupt, truncated, or digest-mismatched checkpoint | Refuse; never fall back to the latest entry |
| Different Pi or session-format version | Refuse; no silent migration |
| Session file moved | Require explicit path rebinding plus full identity and digest validation |
| Anchor entry id absent from the session | Refuse; do not guess a nearby entry |
| Credential or lane quorum incomplete | Stay paused; no automatic recovery |

## Risks and residual limits

Arbitrary workflow stacks are not recoverable, and neither are external side effects already committed
by tools. Notification delivery through `group-join` may still be ambiguous after a restart. #17 restores
structure, not execution: a resumed child does not continue the turn it was in.

## Sequence

#14 → #15 → #16 → #17, roughly 4/6/3/6 source files and 3/3/2/2 suites, with overlap. Update `README.md`
and `docs/quota-guard-compatibility.md` alongside behaviour. Proposed checks, not yet run:
`npm run check`, `npm run check:quota-host`, and the harness `npm test`. #18 gates stay as they are:
crash/restart coverage, zero-egress assertions, strict-evidence revalidation, explicit rollout approval.
