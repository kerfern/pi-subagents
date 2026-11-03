# Cache-Aware Orchestration Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an opt-in, measurable orchestration pilot in `pi-subagents` that routes planning/advice/review to Sol, ordinary subagents to Luna, persists bounded workflow state, and compares routine/complex execution without claiming unmeasured cache or subscription savings.

**Architecture:** Reuse existing session-scoped model routing, the built-in `Plan` agent, `SubagentWorkflow`, its deterministic gates/journal, and per-message `LifetimeUsage`. Route the existing `Plan` role and one new read-only `advisor` role through the Sol/reviewer route; keep ordinary roles on the user-requested GitHub Copilot Luna route. Add only fixed-name workflow artifact APIs under the opened project’s `.pi/workflow/<taskId>/`; never expose general filesystem access to workflow scripts. Main-session model/effort stays manually selected unless the installed Pi API proves safe programmatic switching.

**Tech Stack:** TypeScript 6 / ES2022, Node.js, Pi SDK peer API verified against installed version, Vitest 4, Biome 2. No new dependency or overlapping orchestration extension.

**Spec:** `/Users/kerf/.pi/agent/docs/pi-cache-aware-orchestration-handover.md`

## Global Constraints

- Preserve working authentication/account routing; do not install a second overlapping orchestration/account-routing extension.
- Resolve `SOL`, `LUNA`, and optional `FLASH` to exact configured provider/model IDs. Fail explicitly if unresolved; never silently inherit the expensive parent or substitute a weaker model into a safety-critical role.
- Use the installed extension’s actual schema and verify effective model/thinking; do not infer model availability from subscription names.
- User override wins except at safety and permission boundaries. Keep routine/complex selection opt-in; do not silently switch the parent model.
- Keep current fallback behavior unless verified evidence and explicit approval justify changing it. Provider fallback is not a task-repair attempt.
- Do not make `xhigh` universal or impose a universal three-call limit. Verify supported effort enums; `off`, `none`, `low`, `high`, `xhigh`, and `max` are not interchangeable.
- Record unknown usage/allowance values as `null`, not zero. Pi/API-priced cost is not proof of Codex/Copilot subscription charges.
- Never persist prompts, patient data, secrets, auth tokens, or full transcripts in telemetry. Never print credentials.
- Reviewer/planner/advisor/scout must not have edit tools. `bash`/`exec` is not read-only; remove it or independently constrain it. Prompts alone are not sandboxing.
- No commit, push, tag, deploy, external-record change, destructive operation, or dependency install. Preserve rollback configuration.
- Workflow artifacts and telemetry are opt-in and project-local. Never claim cache preservation or permission isolation without evidence.

## Review Focus

1. **Unavailable or scoped-out model:** spawn fails before taking a slot/worktree; it never falls back to parent inheritance. Test with a catalog missing the configured primary and fallback.
2. **Role/model/thinking mismatch or provider clamp:** route is explicit; actual effective model/thinking is recorded, or marked unknown. Test `Plan`, `advisor`, `reviewer`, `worker`, and `Explore` separately.
3. **Malformed state, partial JSONL, traversal, or symlink:** writes stay inside `.pi/workflow/<taskId>`; a bad final line does not corrupt earlier usage; path escape is rejected. Test invalid IDs, names, and symlinked parents.
4. **Security/clinical/patient-data risk, changed invariant, or scope drift:** routine shortcut cannot waive Sol consultation/review. Test escalation and confirm no write-capable tool reaches read-only roles.
5. **Provider failure versus task/gate/schema/cancel failure:** only a recognized provider failure gets the existing single fallback; repair stops after two attempts and invokes advisor. Test both failure classes and exact attempt counts.

---

## Scope and Decisions

