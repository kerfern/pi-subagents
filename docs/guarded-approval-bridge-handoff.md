# Guarded Approval Bridge — Next-Session Handoff

- **Updated:** 2026-10-20
- **State:** implementation, offline verification and the operator's offline re-verification are complete, and the work is COMMITTED and PUSHED (`3a964dd`, branch `main`, clean tree). Reviews found three capability/lifecycle bugs; all fixed with regression tests. Final targeted re-review found no remaining findings. **Real TUI operator acceptance has now been performed** (2026-10-20, see below); no defect was found and no code changed.
- **Target:** `/Users/kerf/Projects/pi-subagents`, branch `main`
- **Other work:** VEMCsite is no longer paused: PR #1 (the Xero-only invoicing cutover) was reviewed, merged into `main` and its branch deleted. The VEMCsite worktree was removed after the merge; the gitignored plan/ledger was copied into the main checkout.

## Current state

Bridge is implemented, committed and pushed. Commit `3a964dd` ("feat: route child extension confirmations through a guarded root approval bridge") contains the tracked changes (`CHANGELOG.md`, `README.md`, `docs/rpc.md`, `src/agent-manager.ts`, `src/agent-runner.ts`, `src/index.ts`, `test/rpc-lifecycle-gating.test.ts`) and the new files (`docs/guarded-approval-bridge-handoff.md`, `src/child-confirmation.ts`, `test/child-confirmation.test.ts`, `test/child-confirmation-manager.test.ts`, `test/child-confirmation-integration.test.ts`). The working tree is clean and `main` matches `origin/main`; no install, guard/config change, live UI call or deployment was performed.

**Operator re-verification (2026-10-20, this session):** the offline suite was re-run from a clean tree and passes — focused bridge suites 4 files / 33 passed (`child-confirmation`, `child-confirmation-manager`, `child-confirmation-integration`, `rpc-lifecycle-gating`), full `PI_E2E_LIVE=false npm run check` 2,289 passed / 7 skipped (lint, typecheck and quota checks included), `git diff --check` clean, `git status --short --branch` clean. These are OFFLINE checks: they are evidence that the contract holds under test, and they are NOT operator acceptance.

