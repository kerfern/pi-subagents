# Shared Subagent Model Routing Design

**Status:** Approved in session on 2026-09-14  
**Repository:** `https://github.com/kerfern/pi-subagents`  
**Upstream:** `https://github.com/tintinweb/pi-subagents`  
**Upstream default branch:** `master`

## Problem

Current user extension routes only top-level `Agent` calls whose `subagent_type` is `implementer`. Other roles pin their own models, and workflow, nested, scheduled, and RPC dispatches can bypass the top-level `Agent` tool hook entirely. Extending that hook cannot enforce one model policy across all child processes.

Current fallback behavior also arms the next dispatch after a provider failure. With concurrent agents, that next dispatch may be unrelated to the failed task.

## Goals

- Apply one session-wide model selection to every newly spawned subagent.
- Keep Pi main-session model selection independent.
- Preserve voluntary session-specific subagent model selection.
- Validate selected and fallback models against Pi's live model catalog.
- Retry the same failed task once on the configured fallback.
- Fail closed when routing cannot continue.
- Cover direct, workflow, nested, scheduled, and RPC dispatch paths.
- Keep the fork current with upstream `master` without patching installed `node_modules`.

## Non-goals

- Per-project subagent model configuration.
- Per-role routing.
- Silent inheritance from the parent model.
- Silent use of agent-frontmatter or caller-supplied model overrides.
- Retrying task, test, gate, cancellation, or scope failures on another model.
- Re-routing an existing resumed session.

## Package ownership

Use `kerfern/pi-subagents` as a maintained fork. Development occurs in `/Users/kerf/Projects/pi-subagents`; Pi loads the GitHub fork, not the development checkout.

Branch roles:

- `master`: mirror of `upstream/master`.
- `shared-routing`: custom routing implementation plus synchronization workflow.
- Set `shared-routing` as fork default so scheduled workflows run from it.

Install globally from unpinned fork URL:

```text
git:github.com/kerfern/pi-subagents
```

Do not use `@shared-routing` in package source. Pi documentation treats explicit git refs as pinned; unpinned source follows fork default branch during `pi update --extensions`.

Remove existing npm package entry when adding git package. npm and git sources have different identities, so leaving both would load duplicate extensions.

## Routing boundary

All fresh dispatch surfaces converge on `AgentManager.startAgent`:

```text
Agent tool ───────────────┐
SubagentWorkflow ─────────┤
nested delegation ────────┤
scheduler ────────────────┤──> AgentManager.startAgent --> shared router --> runAgent
cross-extension RPC ──────┘
```

Router belongs at this boundary. Top-level tool hooks remain unsuitable because workflow and internal dispatches call manager directly.

## Routing state

One router instance belongs to extension/session and is passed to `AgentManager`.

```ts
interface SharedSubagentRoutingState {
  selectedModel?: string;
  routingFailed: boolean;
  terminalReason?: string;
}
```

Initial model constants preserve existing behavior:

```text
Default:  commandcode/deepseek/deepseek-v4.1-flash
Fallback: openrouter/nvidia/nemotron-3-ultra-550b-a55b:free
```

These are global subagent defaults only. They do not read or mutate `ctx.model`, Pi main-session default, or project settings.

Persist state in session custom entries under a new subagent-wide entry type. If no new entry exists, read latest legacy implementer-model entry and migrate once.

## Selection commands

- `/subagent-model`: canonical session-wide selector and status command.
- `/implementer-model`: compatibility alias invoking same selector.

Selector writes session state only. No per-project or persistent config is introduced.

Terminal errors must not open selector or ask user to select again.

## Model precedence

For every fresh subagent:

1. Session-selected shared model, when present.
2. Hardcoded global subagent default.
3. No other source.

Agent frontmatter, direct `Agent.model`, workflow `agent({ model })`, scheduler model fields, RPC model fields, and parent-session inheritance must not override shared routing.

A conflicting caller-supplied model is rejected with a clear routing error rather than ignored silently. Tool descriptions and docs must state that model choice is session-wide while shared routing is active.

Remove `model:` pins from global `Explore`, `reviewer`, and `worker` agent files. `implementer` remains unpinned.

## Attempt lifecycle

`AgentManager.startAgent` owns one logical agent record and at most two model attempts:

1. Resolve shared primary model.
2. Confirm exact provider/model ID exists in Pi live catalog.
3. Create isolation/worktree once.
4. Run task on primary.
5. If result is recognized provider failure, resolve and validate fallback.
6. Retry identical type, prompt, options, tool policy, and working tree on fallback.
7. Settle, notify, and clean up once after final outcome.

Record keeps one public agent ID. Usage from both attempts accumulates. Effective model metadata reflects final attempt; routing metadata records primary/fallback attempt identities for diagnostics.

Keeping one worktree avoids losing partial work between provider attempts. Cleanup and branch preservation occur only after final attempt.

## Failure policy

### Terminal before execution