- The extension already has a built-in `Plan` agent (`src/default-agents.ts::DEFAULT_AGENTS`). Do not add a duplicate `planner` agent. Its current profile requests Haiku and its route code treats only exact type `reviewer` as specialist, so it currently receives the shared route. The pilot must route `Plan` to Sol/high and align its profile fallback with the verified Sol ID.
- There is no built-in `advisor`; add an example custom `advisor` profile and install it in the user-global agent directory only after review.
- The user’s baseline remains reviewer = `openai-codex/gpt-6.1-sol` / high and ordinary subagents = `github-copilot/gpt-6-luna` / low. `Plan` and `advisor` are explicit pilot exceptions routed through the reviewer/Sol route; do not change ordinary-agent defaults.
- Existing saved `subagent-model-state` entries are explicit choices and must remain intact. Changing a default constant affects empty/new state only; the operator must verify/reselect the persisted route with `/subagent-model` after runtime catalog checks.
- The handover’s three modes are evaluation presets, not automatic parent-model switching. Routine means parent Luna/medium; complex means parent Sol/high. Parent selection remains manual unless the installed Pi API offers a verified, cache-aware switch.
- Do not add Flash, dynamic `xhigh`, arbitrary role-to-model maps, or automatic mode promotion in first pilot. Add only if measured results require them.

## File Structure

| File | Responsibility |
|---|---|
| `src/model-routing.ts` | Set verified fresh shared default to GitHub Copilot Luna; route `Plan` and `advisor` through existing reviewer/Sol route; report the actual failed primary model on latch. |
| `src/agent-manager.ts`, `src/types.ts` | Preserve effective route, actual thinking when exposed, and attempt count for telemetry; keep existing single settlement and fallback behavior. |
| `src/default-agents.ts` | Set built-in Plan fallback to verified Sol/high; remove shell access from the built-in read-only tool set; prevent Plan/Explore from inheriting write-capable extension tools unless a verified allowlist is available. |
| `src/workflow/artifacts.ts` (new) | Fixed-name, project-scoped plan/state/review/usage storage with path checks and atomic text/state writes. |
| `src/workflow/host.ts`, `src/workflow/worker-source.ts`, `src/workflow/tool-description.ts` | Expose only the scoped artifact API to workflow scripts and describe its limits. |
| `examples/agents/advisor.md` (new) | Example read-only advisor profile; no model pin that conflicts with the session route. |
| `examples/workflows/cache-aware-orchestration.js` (new) | Opt-in routine/complex orchestration with planning, trigger-based advice, gates, bounded repair, and review. |
| `test/model-routing.test.ts`, `test/subagent-model-routing.test.ts` | Pin default provider, specialist-role mapping, explicit route precedence, fallback/latch details. |
| `test/default-agents.test.ts` (new), `test/custom-agents.test.ts` | Verify read-only tool/extension scope and advisor profile parsing. |
| `test/workflow-artifacts.test.ts` (new), `test/workflow-examples.test.ts` | Verify safe persistence, recovery, workflow branch behavior, and gates. |
| `test/orchestration-telemetry.test.ts` (new), `test/usage-reporting.test.ts` | Verify per-message accounting, route metadata, no nested double-counting, unknown-cost handling. |
| `src/index.ts`, `README.md`, `docs/workflows.md`, `test/agent-tool-description.md`, `examples/agent-tool-description.md` | Update embedded instructions, user-facing defaults, workflow artifact limits, and tests. Do not change `docs/rpc.md` unless an RPC surface is actually added. |
| `/Users/kerf/.pi/agent/agents/advisor.md`, `/Users/kerf/.pi/agent/agents/reviewer.md`, `/Users/kerf/.pi/agent/agents/explore.md`, `/Users/kerf/.pi/agent/AGENTS.md` | Install the personal pilot advisor and remove unsafe shell inheritance from read-only roles; document explicit Plan/advisor pilot exception. These are user-global config, not package defaults. |

## Task 1: Verify Runtime, Catalog, and Baseline

