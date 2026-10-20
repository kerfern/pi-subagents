# Guarded Approval Bridge — TUI Operator Acceptance (standalone session brief)

**Audience:** a coding agent with a real terminal, running as the operator's hands.
**Repo:** `/Users/kerf/Projects/pi-subagents`, branch `main`.
**Baseline commit:** `f1a79fe` (this document) — the bridge itself is `3a964dd`.
**Status when written:** implementation, code review and OFFLINE verification are complete. **The real TUI behaviour has never been observed.** This session exists to observe it and, only if a defect is found, to fix it.

Nothing in this brief authorises a live provider call, a credential change, a guard-policy change, a deployment, or an automatic `/reload` of the operator's session. If any step seems to need one of those, stop and ask.

---

## 1. What you are verifying

The `pi-subagents` extension lets a **child** agent (a spawned subagent) ask the **operator** a question through a native dialog. The child calls `ctx.ui.confirm(title, message, opts?)`, exactly like any other Pi extension. The point of the bridge is that a child must never be able to fake operator authority: the dialog that appears must be the ROOT session's real native UI, it must carry the child's identity, and it must deny (not approve) whenever anything about the request is stale, cancelled, expired, or torn down.

Implementation map (read these before you start; they are the contract):

| File | Role |
| --- | --- |
| `src/child-confirmation.ts` | The bridge: one manager-owned FIFO, sticky per-child bindings, per-run leases, deadlines, epoch checks, fail-closed denial. |
| `src/agent-runner.ts` | Starts a per-run lease (`beginRun`) and binds the child session's extensions with the **facade** as `uiContext` (`:1064`-`:1073`), so a child's `ctx.ui.confirm` is intercepted. |
| `src/agent-manager.ts` | Hands every child run a `ChildConfirmationBinding` (`this.childConfirmations.forChild(id, alias)`, `:1011`). The default manager is **headless** (`:479`). |
| `src/index.ts` | Creates the bridge **only** for the owning root activation and resolves the genuine root context there (`:614`). Child activations cannot promote their own UI. |
| `docs/guarded-approval-bridge-handoff.md` | The architecture handoff: contract, invariants, guard boundaries. Read it too. |
| `docs/rpc.md` | The public description of the broker's rules. |
| `test/child-confirmation*.test.ts`, `test/rpc-lifecycle-gating.test.ts` | The offline contract tests (33 tests across 4 files). |

### The contract in one paragraph

The bridge lends the root's native UI to exactly one child binding. The first UI access **pins** the native UI (or pins "headless forever" for that binding). Each run gets a **lease**; a new run closes the old lease, and a closed lease can never approve. Every request snapshots the lease, the root **epoch** and the native UI; approval requires the literal `true` returned by the root's own dialog AND a still-live lease AND the same epoch AND the same native UI AND an unexpired deadline. The title the operator sees is prefixed `[Child name=<name>; id=<id>] `. Everything else - missing UI, a cancelled dialog, a 60-second deadline, a caller/agent abort, a root switch, `/reload`, disposal, a stale resume - **denies**. There is exactly **one** dialog at a time; queued requests wait in FIFO order and are never shown while another is unanswered.

---

## 2. Environment and prerequisites

- macOS, Node 26.7.0, npm 11.19.0 (as recorded in the handoff).
- The repo is installed and clean: `cd /Users/kerf/Projects/pi-subagents && rtk git status --short --branch` must print `## main...origin/main` and nothing else.
- Pi SDK/AI/TUI 1.0.4, installed Pi runtime 1.3.0. The operator's normal Pi session works (if the operator cannot start a TUI at all, stop: the acceptance cannot be performed here).
- A **scratch directory** outside the repo (for example `/tmp/bridge-acceptance`) for the probe extension and its output. Never point the probe at real data.
- `rtk` is available; use it exactly as the handoff does (`rtk npm test`, `rtk summary npm run check`, `rtk git diff --check`).

Offline baseline (already green; re-run it first to confirm the tree you start from):

```sh
cd /Users/kerf/Projects/pi-subagents
rtk git status --short --branch
PI_E2E_LIVE=false rtk npm test -- test/child-confirmation.test.ts test/child-confirmation-manager.test.ts test/child-confirmation-integration.test.ts test/rpc-lifecycle-gating.test.ts
PI_E2E_LIVE=false rtk summary npm run check
rtk git diff --check
```

Expected: 4 files / 33 passed; `npm run check` -> 2,289 passed, 7 skipped; clean diff and status.

---

## 3. What "pass" means, scenario by scenario

Each scenario needs the ROOT Pi TUI open, a child running, and an observer watching the ROOT dialog. The child must be a real child of the root session (a subagent spawned through the `pi-subagents` extension), because only that path carries the bridge.

Record for every scenario: **what the operator saw**, **what the child received** (`true`/`false`), and **pass/fail**.

### S1 - Routing and attribution

The root session spawns a child whose extension calls `ctx.ui.confirm("Delete the temporary scratch file?", "This is only a probe.")`.

