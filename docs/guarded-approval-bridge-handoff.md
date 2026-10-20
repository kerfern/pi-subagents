# Guarded Approval Bridge — Next-Session Handoff

**Updated:** 2026-10-19  
**State:** Implementation and offline verification complete. Reviews found three capability/lifecycle bugs; all fixed with regression tests. Final targeted re-review found no remaining findings. Real TUI acceptance remains a separate operator step.  
**Target:** `/Users/kerf/Projects/pi-subagents`, branch `main`  
**Other work:** VEMCsite remains paused through bridge review; preserve its checkout/worktree.

## Current state

Bridge is implemented in uncommitted working-tree changes. Tracked files: `CHANGELOG.md`, `README.md`, `docs/rpc.md`, `src/agent-manager.ts`, `src/agent-runner.ts`, `src/index.ts`, `test/rpc-lifecycle-gating.test.ts`. New files: `docs/guarded-approval-bridge-handoff.md`, `src/child-confirmation.ts`, `test/child-confirmation.test.ts`, `test/child-confirmation-manager.test.ts`, `test/child-confirmation-integration.test.ts`. Nothing staged or committed; no push, install, guard/config change, live UI call, or deployment.

- Environment: Node 26.7.0, npm 11.19.0; Pi SDK/AI/TUI 1.0.4; installed Pi runtime 1.3.0; Vitest 4.1.11, TypeScript 6.0.3, Biome 2.4.15.
- Focused tests: 5 files, 153/153 passed after all review fixes.
- Full offline check after all review fixes: `PI_E2E_LIVE=false rtk summary npm run check` exited 0; 2,289 passed, 7 skipped. Includes lint, typecheck and quota checks.
- Active diagnostics: 0 errors. Latest warning scan reports five existing AST hints in `src/agent-manager.ts` and one inferred-settings TS warning at `test/agent-manager.test.ts:1657` (test file not in a tsconfig); one file was inconclusive because language server is silent-on-clean. Full project checks/typecheck passed.
- `rtk git diff --check` passed. Working tree remains unstaged/uncommitted.
- Separate handoff Markdown Prettier check was unavailable: local binary missing, `npx` canceled; no package installed.
- Mutation tests killed strict-boolean, pinned-epoch, monotonic-deadline and native-dialog-barrier regressions; source was restored and focused suite passed. Tests also caught facade mutation exposure, expired-queue retention, descriptor-based raw-confirm access, inherited `valueOf` root-UI exposure, and foreground re-entry of running/queued resumes; all fixed and regression-tested.
- Independent reviews found two Important UI capability leaks and one Important resume-controller orphaning bug. Regression tests failed before fixes and passed after. Final targeted review found no remaining findings; it relied on supplied check results and did not rerun commands. Earlier review was supplied per-file runner/manager/index diffs. No real TUI smoke has run; do not claim operator acceptance.

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

1. Separate operator acceptance: user-controlled `/reload` and harmless real TUI smoke should establish root-dialog routing/child attribution, explicit approve/deny, concurrent FIFO, cancellation/timeout and stale-resume denial. Do not infer this from tests. Never reload the user's session automatically.
2. Resume approved VEMCsite Task 4 Round G §2 after bridge review; preserve existing work and restrictions. No live Xero/D1 calls, migrations, deployments, secrets, readiness bypasses, inference, quota-route changes, staging or commits without explicit approval.

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