**Files:** Read-only: `package.json`, `src/model-routing.ts`, `src/agent-manager.ts`, `src/default-agents.ts`, `src/workflow/{host,worker-source,journal}.ts`, `src/usage.ts`, current Pi config and user-global profiles.

- [ ] Record `pi --version`, `node -p 'require("./package.json").version'` and `npm ls --depth=0 @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui`, and current `npm run check` result. Do not dump environment variables or credential files.
- [ ] In the actual Pi model picker/catalog, verify exact IDs `openai-codex/gpt-6.1-sol` and `github-copilot/gpt-6-luna`, plus the configured fallback model. Verify `high` for Sol and `low` for Luna using a disposable child session; inspect its session header/effective thinking instead of trusting the request value.
- [ ] Confirm current selection persistence: an existing explicit shared model survives `restoreRoutingState`; determine whether `/subagent-model` is available in the active UI and record exact four selections needed for reviewer/shared routes.
- [ ] Verify `Plan` tool list and extension scope, model/thinking resolution order, workflow `agent()`/`gate`/`resume` semantics, per-session journal limitations, and that usage callbacks include cache reads/writes without prompt text.
- [ ] Check whether parent-model switching is exposed by the installed Pi API. If not, keep mode selection manual as specified above.
- [ ] Stop and revise this plan before code if either requested model/fallback is unavailable, effective effort differs from requested effort, or read-only tool boundaries cannot be enforced. Never choose a substitute silently.

Run: `npm run check`
Expected: existing branch passes before edits; any baseline failure is recorded and blocks implementation until disposition.

## Task 2: Add Specialist Role Routing and Correct Route Evidence

**Files:** Modify `src/model-routing.ts`, `src/agent-manager.ts`, `test/model-routing.test.ts`, `test/subagent-model-routing.test.ts`, `src/index.ts`, README/tool-description fixtures.

**Interfaces:** `modelForSubagent(state, type)` and `thinkingForSubagent(state, type)` remain the single route-classification points. Types `reviewer`, `Plan`, and `advisor` use `reviewerEffective` / `reviewerEffectiveThinking`; every other type uses `effective` / `effectiveThinking`.

- [ ] Add failing pure tests first:

```ts
expect(modelForSubagent(state, "Plan")).toBe(state.reviewerEffective);
expect(modelForSubagent(state, "advisor")).toBe(state.reviewerEffective);
expect(modelForSubagent(state, "reviewer")).toBe(state.reviewerEffective);
expect(modelForSubagent(state, "worker")).toBe(state.effective);
expect(thinkingForSubagent(state, "advisor")).toBe(state.reviewerEffectiveThinking);
expect(thinkingForSubagent(state, "worker")).toBe(state.effectiveThinking);
```

- [ ] Change `DEFAULT_SUBAGENT_MODEL` to `github-copilot/gpt-6-luna` only after Task 1 confirms it is served. Keep `DEFAULT_REVIEWER_MODEL`, thinking defaults, and fallback unchanged. Add a test for empty-state defaults with the exact provider IDs.
- [ ] Update `modelForSubagent`/`thinkingForSubagent` with the three specialist types; leave all unknown/custom types on the shared route. Do not add another persisted route bucket or silently rewrite saved selections.
- [ ] Add manager-level tests proving `Plan` and `advisor` start on reviewer/Sol while `worker` and `Explore` start on shared/Luna. Verify a conflicting explicit model/thinking is still refused before the runner starts.
- [ ] Fix fallback failure evidence to include the actual primary route model, not always `state.effective`. Add reviewer/Sol and shared/Luna tests; keep exactly one provider fallback attempt and existing latch semantics.
- [ ] Update `/subagent-model` picker labels, the generated Agent-tool routing text, README defaults, and tool-description fixtures; make clear that the existing reviewer route covers reviewer/Plan/advisor, while ordinary agents remain on shared route. Keep session-state field names and the four-choice picker structure unchanged.