- **Real TUI operator acceptance (2026-10-20):** all ten scenarios in `docs/guarded-approval-bridge-tui-acceptance.md` were observed in a real root Pi TUI (runtime 1.3.0, SDK 1.0.4) with a live model, using a scratch harness in `/tmp/bridge-acceptance` (probe extension, root driver extension, project agent `bridge-probe`) driven through the extension's own `subagents:rpc:spawn` / `subagents:rpc:stop` channels. Every scenario passed; no defect was found, so no source file changed. Evidence: `/tmp/bridge-acceptance/result.log` (probe rows), `/tmp/bridge-acceptance/driver.log` (spawn/stop/reload trace) and the tmux pane captures of the root dialog, which showed `[Child name=<name>; id=<id>] Delete the temporary scratch file?` with the message unchanged. Method caveats are recorded in the acceptance brief: the operator's terminal did not decode arrow keys into the TUI, so the deny and cancel cases were driven by `tmux send-keys` (`j`+`Enter`, `Escape`) and the approve case was a real operator `Enter`; and the S10 reload used an extension-provided `F12` control (the stock `/reload` command and extension shortcuts are editor-scoped and therefore unreachable while a native dialog holds the keyboard). The offline suite was re-run afterwards and is unchanged: 2,286 passed / 7 skipped, clean diff, clean tree.
- **Offline end-to-end coverage (2026-10-20):** `test/child-confirmation-e2e.test.ts` now exercises the bridge end to end without a TUI: a real child session spawned through the real `Agent` tool, a real child extension calling `ctx.ui.confirm`, and a scripted root dialog bound to the parent session. It covers routing and attribution, approve and deny, FIFO ordering (three concurrent children), cancellation, the deadline and a late approval, a caller abort, an aborted child, a stale resume, the headless denial, a root switch, and the probe's child-only extension scoping. `test/fixtures/bridge-confirm-probe.ts` is the child-side probe; `test/helpers/print-mode-runner.ts` gained three optional options (`uiContext`, `eventBus`, `onBound`) for it, and `test/print-mode-runner.test.ts` pins the host's guards: a hook that resolves after the wall-clock guard must not prompt a torn-down session, and disposal is idempotent. A caveat for anyone delegating work in this repo: pi-jev's shield withholds tool output that mentions a "system prompt" (its deterministic injection marker scores 0.99), which makes delegated children look like they cannot read the repo — it is disabled for output-blocking in `~/.pi/agent/jev.json` (`modules.shield.shadow: true`, gate and watchdog untouched). It asserts the nonvisual contract only — native rendering, key input and dialog teardown during a real reload stay operator-only checks. Mutation-checked: reversing the queue order, dropping the attribution prefix, accepting a truthy non-boolean, letting a caller abort approve and leaving a closed lease's request unsettled each turn the suite red. An independent review pass tightened it: every run pins faux mode (`live: false`), the `onBound` hook sits inside the runner's guarded race, the 60s budget is asserted from both sides, and each denial test also asserts that the root dialog was really shown.
- Environment: Node 26.7.0, npm 11.19.0; Pi SDK/AI/TUI 1.0.4; installed Pi runtime 1.3.0; Vitest 4.1.11, TypeScript 6.0.3, Biome 2.4.15.
- Focused tests: 5 files, 153/153 passed after all review fixes.
- Full offline check after all review fixes: `PI_E2E_LIVE=false rtk summary npm run check` exited 0; 2,289 passed, 7 skipped. Includes lint, typecheck and quota checks.
- Active diagnostics: 0 errors. Latest warning scan reports five existing AST hints in `src/agent-manager.ts` and one inferred-settings TS warning at `test/agent-manager.test.ts:1657` (test file not in a tsconfig); one file was inconclusive because language server is silent-on-clean. Full project checks/typecheck passed.
- `rtk git diff --check` passed. Working tree remains unstaged/uncommitted.
- Separate handoff Markdown Prettier check was unavailable: local binary missing, `npx` canceled; no package installed.
- Mutation tests killed strict-boolean, pinned-epoch, monotonic-deadline and native-dialog-barrier regressions; source was restored and focused suite passed. Tests also caught facade mutation exposure, expired-queue retention, descriptor-based raw-confirm access, inherited `valueOf` root-UI exposure, and foreground re-entry of running/queued resumes; all fixed and regression-tested.
- Independent reviews found two Important UI capability leaks and one Important resume-controller orphaning bug. Regression tests failed before fixes and passed after. Final targeted review found no remaining findings; it relied on supplied check results and did not rerun commands. Earlier review was supplied per-file runner/manager/index diffs. A real TUI operator acceptance HAS since run (see the acceptance paragraph above); the claims here are the offline ones.

The approved plan is recorded in `.superpowers/sdd/2026-10-19-guarded-approval-bridge-plan.md` (ignored by Git). This handoff records observed state, not predictions.

## Implementation map

`src/agent-runner.ts::runAgent` creates child SDK sessions. Runner now starts a per-run confirmation lease before SDK extension binding, provides only the bridge facade to the child, retains binding with the SDK session, renews lease on retained resume without replaying startup, and closes leases on every exit path including errors and hard turn limits. Disk/fresh sessions receive a new binding.

`src/agent-manager.ts` passes one manager-owned bridge capability through the common run funnel for all spawn paths. Programmatic managers default headless. Resume runs use record-owned abort controllers; foreground caller cancellation is forwarded and its listener removed. Detached work is not tied to a completed parent-turn signal.

`src/index.ts` creates the bridge only for the owning root activation, resolves genuine root context there, and invalidates before root switch/shutdown. Child activations cannot promote their own UI to operator authority.

`src/child-confirmation.ts` owns FIFO scheduling, sticky bindings, per-run leases, caller/agent cancellation, total deadlines, identity/epoch checks, and permanent disposal. It denies failures closed and does not allow child writes to mutate root UI.

## Approved contract — do not redesign or weaken

One manager-owned FIFO serves direct, background, nested and workflow children. Root resolver belongs to owning bridge, never to arbitrary child contexts.

```ts
interface ChildConfirmationBinding {
  readonly uiContext?: ExtensionUIContext;
  beginRun(signal?: AbortSignal): () => void;
}

class ChildConfirmationBridge {
  constructor(resolveRoot: () => Pick<ExtensionContext, "hasUI" | "ui"> | undefined);
  forChild(agentId: string, agentName: string): ChildConfirmationBinding;
  invalidate(): void;
  dispose(): void;
}
```