- **Pass:** a native confirm dialog appears **in the root TUI** (not in a child transcript), its title starts with `[Child name=<child name>; id=<child id>] `, and the message is exactly "This is only a probe." (unchanged).
- **Fail:** the dialog appears anywhere else; the title has no attribution; the message is altered; no dialog appears at all.

### S2 - Explicit approve

Same probe; the operator **approves**.

- **Pass:** the child's promise resolves `true`; the child continues; nothing else is asked.
- **Fail:** resolves `false`; the child hangs; the dialog reappears; a second dialog appears.

### S3 - Explicit deny

Same probe; the operator **denies**.

- **Pass:** the child's promise resolves `false`; the child continues (a denial is not an error).
- **Fail:** resolves `true`; the child is killed; the child hangs.

### S4 - FIFO with two concurrent children

Two children (spawn both, in a known order A then B) each call `ctx.ui.confirm`.

- **Pass:** exactly one dialog is visible at a time; A is shown first, B waits; after A is answered, B is shown. If the operator can answer B's dialog while A is up, that is a fail (the second request must not be reachable).
- **Fail:** two dialogs visible at once; the order is inverted; a queued request is dropped.

### S5 - Cancellation of the native dialog

The operator dismisses the dialog (Esc / cancel) without choosing.

- **Pass:** the child resolves `false`.
- **Fail:** resolves `true`; hangs; the dialog stays up.

### S6 - Timeout