Run: `npx vitest run test/model-routing.test.ts test/subagent-model-routing.test.ts test/subagent-model-command.wiring.test.ts`
Expected: new tests fail before changes, pass after changes; no changes to persisted selection format or fallback policy.

## Task 3: Enforce Read-Only Role Boundaries and Add Advisor Profile

**Files:** Modify `src/default-agents.ts`; create `test/default-agents.test.ts` and `examples/agents/advisor.md`; update `test/custom-agents.test.ts` and the user-global profiles listed above.

- [ ] Add failing tests asserting built-in `Plan` and `Explore` do not receive `bash`, `write`, or `edit`; set extension inheritance to `false` for these read-only built-ins unless Task 1 proves a narrower read-only extension allowlist exists.
- [ ] Remove `bash` from `READ_ONLY_TOOLS`; retain only verified read-only built-ins (`read`, `grep`, `find`, `ls`). Set the built-in `Plan` fallback `model` to the verified exact Sol ID, `thinking` to `high`, and `persistSession: true`; create a fresh Plan session per task and resume it only within that task. Do not describe `bash`/`exec` as read-only.
- [ ] Create `examples/agents/advisor.md` with `name: advisor`, a bounded evidence-based advice description, `tools: read,grep,find,ls`, `extensions: false`, `skills: true`, `persist_session: true`, and no model/thinking pin. Advisor must answer a named decision, cite evidence, and make no edits.
- [ ] Test the example through `parseAgentFrontmatter` and the actual config resolver. Assert effective tools exclude shell/edit tools, advisor has no model pin, and built-in `Plan` resolves to the verified Sol/high route and fallback profile.
- [ ] Install the approved profile at `/Users/kerf/.pi/agent/agents/advisor.md`; remove `bash` from the user-global reviewer and Explore tool lists. If Pi still injects shell or write-capable extension tools, stop and report the permission gap rather than claiming read-only isolation.
- [ ] Update user-global `AGENTS.md` narrowly: reviewer/Plan/advisor use Sol/high; ordinary agents use GitHub Copilot Luna/low; main model remains separate. Preserve all unrelated instructions.

Run: `npx vitest run test/default-agents.test.ts test/custom-agents.test.ts`
Expected: read-only role assertions pass; advisor is loadable as a user custom agent and has no silent model pin.

## Task 4: Add Fixed-Scope Workflow Artifacts

**Files:** Create `src/workflow/artifacts.ts`, `test/workflow-artifacts.test.ts`; modify `src/workflow/host.ts`, `src/workflow/worker-source.ts`, `src/workflow/tool-description.ts`, `docs/workflows.md`.

**Interface:**

```ts
type WorkflowTextArtifact = "plan.md" | "state.json" | "review.md";
interface WorkflowArtifacts {
  read(name: WorkflowTextArtifact): Promise<string | undefined>;
  write(name: WorkflowTextArtifact, content: string): Promise<void>;
  appendUsage(record: Omit<WorkflowUsageRecord, "timestamp">): Promise<void>;
  readUsage(): Promise<{ records: WorkflowUsageRecord[]; malformedLines: number }>;
}
```

`createWorkflowArtifacts(cwd, taskId)` stores only under `<cwd>/.pi/workflow/<taskId>/`; the worker exposes an async RPC object bound to top-level `args.taskId` and never accepts arbitrary paths. `usage.jsonl` is append-only and not readable through the generic text API.

- [ ] Add failing tests for the fixed filenames, JSONL append/read, a partial final line with earlier rows preserved and `malformedLines` reported, missing files, path traversal, invalid task IDs, symlinked `.pi`/`workflow`/task directories, and preservation of prior files after a failed atomic replacement.
- [ ] Implement `createWorkflowArtifacts(cwd, taskId)` using existing Node filesystem APIs only in the extension host. Validate `taskId` against `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; allow only the three fixed text names; reject separators and `..`; canonicalize/check the root; reject symlinked path components; write text/state through temp-file-plus-rename; append each validated usage record as one JSONL line.
- [ ] Expose only the fixed `artifacts` object to workflow scripts from `createWorkflowHost`/`WORKER_SOURCE`. Do not inject `fs`, `path`, arbitrary file paths, network, or module access.
- [ ] Define this `WorkflowUsageRecord` allowlist in `src/workflow/artifacts.ts`; create `timestamp` in the host, not inside the deterministic script. Reject extra prompt/output/tool-content fields.

```ts
import type { EffectiveThinkingLevel, ThinkingLevel } from "../types.js";