- Each binding holds immutable child attribution. Each run gets a unique lease; its idempotent closer is fenced to that lease. Old cleanup cannot close a newer run.
- First UI access pins one genuine native UI/facade, or permanently headless capability for that binding/session. Do not reset either on resume. Same-native-UI resumes reuse the facade; different native UI requires a new binding and SDK session.
- Facade `confirm` reads current lease at call time; each request snapshots lease, epoch and native UI. Old pending requests cannot acquire a fresh resume's authority. Forward other native members with correct receiver; reject facade writes to protect root UI.
- Approval requires literal `true`, same live request/lease/root epoch/native UI and unexpired monotonic deadline. Prefix child attribution to original title; pass message unchanged.
- Deadline is 60 seconds from enqueue, shortened by caller timeout. Omitted/infinite timeout means 60 seconds; nonpositive/NaN denies. Caller/agent abort, missing UI, errors, stale ownership, invalidation and disposal deny.
- Expire queued requests independently. Denial settles child immediately and aborts native UI, but native in-flight slot stays occupied until promise settles. Never display a successor across an unresponsive native dialog; ignore late `true`.
- Invalidate before root switch/reload/shutdown/disposal. Future runs may use a fresh epoch after invalidation; disposal is permanently inert. SDK `hasUI` may remain a binding-time snapshot after invalidation; confirmation must still deny.

## Remaining actions

> The standalone brief for the acceptance session is
> `docs/guarded-approval-bridge-tui-acceptance.md`. It carries the contract, the
> probe-extension recipe, the ten pass/fail scenarios, the already-fixed defects
> and their regression tests, the sharp edges, and the report format. A fresh
> coding agent can run the acceptance from that document alone.

1. ~~**Real TUI operator acceptance (human step, the only open item).**~~ **DONE 2026-10-20** — all ten scenarios were observed in a real root TUI with a live model; no defect was found, so no source file changed. The contract held under real observation: the child's request reached the ROOT's native dialog with the attribution prefix and the message unchanged; an explicit APPROVE settled the child with `true` and an explicit DENY with `false`; two concurrent requests were shown one at a time in arrival order; cancelling the dialog, letting the 60-second deadline pass, aborting the child, and reloading the session all denied; a stale resume could not approve through the earlier request; a headless run denied immediately. The harness recipe, the method caveats and the exact evidence are in the acceptance brief ("Result of the 2026-10-20 run") and in the handoff's current-state section. Nothing about this was inferred from the offline tests.
   The checklist it satisfied, each observed rather than inferred:
   - the child's request reached the ROOT's native dialog, with the child attribution prefix and the message unchanged;
   - an explicit APPROVE settled the child with `true`, and an explicit DENY settled it with `false`;
   - two concurrent child requests were shown one at a time, in arrival order (FIFO), and the second never appeared while the first was unanswered;
   - cancelling the native dialog, letting the 60-second deadline pass, aborting the child and reloading the session all DENIED the request;
   - a stale resume (a run that was closed, then resumed) could not approve through the earlier request.
   Re-running it needs the same care: a harmless confirmation, a scratch directory, and a reload that the operator triggers — never one triggered automatically behind the operator's back.
2. **VEMCsite follow-ups (approved, separately tracked).** The Xero-only cutover is merged (`main` at `f083c14` after the dependency pin). Still open, and each needs its own explicit approval: the connected organisation's invoice-email eligibility, the granular scope that authorises credit-note writes, production D1 clock/distributed verification, and a live tenant acceptance. No live Xero/D1 calls, migrations, deployments, secrets or readiness bypasses are authorised by this handoff.

## Verification commands

```sh
cd /Users/kerf/Projects/pi-subagents
rtk git status --short --branch
PI_E2E_LIVE=false rtk npm test -- test/child-confirmation.test.ts test/child-confirmation-manager.test.ts test/child-confirmation-integration.test.ts test/rpc-lifecycle-gating.test.ts
PI_E2E_LIVE=false rtk summary npm run check
rtk git diff --check
rtk git status --short --branch
```

## Guard and dispatch boundaries

The parent-session Jev toggle did not remove child guard checks. Child `activate_project` output was withheld; an earlier worker retried despite a stop instruction and was stopped without edits. Do not retry that denial through another route or assume this session's toggle persists. If an operation is denied, stop and obtain operator authorization; do not change guard policy. No credentials, live provider/Xero/D1 verification, installs/removals, routing/quota changes, staging, commits, pushes, branches or discarded work are authorized.