- Shared routing latch already set.
- Selected/default model absent from live catalog.
- Selected/default model cannot be resolved exactly.
- Caller supplies conflicting model override.

These fail before worktree creation or model execution.

### Retry once

Retry only recognized provider/auth/transport failures, including existing classifier's quota, rate-limit, authentication, unavailable-model, and provider startup failures.

### Terminal after primary failure

- Fallback absent from live catalog.
- Fallback cannot be resolved exactly.
- Fallback returns recognized provider failure.

Set shared terminal latch and preserve exact reason. Every later fresh or queued spawn returns that reason and terminates without invoking a model.

### No fallback

Do not fallback for:

- user cancellation or abort;
- max-turn completion;
- task-generated errors;
- test or gate failures;
- worktree/setup failures;
- invalid request/schema/scope;
- unknown failures not classified as provider failures.

## Concurrency

Each spawn snapshots routing selection when it starts. Selection change affects future starts, not in-flight attempts.

When any fallback attempt fails:

- set one shared terminal latch atomically;
- block queued and future starts;
- allow already-running primary/fallback attempts to settle;
- do not abort unrelated in-flight work.

Concurrent primary provider failures may each begin their own same-task fallback before another attempt sets latch. This is intentional: fallback belongs to each logical task, and cancelling already-started work would risk lost edits.

## Resume behavior

Resume continues existing child session with its original model. It does not consult current shared selection or consume a fallback attempt. A resumed provider failure remains attached to that existing session and does not create a replacement session automatically.

## Dispatch coverage

| Surface | Expected behavior |
|---|---|
| Foreground `Agent` | Shared primary, then same-task fallback |
| Background `Agent` | Same policy through settlement promise |
| `SubagentWorkflow` | Each workflow child routed centrally |
| Nested delegation | Nested child routed centrally |
| Scheduled dispatch | Model resolved at execution time |
| Cross-extension RPC | RPC model cannot bypass router |
| Queued dispatch | Re-check terminal latch when queue starts |
| Resume | Existing model retained |

## Upstream synchronization

Add `.github/workflows/sync-upstream.yml` on `shared-routing` with daily schedule and `workflow_dispatch` triggers.

Workflow:

1. Check out `shared-routing` with full history.
2. Add/fetch `upstream` from `tintinweb/pi-subagents`.
3. Push `upstream/master` to `origin/master` using fast-forward-only behavior.
4. Exit after mirror update when `shared-routing` already contains that upstream commit.
5. Merge `upstream/master` into `shared-routing` without force.
6. Run `npm ci`.
7. Run `npm run check`.
8. Run `npm run test:e2e`.
9. Run `npm run build`.
10. Push `shared-routing` only after all checks pass.

Use `contents: write`, workflow concurrency, and no third-party synchronization action. Merge conflict or failed check leaves `shared-routing` unchanged and produces GitHub Actions failure notification. Never force-push either branch.

After remote synchronization, local Pi package updates via:

```bash
pi update --extensions
```

## Migration and rollout

1. Fork already exists with `origin` and `upstream` remotes.
2. Create `shared-routing` from current upstream `master`.
3. Implement router with tests before manager integration.
4. Integrate retry loop at `AgentManager.startAgent`.
5. Wire selector, persistence, migration, UI/status, and docs.
6. Remove global agent model pins.
7. Add upstream synchronization workflow.
8. Run complete verification.
9. User reviews, commits, and pushes; repository rules prohibit agent commits/pushes.
10. Set GitHub fork default branch to `shared-routing` and enable Actions.
11. Replace global npm package entry with unpinned fork git source.
12. Disable/remove standalone `~/.pi/agent/extensions/implementer-model` only after fork verification.
13. Run `/reload` or start a new Pi session.

## Verification

```bash
npm run check
npm run test:e2e
npm run build
```

Also:

- Run focused routing tests during TDD.
- Mutation-check every new assertion by breaking corresponding source behavior, confirming red, then restoring.
- Verify global package list contains only forked `pi-subagents` source.
- Verify main-session model remains unchanged while subagent selection changes.
- Verify error text never asks for re-selection.
- Verify unavailable primary and failed fallback leave `runAgent` uncalled for blocked spawns.
- Verify synchronization workflow with `workflow_dispatch` before relying on schedule.

## Documentation changes during implementation

- `README.md`: commands, model precedence, defaults, behavior, architecture map.
- `docs/workflows.md`: shared routing and rejection of per-agent model overrides.
- `docs/rpc.md`: RPC model behavior and terminal routing errors.
- Agent tool and workflow tool descriptions.

Do not edit `CHANGELOG.md`; contributor rules reserve it for maintainers.

## Risks

- Refactoring `startAgent` must preserve one cleanup, pool release, completion callback, and notification per logical agent.
- Two sessions under one record may affect steering and transcript callbacks; tests must verify active-session replacement and accumulated output.
- Provider failure classification must stay narrow so code/task failures never consume fallback.
- Upstream spawn-path changes may conflict with fork; synchronization stops before push when checks fail.