interface WorkflowUsageRecord {
  event: "usage" | "complete";
  timestamp: string;
  taskId: string;
  workflowId: string;
  agentId: string;
  role: string;
  provider: string | null;
  model: string | null;
  requestedThinking: ThinkingLevel | null;
  effectiveThinking: EffectiveThinkingLevel | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costUsd: number | null;
  attempt: number;
  status: string | null;
  durationMs: number | null;
}
```

For `event: "usage"`, token fields are finite non-negative numbers or `null` when unknown; `costUsd` is finite or `null`; status/duration are `null`. For `event: "complete"`, usage/cost fields are `null` and status/duration are populated. Timestamps are ISO-8601 host timestamps.

`state.json` is validated against this workflow contract before every update; a parse/schema failure stops the stage without overwriting the file:

```ts
interface WorkflowState {
  taskId: string;
  mode: "routine" | "complex";
  stage: "plan" | "advisor" | "worker" | "review";
  originalRequestRef: string | null;
  planVersion: number;
  agents: Array<{
    role: string;
    agentId: string;
    sessionId: string | null;
    provider: string | null;
    model: string | null;
    requestedThinking: ThinkingLevel | null;
    effectiveThinking: EffectiveThinkingLevel | null;
    attempts: number;
  }>;
  repairAttempts: number;
  checks: Array<{ command: string; outcome: "passed" | "failed" | "unavailable"; exitCode: number | null }>;
  blockers: string[];
  reviewStatus: "pending" | "pass" | "fail" | "unverified";
}
```

- [ ] Document that the existing resume journal remains per-session/temp and that the new `.pi/workflow` artifacts are separate durable records. Partial final JSONL rows are ignored on read; a malformed `state.json` stops an update rather than being overwritten blindly.

Run: `npx vitest run test/workflow-artifacts.test.ts`
Expected: all path, symlink, atomic-write, and append tests pass; existing workflow sandbox still has no arbitrary filesystem/network/module access.

## Task 5: Capture Per-Message Usage and Effective Route

**Files:** Modify `src/types.ts`, `src/usage.ts`, `src/agent-manager.ts`, `src/agent-runner.ts`, `src/index.ts`, `src/workflow/artifacts.ts`, `src/workflow/host.ts`, and `src/workflow/runtime.ts`; create `src/workflow/telemetry.ts`, `test/orchestration-telemetry.test.ts`, and `test/e2e/orchestration-telemetry.e2e.test.ts`; extend `test/agent-manager.test.ts` and `test/workflow-artifacts.test.ts`.

- [x] Add failing tests: manager proves workflow ownership propagates to nested descendants and preserves raw per-message usage separately from normalized lifetime totals; a real faux-model workflow child emits multiple assistant messages and telemetry records each delta once.
- [x] Add per-run `AgentRecord` fields for selected model ID, requested thinking, actual effective thinking when available, and provider-attempt count. Populate them at routing/session boundaries; use `null` where no actual value is observable.
- [x] Preserve `OnAgentUsage`'s normalized accumulator for existing reporting while exposing the observed message delta separately. Associate telemetry through `record.workflowId`; register workflow artifacts by workflow ID backed by the stable task directory; serialize writes in event order and unregister/drain on stage settlement. Propagate workflow ownership through nested `AgentManager.spawn`; emit only workflow-owned rows.
- [x] Record one usage-free completion row with actual outcome and elapsed time. Gate outcomes are persisted in `state.json` by Task 6, not duplicated into usage rows.
- [x] Map unavailable fields and unpriced cost to `null`; do not infer subscription spend from API prices. Persist allowlisted metadata only—never prompts, answers, diffs, or patient data.
- [x] Read actual model/effective-thinking fields from Pi session evidence. Preserve `"off"` as an `EffectiveThinkingLevel` for requested telemetry rather than coercing it to a standard `ThinkingLevel`; absent session evidence remains `null`.

Run: `npx vitest run test/agent-manager.test.ts test/orchestration-telemetry.test.ts test/e2e/orchestration-telemetry.e2e.test.ts test/workflow-artifacts.test.ts test/usage-reporting.test.ts test/e2e/usage-reaches-session-stats.e2e.test.ts`
Expected: message deltas and nested ownership are each recorded once; actual route is captured or null; unpriced cost remains null; no prompt content appears in artifacts.

## Task 6: Add the Opt-In Routine/Complex Workflow

**Files:** Create `examples/workflows/cache-aware-orchestration.js`; modify `test/workflow-examples.test.ts`, `test/e2e/cache-aware-orchestration.e2e.test.ts`, `docs/workflows.md`, `README.md`, and `src/workflow/tool-description.ts`.

- [x] Add a faux-model test first. Workflow input requires a safe `args.taskId`, `args.mode` exactly `routine` or `complex`, and `args.stage` exactly `plan`, `advisor`, `worker`, or `review`; missing/unknown values fail before spawning agents. Reuse the same `taskId` across stage calls. `args.trivial === true` on `plan` returns without spawning agents; the parent handles the task directly.
- [x] Implement a deterministic workflow using existing `agent()`, `gate`, `schema`, and `resume` APIs. Do not import modules or access arbitrary files from the script. Persist plan/state/review/usage only through the scoped `artifacts` API.
- [x] Make each `args.stage` a bounded invocation: `plan` calls built-in `Plan`; `advisor` is trigger-only; `worker` requires an approved `plan.md`; `review` requires `args.reviewContext` containing a non-sensitive `revisionId` for exact code revision, original request, approved plan, actual diff, validation results, and unresolved issues. A new `plan` stage refuses an existing task directory; later stages require valid existing state. Missing review evidence marks status unverified and cannot return pass.
- [x] Use the existing `schema` option with these required structured payloads; reject missing fields before writing artifacts:

```ts
interface PlanOutput {
  objective: string;
  invariants: string[];
  files: string[];
  steps: Array<{ id: string; task: string; dependsOn: string[]; verify: string }>;
  acceptance: string[];
  assumptions: string[];
}
interface AdvisorOutput {
  question: string;
  evidence: string[];
  recommendation: string;
  risks: string[];
  escalate: boolean;
}
interface ReviewOutput {
  requirements: Array<{ item: string; status: "pass" | "fail" | "unverified"; evidence: string[] }>;
  blockers: string[];
  residualRisks: string[];
}
```
- [x] The parent supplies the actual diff in `reviewContext`; never give reviewer `bash` to obtain it. Keep stable role instructions before task-specific evidence, and append updates rather than rewriting early prompt context.
- [x] Routine mode assumes parent Luna/medium is selected manually. Skip all subagents for tiny, specified, low-risk changes. For non-trivial work call built-in `Plan` first, use a bounded Luna worker only when implementation can be isolated, run the stated check gate, consult persistent `advisor` only on explicit triggers, then request Sol review.
- [x] Complex mode assumes parent Sol/high is selected manually. Use Luna workers only for bounded/disjoint packets; keep global technical decisions with parent; call reviewer after required checks. Do not emulate parent-model switching inside the workflow.
- [x] Encode advisor triggers: scope/invariant/interface/schema/security change, conflicting evidence, unresolved blocking assumption, or two failed repair attempts for the same underlying failure. The two-attempt repair budget is separate from provider failover. On the third failure, stop the repair loop and wait for advisor direction. If advice is repeatedly needed or invalidates bounded scope, checkpoint artifacts and have the user move execution to a Sol/high parent; do not imply a model switch transfers cache.
- [x] Persist `plan.md` before implementation; update `state.json` at plan approval, each implementation/check boundary, blocker, and final status; persist each actual `gate` outcome in its `checks` list; write `review.md` with pass/fail by original requirement and evidence. `usage.jsonl` contains only allowlisted usage/completion telemetry.
- [x] If the workflow resumes a child, make the resume label explicit and persist the child handle in state. Document that workflows using `agent({ resume })` are not replayed from the same-session workflow journal and that workflow journals do not survive Pi restarts. Measure actual cacheRead/cacheWrite; do not promise a cache hit.
- [x] Test routine skip, Plan→worker→gate→review across separate stage calls using the same `taskId`, complex bounded worker flow, advisor trigger, exactly-two repair failures, provider failure not counted as repair, missing review context remains unverified, and artifact updates after each stage. Reviewer input must include the original request, approved plan, actual diff, validation commands/results, and unresolved issues; meaningful review fixes rerun affected checks, unchanged work is not re-reviewed indefinitely.

Run: `npx vitest run test/workflow-examples.test.ts`
Expected: faux-model paths pass deterministically; unknown modes and failed gates cannot fall through to a success result.

## Task 7: Pilot, Compare, and Roll Back Safely

**Files:** `docs/superpowers/plans/2026-10-03-cache-aware-orchestration.md`, local task snapshots/worktrees, each pilot task’s `.pi/workflow/<taskId>/` artifacts. Do not add real user task text or sensitive data to checked-in fixtures.

- [ ] Before runs, record the effective baseline models/efforts and current auth/account routing without credentials. Set `/subagent-model` to the verified reviewer/shared routes; preserve old session selections and a text-only rollback checklist.
- [ ] Prepare 20–30 representative, non-sensitive tasks across routine edits, API changes, debugging, coupled refactors, and ambiguous/high-risk work. Define acceptance before execution; repeat runs where practical; use identical repository snapshots and isolated worktrees.
- [ ] Compare the handover presets: A = existing Sol xhigh main + Sol high review + Luna children; B = Sol high main with selective higher effort + bounded Luna children; C = Luna medium main + persistent Sol Plan/advisor + Sol review. If actual baseline differs, record it and compare against that actual baseline rather than silently treating A as current.
- [ ] For every run include all children, fallback attempts, repairs, gates, reviewer corrections, and human correction time. Report accepted-task rate, missed requirements/regressions, total tokens and cache reads/writes, Pi-reported model cost, observable subscription allowance delta (otherwise `null`), median/tail latency, and advisor frequency.
- [ ] Promote C only per task class when accepted-task count is at least baseline, no critical/security/clinical regression or new major missed requirement appears, human correction time does not rise, and median whole-run time or verified allowance per accepted task falls. If subscription allowance is not observable, report token/cache/latency evidence without calling it subscription savings. If results are mixed or unclear, keep C opt-in. A 20–30 task pilot is directional, not statistical assurance.
- [ ] Verify rollback by restoring prior subagent routing selection and profile files; do not touch auth, account, external records, or credentials.

Run after code changes: `npm run check`, `npm run test:e2e`, `npm run build`, and focused suites listed in Tasks 2–6.
Expected: all required checks pass without warnings; the evaluation report distinguishes measured facts, proxies, unknowns, and unsupported features. No automatic global rollout occurs.

## Execution Handoff

Implementation starts only after this plan is reviewed and approved. Recommended execution: **subagent-driven, serial task ownership with one final reviewer**. Role routing, artifact boundaries, and telemetry share interfaces, and a filesystem-scope mistake or double-counted usage could invalidate pilot results; serial implementation avoids overlapping writes while independent review checks the safety boundary. No commit is authorized.

## Spec Coverage Self-Check

- Objective and constraints → Tasks 1, 2, and 7.
- Routine/complex routes and role presets → Tasks 2, 3, and 6.
- Delegate-only-when-worthwhile and Sol escalation → Task 6.
- Durable `plan.md`, `state.json`, `review.md`, `usage.jsonl` → Tasks 4–6.
- Enforced gates and two-repair stop → Task 6.
- Cache-aware session/resume caveats → Tasks 1, 6, and 7.
- Usage, cost, latency, and allowance telemetry → Task 5 and Task 7.
- Permission boundaries, rollback, and unsupported capabilities → Tasks 1, 3, 4, and 7.
- No product behavior is implemented by this plan document.

## Plan Self-Review

- Exact model IDs are gated on live catalog verification; there is no silent provider substitution.
- `Plan` is reused rather than duplicated; `advisor` is the only new role profile.
- The artifact API exposes four fixed files only and does not grant general filesystem access.
- `WorkflowUsageRecord` has one definition and is shared by the host writer and telemetry tests.
- `/subagent-model` remains authoritative for fresh children; the plan does not claim the user-global AGENTS edit changed live session state.
- Test commands match `package.json` scripts and existing focused suites; new suite names are defined in the file structure.
- No API prices are treated as subscription allowance, and no cache-preservation claim is assumed.
- No commit/push/deploy step is included.

## No-Placeholder Check

Every code task names concrete files, interfaces, tests, commands, and expected results. Runtime-dependent values have explicit verification gates and fail/stop behavior.

## Execution Choice and Ledger

**Execution choice:** native, serial implementation with TDD and one final reviewer. Work in existing `shared-routing` checkout; do not create a worktree or commit. Plan tasks share interfaces, existing local changes must be preserved, and implementation/commit ownership stays in the parent.

- Ruling: cached catalogs/config contain requested Sol, GitHub Copilot Luna, and OpenRouter fallback IDs; disposable reviewer child reported `openai-codex/gpt-6.1-sol` at `high`. Shared-route child could not expose effective route metadata, so do not claim live Luna auth/effective effort verification.
- Ruling: auth-file inspection was blocked by the security boundary; do not retry by another path/tool. Continue code changes from cached catalog/config only; leave live provider/auth and `/subagent-model` picker validation as explicit rollout checks.
- Ruling: preserve pre-existing dirty files, including package dependency edits; no broad reset, install, commit, or push.

## Checklist

- [x] Task 1: Verify runtime, catalog, and baseline
- [x] Task 2: Add specialist role routing and correct route evidence
- [x] Task 3: Enforce read-only role boundaries and add advisor profile
- [x] Task 4: Add fixed-scope workflow artifacts
- [x] Task 5: Capture per-message usage and effective route
- [x] Task 6: Add opt-in routine/complex workflow
- [ ] Task 7: Pilot, compare, and roll back safely
- [x] Final reviewer confirms implementation matches original handover
- [x] All verification commands pass; no commit made

---

### Critical Files for Implementation

- `/Users/kerf/Projects/pi-subagents/src/model-routing.ts` — route defaults, role classification, and failure evidence.
- `/Users/kerf/Projects/pi-subagents/src/agent-manager.ts` — route resolution, attempt count, and usage attribution.
- `/Users/kerf/Projects/pi-subagents/src/workflow/artifacts.ts` — scoped durable artifact boundary.
- `/Users/kerf/Projects/pi-subagents/src/workflow/host.ts` — host-owned artifact access exposed to the deterministic workflow.
- `/Users/kerf/Projects/pi-subagents/examples/workflows/cache-aware-orchestration.js` — opt-in routine/complex workflow and gates.

**Residual risks:** Exact provider availability and effective effort depend on the live Pi catalog/auth; workflow journals remain session-local; subscription allowance may not be observable; shell allowlisting depends on the installed Pi tool boundary.