# Next Session Handover: Shared Subagent Model Routing

**Date:** 2026-09-14  
**Phase:** Approved design; implementation not started

## Objective

Apply one fail-closed, session-wide model route to every fresh subagent spawned by `@tintinweb/pi-subagents`, while keeping Pi's main-session model independent.

Approved design:

- [`../specs/2026-09-14-shared-subagent-model-routing-design.md`](../specs/2026-09-14-shared-subagent-model-routing-design.md)

Read that document first. Do not repeat brainstorming unless new evidence invalidates the approved architecture.

## Repository state

Fork created under user's authenticated GitHub account:

```text
Remote fork: https://github.com/kerfern/pi-subagents
Local clone: /Users/kerf/Projects/pi-subagents
Origin:       https://github.com/kerfern/pi-subagents.git
Upstream:     https://github.com/tintinweb/pi-subagents.git
```

Upstream and fork default branch currently use `master`. Current cloned commit when forked:

```text
e955e29c51b7a6cce37e1108cd2d6c57a77e151c
fix: stand down for lowercase `workflow` tools (#283)
```

No routing implementation, custom branch, package-source switch, commit, or push has been made. Design and handover docs are unstaged working-tree additions.

Repository `AGENTS.md` rules:

- Agent must never commit or push.
- User commits and pushes manually.
- Full verification after code changes: `npm run check`.
- Also run `npm run test:e2e` and `npm run build` for this spawn-path change.
- Do not edit `CHANGELOG.md`.
- Read affected user docs before changing behavior.

## Existing implementation to migrate

Current implementer-only router lives outside fork:

```text
/Users/kerf/.pi/agent/extensions/implementer-model/core.ts
/Users/kerf/.pi/agent/extensions/implementer-model/index.ts
/Users/kerf/.pi/agent/extensions/implementer-model/core.test.ts
/Users/kerf/.pi/agent/extensions/implementer-model/wiring.test.ts
```

It already contains:

- default and fallback constants;
- live-catalog validation;
- provider-failure classification;
- `routingFailed` and `terminalReason` state;
- terminal blocking without re-selection prompts;
- session persistence and selector behavior.

Prior verification before architectural expansion:

```text
strict TypeScript: exit 0
existing extension tests: 48 passed, 0 failed
```

Do not delete/disable this extension until fork behavior passes and package migration is verified.

Global agent definitions currently requiring pin removal after central routing works:

```text
/Users/kerf/.pi/agent/agents/explore.md
/Users/kerf/.pi/agent/agents/reviewer.md
/Users/kerf/.pi/agent/agents/worker.md
```

`implementer.md` is already intentionally unpinned.

## Confirmed dispatch boundary

Direct `Agent` tool hooks do not see workflow child calls. Fresh child dispatches converge on:

```text
src/agent-manager.ts
  AgentManager.startAgent
```

Known callers/surfaces:

- direct foreground/background `Agent` from `src/index.ts`;
- workflow children from `src/workflow/host.ts`;
- nested tools;
- scheduler;
- cross-extension RPC.

Current `startAgent` calls `runAgent(...)` once, then performs status, transcript, worktree cleanup, child abort, pool release, completion callback, and queue drain. Same-task fallback requires an attempt loop before this one-time settlement tail.

## Locked decisions

- Shared route across every role and fresh dispatch path.
- Main-session model remains separate.
- No per-project model control.
- Default:
  `commandcode/deepseek/deepseek-v4.1-flash`
- One fallback:
  `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`
- Provider failure retries same logical task once.
- Retry preserves prompt, type, tools, options, and worktree.
- Missing selected/default model is terminal before execution; it does not fallback.
- Missing/failed fallback sets shared terminal latch.
- Task/test/gate/cancel/scope failures do not fallback.
- No random model or parent-model inheritance.
- Failure path never asks for model re-selection.
- `/subagent-model` becomes canonical command.
- `/implementer-model` remains compatibility alias.
- Conflicting per-call model override is rejected, not silently ignored.
- Resumes retain original child-session model.
- Already-running agents continue after latch; queued/new agents block.

If implementation needs subagents, user requested:

```text
commandcode/deepseek/deepseek-v4.1-flash
```

## Fork synchronization requirement

Approved branch model:

- `master` mirrors `upstream/master`.
- `shared-routing` carries custom changes.
- `shared-routing` becomes fork default branch.

Add daily/manual `.github/workflows/sync-upstream.yml` on `shared-routing`:

1. Fetch upstream.
2. Fast-forward fork `master` from `upstream/master`.
3. Merge upstream into `shared-routing` without force.
4. Run `npm ci`, `npm run check`, `npm run test:e2e`, and `npm run build`.
5. Push custom branch only if merge and checks pass.
6. Conflict/check failure leaves branch unchanged and reports failed Action.

Use an unpinned git package source after remote branch exists:

```text
git:github.com/kerfern/pi-subagents
```

Reason: Pi docs state explicit git refs are pinned. Set fork default branch to `shared-routing` instead of installing `@shared-routing`, allowing `pi update --extensions` to follow successful syncs.

## Required next-session sequence

1. Check working tree and read approved spec plus repo `AGENTS.md`.
2. Present written spec for user review; incorporate corrections.
3. Invoke Superpowers `writing-plans` skill and create detailed implementation plan.
4. Self-review plan before implementation.
5. Create approved `shared-routing` branch; do not commit or push.
6. Use TDD: write failing router tests first.
7. Port minimal reusable logic from standalone extension into fork.
8. Integrate central attempt loop at `AgentManager.startAgent`.
9. Add coverage for each dispatch surface, concurrency, resume, and cleanup invariants.
10. Update README, workflow docs, RPC docs, and tool descriptions.
11. Add sync workflow.
12. Run focused tests, mutation checks, then full verification.
13. Have user review diff and commit/push manually.
14. Set GitHub default branch, enable/test workflow, migrate global package source.
15. Only then disable old implementer-only extension and remove model pins.
16. Run `/reload` or start new Pi session; verify main/subagent model independence.

## High-risk invariants

Do not regress:

- exactly one pool release per logical child;
- exactly one worktree cleanup per logical child;
- exactly one final completion notification;
- one stable public agent ID across attempts;
- steering targets current attempt session;
- usage accumulates across both attempts;
- output/transcript behavior remains coherent across retry;
- queued agents re-check terminal latch at actual start;
- fallback classifier remains narrow.

## Documentation status

Created this session, unstaged:

```text
docs/superpowers/specs/2026-09-14-shared-subagent-model-routing-design.md
docs/superpowers/handovers/2026-09-14-shared-subagent-model-routing-next-session.md
```

No implementation plan exists yet. Create it only after written-spec review using `writing-plans`.