The operator leaves the dialog unanswered. The deadline is 60 s from enqueue (or the caller's shorter `opts.timeout`).

- **Pass:** within ~60 s the dialog closes on its own and the child resolves `false`.
- **Fail:** it stays up indefinitely; it resolves `true`; the child hangs.

### S7 - Child abort

The operator aborts the child run while its confirmation is pending.

- **Pass:** the pending dialog is dismissed (or at least stops blocking) and the child resolves `false`.
- **Fail:** the dialog stays up and blocks the root; the child never settles.

### S8 - Stale resume

A child is run, its confirmation is pending, and the run is closed and then **resumed** (same child record, second run).

- **Pass:** the earlier pending request cannot approve through the new run; the resumed run's own request is the only live one; the old request denies.
- **Fail:** the old request resolves `true` after the resume; the resumed run inherits the old dialog's answer.

### S9 - Headless denial (no root UI)

Run a child through a **programmatic** manager (or otherwise without a root UI): the default `AgentManager` in `src/agent-manager.ts:479` is headless by design.

- **Pass:** the child's `ctx.ui.confirm` resolves `false` immediately; no dialog appears; nothing hangs.
- **Fail:** it throws; it hangs; it resolves `true`.

### S10 - Root switch / reload invalidation

With a pending confirmation, the operator changes the root session (or runs `/reload` **by hand**).

- **Pass:** the pending request denies; the child resolves `false`; a later child run gets a fresh epoch and works normally.
- **Fail:** the pending request approves; the bridge stays pinned to the dead UI; later children hang.

> **Do not reload the operator's session automatically.** `/reload` invalidates the bridge by design; only the operator may trigger it, and only for S10.

---

## 4. Building the probe

The child needs an extension that calls `ctx.ui.confirm`. Extension authoring in this Pi version: a default-exported factory taking the `ExtensionAPI`, with `pi.on(event, handler)` where the handler receives `(event, ctx)`; `ctx.ui.confirm(title, message, opts?)` returns `Promise<boolean>`; `ctx.mode` is `"tui"` in the TUI; `ctx.hasUI` is true only where a dialog-capable UI exists.

Minimal probe (put it in the scratch directory, e.g. `/tmp/bridge-acceptance/.pi/extensions/confirm-probe.ts`):

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const LOG = "/tmp/bridge-acceptance/result.log";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Runs in BOTH the root and the child session. The child is the one that
    // matters: it is bound with the bridge facade, so its ctx.ui.confirm is
    // routed to the root dialog. The root's own call is a normal native dialog.
    const answer = await ctx.ui.confirm(
      "Delete the temporary scratch file?",
      "This is only a probe.",
    );
    appendFileSync(LOG, `${new Date().toISOString()} mode=${ctx.mode} hasUI=${ctx.hasUI} answer=${answer}\n`);
  });
}
```

Notes on the probe:

- Load it in the **child's** config. The child inherits the root's `.pi` extensions by default, so a project-level `.pi/extensions/confirm-probe.ts` in the working directory you spawn the child in is the simplest route. If the child is spawned with an `extensions` allowlist, add the probe by name/path there.
- Log the answer to a file (as above) so the result is observable after the run, in addition to what the operator sees.
- For S4, the probe must be invoked by TWO children. Either give the probe a tool the child calls (so the child decides when to ask), or have it ask on `session_start` twice with a small delay so the requests overlap. Two children each asking once is the cleanest.
- **Record the child id/name** the operator sees in the dialog prefix, and compare it with the spawned child's identity: attribution must name the asking child, not the root.

---

## 5. Known issues, prior fixes, and where the sharp edges are

These are the defects the reviews already found and fixed (each has a regression test). If you see one of them again, it is a REGRESSION: capture it and treat it as a blocker.

| Issue | Fix | Regression test |
| --- | --- | --- |
| Child could reach the root UI's own members (capability leak) | The facade forwards only the allowed members with the correct receiver; writes to the root UI are rejected; inherited `Object.prototype` members (`toString`, `valueOf`) are not forwarded. | `test/child-confirmation.test.ts` |
| A descriptor-based path could read the raw `confirm` | The facade exposes a bound wrapper; the raw native function is not reachable through the child's UI. | `test/child-confirmation.test.ts` |
| An expired queue entry was retained | Expired queued requests are settled independently of the in-flight one. | `test/child-confirmation.test.ts` |
| A closed run's cleanup could close a NEWER run | The lease closer is fenced to its own lease; old cleanup cannot close a newer run. | `test/child-confirmation.test.ts` |
| Foreground re-entry of a running/queued resume | `AgentManager.resume` rejects running/queued records before any mutation. | `test/agent-manager.test.ts`, `test/rpc-lifecycle-gating.test.ts` |
| A root switch left a resume controller orphaned | Root switch/reload/shutdown invalidates the bridge before the switch. | `test/rpc-lifecycle-gating.test.ts` |

Sharp edges to watch during acceptance, because the tests cannot see them:

1. **Dialog ownership.** A dialog that appears in a child transcript, or in a second root window, is a routing failure even if the answer is right.
2. **FIFO starvation.** The queue is drained by one async loop; a native dialog that never settles keeps the slot occupied (by design: a successor is never shown across an unresponsive dialog). If a child aborts and the dialog lingers, that is S7 failing.
3. **The 60 s deadline** is measured with `performance.now()` and starts at ENQUEUE, not when the dialog appears. A request that waits behind another inherits the earlier deadline, so a queued request can expire before it is ever shown: that is correct behaviour, not a bug.
4. **Epoch invalidation** is global to the bridge: one `/reload` denies every pending request from every child.
5. **Headless is permanent per binding.** If the first UI access happened while the root had no UI, that binding never gets UI later; a new binding (new child) is required.
6. **Programmatic managers are headless by construction** (`src/agent-manager.ts:479`): S9 is expected to deny, and that denial is the pass condition.

---

## 6. If a defect is found

1. **Do not "fix it by relaxing the contract".** The bridge denies by design; a surprising approval is a bug in the denial path, and the fix must keep every denial reason in force. Do not shorten a deadline, widen the allowed UI members, auto-approve, or re-enable a child-owned root context.
2. Capture, before changing anything: the exact steps, the root dialog's title and message, the child's observed answer, the child's id/name, and the Pi/SDK versions.
3. Write a **failing regression test first**, in the style of `test/child-confirmation.test.ts` (a fake root `ExtensionUIContext` with a `confirm` spy). The regression must fail without the fix and pass with it.
4. Fix in the smallest layer that owns the defect: `src/child-confirmation.ts` for bridge semantics, `src/agent-runner.ts` for binding/lease lifecycle, `src/agent-manager.ts` for per-child binding ownership, `src/index.ts` for root resolution/invalidation.
5. Re-run the offline gates, all of them:
   ```sh
   PI_E2E_LIVE=false rtk npm test -- test/child-confirmation.test.ts test/child-confirmation-manager.test.ts test/child-confirmation-integration.test.ts test/rpc-lifecycle-gating.test.ts
   PI_E2E_LIVE=false rtk summary npm run check
   rtk git diff --check
   rtk git status --short --branch
   ```
6. Commit with a message that states the defect, the fix and the regression test. Commits are expected here; **say so explicitly in your report**, and never force-push or rewrite published history.
7. Update `docs/guarded-approval-bridge-handoff.md` (state, verification, remaining actions) and the CHANGELOG.

## 7. Boundaries that hold in this session

- The parent session's guard policy is unchanged and must stay unchanged. If an operation is denied by a guard, **stop and report it**; do not route around it, and do not assume the toggle from a previous session persists.
- No live provider calls, no credential or config changes, no installs or removals of packages, no routing/quota changes, no deployment, no staging of unrelated work, and no discarded edits.
- The operator's own session is precious: never reload it, never answer a dialog on the operator's behalf, and use only harmless prompts in a scratch directory.
- The VEMCsite work is finished and merged; this session must not touch `/Users/kerf/Projects/VEMCsite` except to read the other handoff if you need context.

## 8. Report format

Finish with:

1. A table: scenario, expected, observed, pass/fail.
2. The exact commands you ran and their results (paste the summary lines, not the whole log).
3. Any defect found, with the reproduction steps and the regression test you added.
4. The commit(s) you created and whether you pushed.
5. An explicit statement of what you did NOT verify (anything you could not observe, and why).

If everything passes, say plainly: "the guarded approval bridge behaves as contracted under real TUI observation" - and nothing stronger. If something could not be observed (for example the TUI refused to start, or no second child could be spawned), say that instead of implying it passed.
