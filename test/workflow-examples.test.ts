/**
 * workflow-examples.test.ts — the shipped example workflows, actually run.
 *
 * `docs/workflows.md` links every file in `examples/workflows/` as a recipe, so
 * a broken one is documentation that lies. Nothing else guards them: `biome.json`
 * scopes linting to `src/**` and `test/**`, and `tsconfig.json` compiles only
 * `src/**`, so these files are neither linted nor typechecked. This suite is it.
 *
 * Three tiers, cheapest first:
 *
 *   1. Structural, glob-driven — every `.js` under the directory really is a
 *      workflow. Glob-driven so a newly added example is covered without anyone
 *      remembering to edit this file.
 *   2. Execution — every example runs to completion against a stub host. This is
 *      the tier that earns its keep: it catches determinism violations, unknown
 *      `agent()` option keys (rejected by name at the call), cap violations,
 *      schema payloads the runtime rejects, and typos in the globals.
 *
 *      It does NOT catch a dropped `await`. The un-awaited-launch check fires on
 *      launches still outstanding when the script ends, and this stub answers
 *      instantly, so an orphaned agent has always settled by then. That check is
 *      covered against a controllable host in `test/workflow-borrowed.test.ts`
 *      ("unawaited launches"); it is not this suite's job.
 *   3. Value — the examples with a stable return shape get an explicit
 *      assertion, including `agentCount`, so a change to an example's fan-out
 *      has to be acknowledged rather than sliding through.
 *
 * The stub returns arbitrary text, so nothing here asserts on prose.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMeta, hasMetaDeclaration, WorkflowMetaError } from "../src/workflow/meta.js";
import { runWorkflow, type WorkflowHost, type WorkflowSpawnRequest } from "../src/workflow/runtime.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../examples/workflows", import.meta.url));
const LIB_DIR = join(EXAMPLES_DIR, "lib");

/** Top-level examples — `lib/` holds nested children, run through their parents. */
const exampleFiles = readdirSync(EXAMPLES_DIR)
  .filter(name => name.endsWith(".js"))
  .sort();

const childFiles = readdirSync(LIB_DIR)
  .filter(name => name.endsWith(".js"))
  .sort();

const readExample = (dir: string, name: string) => readFileSync(join(dir, name), "utf-8");

/**
 * Args for examples that need them. An example not listed here runs with
 * `args: undefined`, which every one of them must tolerate — that is the point
 * of the `args?.x ?? default` idiom they all use.
 */
const SAMPLE_ARGS: Record<string, unknown> = {
  "fan-out-audit.js": { root: "src/routes/" },
  "compose.js": { root: "src/" },
  "cache-aware-orchestration.js": {
    taskId: "example-task",
    mode: "routine",
    stage: "plan",
    task: "Implement one bounded change.",
    originalRequestRef: "example-request",
  },
};

/**
 * A host that answers every spawn plausibly and deterministically.
 *
 * Replies are keyed off the `label`, exactly as
 * `test/workflow-claude-code-compat.test.ts` does, rather than off the schema:
 * `request.schema` reaches the host already COMPILED, so sniffing it for
 * property names silently matches nothing and every schema-bearing call ends up
 * `null`. Labels are stable and are what the examples name their calls by.
 *
 * The payloads still have to satisfy the real schemas — the runtime validates
 * them — so a wrong shape here fails the example rather than passing quietly.
 */
function stubHost(options: {
  gateFailsFor?: string[];
  failSpawnsFor?: string[];
  existingTaskIds?: string[];
  reviewFailsFirst?: boolean;
  reviewUnverifiedFirst?: boolean;
  advisorEscalates?: boolean;
} = {}): {
  host: WorkflowHost;
  spawns: WorkflowSpawnRequest[];
  artifacts: Map<string, string>;
} {
  const spawns: WorkflowSpawnRequest[] = [];
  const artifacts = new Map<string, string>();
  let currentTaskId: string | undefined;
  /** agentId → label, so `runGate` can tell which child it is gating. */
  const labels = new Map<string, string>();
  let reviewCalls = 0;

  const host: WorkflowHost = {
    async spawnAgent(request) {
      spawns.push(request);
      labels.set(request.agentId, request.label);
      const label = request.label;
      if (options.failSpawnsFor?.includes(label)) {
        return { ok: false, error: "mocked provider failure" };
      }

      // Only a call that ASKED for a schema gets JSON. Keying on the label
      // alone would hand fan-out-audit's un-schema'd `verify:<file>` calls a
      // JSON blob, since structured-findings labels its verifiers the same way.
      if (request.schema !== undefined) {
        if (label === "plan") {
          return {
            ok: true,
            text: JSON.stringify({
              objective: "Implement bounded change",
              invariants: ["Keep tests passing"],
              files: ["src/example.ts"],
              steps: [{ id: "step-1", task: "Make change", dependsOn: [], verify: "npm test" }],
              acceptance: ["Focused tests pass"],
              assumptions: [],
            }),
            outputTokens: 10,
          };
        }
        if (label === "advisor") {
          return {
            ok: true,
            text: JSON.stringify({
              question: "Is scope safe?",
              evidence: ["state:scope-change"],
              recommendation: "Continue with review",
              risks: [],
              escalate: options.advisorEscalates === true,
            }),
            outputTokens: 10,
          };
        }
        if (label === "review") {
          reviewCalls++;
          const failed = options.reviewFailsFirst === true && reviewCalls === 1;
          const unverified = options.reviewUnverifiedFirst === true && reviewCalls === 1;
          const status = failed ? "fail" : unverified ? "unverified" : "pass";
          return {
            ok: true,
            text: JSON.stringify({
              requirements: [{ item: "Focused tests pass", status, evidence: ["check:1"] }],
              blockers: failed ? ["review finding"] : [],
              residualRisks: [],
            }),
            outputTokens: 10,
          };
        }
        // structured-findings: one finding per dimension.
        if (label.startsWith("review:")) {
          return {
            ok: true,
            text: JSON.stringify({ findings: [{ title: `${label} finding`, file: "a.ts", severity: "low" }] }),
            outputTokens: 10,
          };
        }
        // structured-findings: every finding holds up.
        if (label.startsWith("verify:")) {
          return { ok: true, text: JSON.stringify({ isReal: true, why: "reproduced" }), outputTokens: 10 };
        }
        // lib/count-child.js
        if (label === "scan") {
          return { ok: true, text: JSON.stringify({ files: ["a.ts", "b.ts"] }), outputTokens: 10 };
        }
        // Deliberately invalid: a new schema-bearing example with an unhandled
        // label fails validation here rather than passing on an empty object.
        return { ok: true, text: "{}", outputTokens: 10 };
      }

      // fan-out-audit: drives the fan-out width, so keep it small and stable.
      if (label === "discover") {
        return { ok: true, text: "src/routes/a.ts\nsrc/routes/b.ts", outputTokens: 10 };
      }
      return { ok: true, text: `ok:${label}`, outputTokens: 10 };
    },
    abortAgent() {},
    async resumeAgent(_agentId, prompt) {
      return { ok: true, text: `resumed:${prompt.slice(0, 20)}`, outputTokens: 10 };
    },
    // Required, not optional: the runtime FAILS a gate it cannot run rather than
    // skipping it, so a host without this would fail every gated example.
    //
    // A rejected gate is reported HERE rather than as a failed spawn: a child
    // whose spawn failed is not offered as a resume target, so failing the spawn
    // would make gated-fix's whole reason for existing untestable.
    async runGate(command, gate) {
      const label = labels.get(gate.agentId) ?? "";
      const ok = !options.gateFailsFor?.includes(label);
      if (currentTaskId !== undefined) {
        const key = `${currentTaskId}/state.json`;
        const content = artifacts.get(key);
        if (content !== undefined) {
          const state = JSON.parse(content);
          state.checks.push({ command: "workflow gate", outcome: ok ? "passed" : "failed", exitCode: ok ? 0 : null });
          artifacts.set(key, JSON.stringify(state));
        }
      }
      return { ok, output: ok ? `${command}: ok` : `${command}: 1 failing` };
    },
    async artifactExists(taskId) {
      return options.existingTaskIds?.includes(taskId)
        || [...artifacts.keys()].some(key => key.startsWith(`${taskId}/`));
    },
    async readArtifact(taskId, name) {
      return artifacts.get(`${taskId}/${name}`);
    },
    async writeArtifact(taskId, name, content) {
      if (name === "state.json") currentTaskId = taskId;
      artifacts.set(`${taskId}/${name}`, content);
    },
    async appendUsage() {},
    async readUsage() {
      return { records: [], malformedLines: 0 };
    },
    loadWorkflow(ref) {
      // WorkflowScriptRef is { name?, scriptPath? } — never a bare string.
      const name = ref.name;
      if (name === undefined) return { ok: false, message: "only `name` refs are stubbed" };
      const file = childFiles.find(child => child === `${name}.js`);
      if (file === undefined) return { ok: false, message: `no child workflow "${name}"` };
      return { ok: true, script: readExample(LIB_DIR, file) };
    },
  };
  return { host, spawns, artifacts };
}

const runExample = (name: string, host: WorkflowHost) =>
  runWorkflow({ script: readExample(EXAMPLES_DIR, name), host, args: SAMPLE_ARGS[name] });

const cacheArgs = (overrides: Record<string, unknown> = {}) => ({
  taskId: "pilot-task",
  mode: "routine",
  stage: "plan",
  task: "Implement one bounded change.",
  originalRequestRef: "REQ-42",
  ...overrides,
});

const runCacheAware = (args: unknown, host: WorkflowHost) =>
  runWorkflow({ script: readExample(EXAMPLES_DIR, "cache-aware-orchestration.js"), host, args });

const storedState = (artifacts: Map<string, string>, taskId = "pilot-task") =>
  JSON.parse(artifacts.get(`${taskId}/state.json`)!);

describe("shipped example workflows", () => {
  it("ships at least the examples the guide links", () => {
    // docs/workflows.md has a row per file; a deletion should break this first.
    expect(exampleFiles).toEqual([
      "cache-aware-orchestration.js",
      "compose.js",
      "fan-out-audit.js",
      "gated-fix.js",
      "review-panel.js",
      "structured-findings.js",
    ]);
    expect(childFiles).toEqual(["count-child.js"]);
  });

  // Tier 1 — glob-driven, so a new example is covered the moment it lands.
  describe.each([...exampleFiles.map(n => [EXAMPLES_DIR, n] as const), ...childFiles.map(n => [LIB_DIR, n] as const)])(
    "%s/%s",
    (dir, name) => {
      it("is recognisable as a workflow and declares a usable meta block", () => {
        const source = readExample(dir, name);
        // The same test `saved.ts` applies before it will resolve a file.
        expect(hasMetaDeclaration(source)).toBe(true);

        // extractMeta throws WorkflowMetaError rather than returning a union,
        // so a bad `meta` surfaces as the parser's own message.
        const { meta } = extractMeta(source);
        expect(meta.name).toBeTruthy();
        expect(meta.description).toBeTruthy();
      });
    },
  );

  // Tier 2 — the one that actually catches things.
  describe.each(exampleFiles)("%s", name => {
    it("runs to completion against a stub host", async () => {
      const { host } = stubHost();
      const result = await runExample(name, host);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe("completed");
    });

    it("validates required args before spawning when run without args", async () => {
      const { host, spawns } = stubHost();
      const result = await runWorkflow({ script: readExample(EXAMPLES_DIR, name), host });

      if (name === "cache-aware-orchestration.js") {
        expect(result.error).toMatch(/args|taskId|mode|stage/i);
        expect(result.agentCount).toBe(0);
        expect(spawns).toHaveLength(0);
      } else {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe("completed");
      }
    });
  });

  // Tier 3 — explicit values, including the fan-out width.
  describe("returned values", () => {
    describe("cache-aware orchestration", () => {
      it("rejects invalid args before spawning", async () => {
        for (const args of [
          undefined,
          { taskId: "../escape", mode: "routine", stage: "plan", task: "change" },
          { taskId: "safe-id", mode: "unknown", stage: "plan", task: "change" },
          { taskId: "safe-id", mode: "routine", stage: "unknown", task: "change" },
        ]) {
          const { host, spawns } = stubHost();
          const result = await runCacheAware(args, host);
          expect(result.error).toBeTruthy();
          expect(result.agentCount).toBe(0);
          expect(spawns).toHaveLength(0);
        }
      });

      it("lets routine plan stage delegate trivial work to parent", async () => {
        const { host, spawns, artifacts } = stubHost();
        const result = await runCacheAware(cacheArgs({ trivial: true }), host);

        expect(result.value).toMatchObject({ handledByParent: true });
        expect(spawns).toHaveLength(0);
        expect(artifacts.size).toBe(0);
      });

      it("refuses a plan stage when task directory already exists", async () => {
        const { host, spawns } = stubHost({ existingTaskIds: ["occupied"] });
        const result = await runCacheAware(cacheArgs({ taskId: "occupied" }), host);

        expect(result.error).toMatch(/already exists/i);
        expect(spawns).toHaveLength(0);
      });

      it("requires plan-version approval before worker and persists the gate result", async () => {
        const { host, spawns, artifacts } = stubHost();
        const plan = await runCacheAware(cacheArgs(), host);
        expect(plan.error).toBeUndefined();
        expect(spawns[0]).toMatchObject({ label: "plan", agentType: "Plan", effort: "high" });
        expect(spawns[0].model).toBeUndefined();
        expect(artifacts.get("pilot-task/plan.md")).toContain("Implement bounded change");
        expect(storedState(artifacts)).toMatchObject({
          taskId: "pilot-task", mode: "routine", stage: "plan", planVersion: 1, approvedPlanVersion: null,
        });

        const unapproved = await runCacheAware(cacheArgs({ stage: "worker", test: "npm test" }), host);
        expect(unapproved.error).toMatch(/approved.*plan/i);
        expect(spawns).toHaveLength(1);

        const worker = await runCacheAware(
          cacheArgs({ stage: "worker", approvedPlanVersion: 1, test: "npm test" }),
          host,
        );
        expect(worker.error).toBeUndefined();
        expect(spawns[1]).toMatchObject({ label: "worker", agentType: "general-purpose", effort: "low", gate: "npm test" });
        expect(spawns[1].model).toBeUndefined();
        expect(storedState(artifacts)).toMatchObject({
          stage: "worker",
          approvedPlanVersion: 1,
          checks: [{ command: "workflow gate", outcome: "passed", exitCode: 0 }],
        });

        const reviewContext = {
          revisionId: "rev-1",
          originalRequest: "redacted original request",
          approvedPlan: artifacts.get("pilot-task/plan.md")!,
          actualDiff: "diff summary",
          validationResults: "npm test passed",
          unresolvedIssues: "none",
        };
        const review = await runCacheAware(cacheArgs({ stage: "review", reviewContext }), host);
        expect(review.value).toMatchObject({ status: "pass", pass: true });
        expect(spawns[2]).toMatchObject({ label: "review", agentType: "reviewer", effort: "high" });
        for (const [key, evidence] of Object.entries(reviewContext)) {
          if (key !== "revisionId") expect(spawns[2].prompt).toContain(evidence);
        }
        expect(spawns[2].prompt).not.toContain(reviewContext.revisionId);
        expect(spawns[2].model).toBeUndefined();
        expect(storedState(artifacts)).toMatchObject({ stage: "review", reviewStatus: "pass" });
        expect(JSON.parse(artifacts.get("pilot-task/review.md")!)).toMatchObject({ status: "pass" });
      });

      it("requires review feedback for fixes and does not re-review unchanged work", async () => {
        const { host, spawns, artifacts } = stubHost({ reviewFailsFirst: true });
        await runCacheAware(cacheArgs({}), host);
        await runCacheAware(cacheArgs({ stage: "worker", approvedPlanVersion: 1 }), host);
        const reviewContext = {
          revisionId: "rev-1",
          originalRequest: "redacted request",
          approvedPlan: artifacts.get("pilot-task/plan.md")!,
          actualDiff: "initial diff",
          validationResults: "gate passed",
          unresolvedIssues: "none",
        };
        const firstReview = await runCacheAware(cacheArgs({ stage: "review", reviewContext }), host);
        expect(firstReview.value).toMatchObject({ status: "fail", pass: false });

        const unchangedReview = await runCacheAware(cacheArgs({ stage: "review" }), host);
        expect(unchangedReview.value).toMatchObject({ status: "fail", pass: false, reused: true });
        expect(spawns.filter(spawn => spawn.label === "review")).toHaveLength(1);

        const changedWithoutGate = await runCacheAware(cacheArgs({
          stage: "review",
          reviewContext: { ...reviewContext, revisionId: "rev-2", actualDiff: "different diff" },
        }), host);
        expect(changedWithoutGate.value).toMatchObject({
          status: "unverified", pass: false, requiresGate: true,
        });
        expect(spawns.filter(spawn => spawn.label === "review")).toHaveLength(1);

        const missingFeedback = await runCacheAware(cacheArgs({ stage: "worker", approvedPlanVersion: 1 }), host);
        expect(missingFeedback.error).toMatch(/review feedback/i);
        expect(spawns.filter(spawn => spawn.label === "worker")).toHaveLength(1);

        const repair = await runCacheAware(cacheArgs({
          stage: "worker",
          approvedPlanVersion: 1,
          reviewFeedback: "Address reviewer finding at src/example.ts:1.",
        }), host);
        expect(repair.error).toBeUndefined();
        expect(spawns.filter(spawn => spawn.label === "worker")).toHaveLength(2);
        expect(spawns.find(spawn => spawn.label === "worker" && spawn.prompt.includes("reviewer finding"))).toBeDefined();
        expect(storedState(artifacts)).toMatchObject({
          reviewStatus: "pending",
          repairAttempts: 1,
          checks: [{ outcome: "passed" }, { outcome: "passed" }],
        });

        const secondReview = await runCacheAware(cacheArgs({
          stage: "review",
          reviewContext: { ...reviewContext, revisionId: "rev-2", actualDiff: "fixed diff" },
        }), host);
        expect(secondReview.value).toMatchObject({ status: "pass", pass: true });
        expect(spawns.filter(spawn => spawn.label === "review")).toHaveLength(2);
      });

      it("requires a fresh passing gate when unverified review moves to a new revision", async () => {
        const { host, spawns, artifacts } = stubHost({ reviewUnverifiedFirst: true });
        await runCacheAware(cacheArgs({}), host);
        await runCacheAware(cacheArgs({ stage: "worker", approvedPlanVersion: 1 }), host);
        const reviewContext = {
          revisionId: "review-rev-1",
          originalRequest: "redacted request",
          approvedPlan: artifacts.get("pilot-task/plan.md")!,
          actualDiff: "initial diff",
          validationResults: "gate passed",
          unresolvedIssues: "none",
        };
        const firstReview = await runCacheAware(cacheArgs({ stage: "review", reviewContext }), host);
        expect(firstReview.value).toMatchObject({ status: "unverified", pass: false });
        const unchangedReview = await runCacheAware(cacheArgs({ stage: "review" }), host);
        expect(unchangedReview.value).toMatchObject({ status: "unverified", pass: false, reused: true });

        const changedWithoutGate = await runCacheAware(cacheArgs({
          stage: "review",
          reviewContext: { ...reviewContext, revisionId: "review-rev-2", actualDiff: "changed diff" },
        }), host);
        expect(changedWithoutGate.value).toMatchObject({
          status: "unverified", pass: false, staleReview: true, requiresGate: true,
        });
        expect(spawns.filter(spawn => spawn.label === "review")).toHaveLength(1);

        await runCacheAware(cacheArgs({ stage: "worker", approvedPlanVersion: 1 }), host);
        expect(storedState(artifacts).checks).toHaveLength(2);
        const secondReview = await runCacheAware(cacheArgs({
          stage: "review",
          reviewContext: { ...reviewContext, revisionId: "review-rev-2", actualDiff: "changed diff" },
        }), host);
        expect(secondReview.value).toMatchObject({ status: "pass", pass: true });
        expect(spawns.filter(spawn => spawn.label === "review")).toHaveLength(2);
      });

      it("keeps complex worker bounded without switching parent model", async () => {
        const { host, spawns } = stubHost();
        await runCacheAware(cacheArgs({ mode: "complex", taskId: "complex-task" }), host);
        await runCacheAware(
          cacheArgs({ mode: "complex", taskId: "complex-task", stage: "worker", approvedPlanVersion: 1 }),
          host,
        );

        expect(spawns.map(spawn => spawn.agentType)).toEqual(["Plan", "general-purpose"]);
        expect(spawns[1].effort).toBe("low");
        expect(spawns.every(spawn => spawn.model === undefined)).toBe(true);
      });

      it("consults advisor only for an explicit supported trigger", async () => {
        const { host, spawns } = stubHost();
        await runCacheAware(cacheArgs({ taskId: "advisor-task" }), host);
        const invalid = await runCacheAware(
          cacheArgs({ taskId: "advisor-task", stage: "advisor", trigger: "routine" }),
          host,
        );
        expect(invalid.error).toMatch(/trigger/i);
        expect(spawns).toHaveLength(1);

        const result = await runCacheAware(cacheArgs({
          taskId: "advisor-task",
          stage: "advisor",
          trigger: "security-change",
          question: "Does this change cross a security boundary?",
          evidence: ["src/auth.ts:12"],
        }), host);
        expect(result.error).toBeUndefined();
        expect(spawns[1]).toMatchObject({ label: "advisor", agentType: "advisor", effort: "high" });
        expect(spawns[1].model).toBeUndefined();
      });

      it("preserves artifacts and blocks workers when advisor requires parent escalation", async () => {
        const { host, spawns, artifacts } = stubHost({ advisorEscalates: true });
        await runCacheAware(cacheArgs({ taskId: "escalate-task" }), host);
        const advice = await runCacheAware(cacheArgs({
          taskId: "escalate-task",
          stage: "advisor",
          trigger: "security-change",
          question: "Does this cross a security boundary?",
          evidence: ["src/auth.ts:12"],
        }), host);
        expect(advice.value).toMatchObject({ escalate: true, handoffRequired: true });
        expect(artifacts.get("escalate-task/state.json")).toContain("Advisor escalation: security-change");

        const blocked = await runCacheAware(cacheArgs({
          taskId: "escalate-task",
          stage: "worker",
          approvedPlanVersion: 1,
        }), host);
        expect(blocked.error).toMatch(/manually selected Sol\/high parent/i);
        expect(spawns.map(spawn => spawn.label)).toEqual(["plan", "advisor"]);
      });

      it("stops after two failed repair attempts and does not count provider failure", async () => {
        const gateHost = stubHost({ gateFailsFor: ["worker"] });
        await runCacheAware(cacheArgs({ taskId: "repair-task" }), gateHost.host);
        const workerArgs = cacheArgs({ taskId: "repair-task", stage: "worker", approvedPlanVersion: 1 });
        const initial = await runCacheAware(workerArgs, gateHost.host);
        const repairOne = await runCacheAware(workerArgs, gateHost.host);
        const repairTwo = await runCacheAware(workerArgs, gateHost.host);
        const stopped = await runCacheAware(workerArgs, gateHost.host);

        expect(initial.value).toMatchObject({ needsRepair: true, repairAttempts: 0 });
        expect(repairOne.value).toMatchObject({ needsRepair: true, repairAttempts: 1 });
        expect(repairTwo.value).toMatchObject({ needsRepair: true, repairAttempts: 2 });
        expect(stopped.value).toMatchObject({ advisorRequired: true, repairAttempts: 2 });
        expect(gateHost.spawns.filter(spawn => spawn.label === "worker")).toHaveLength(3);
        expect(storedState(gateHost.artifacts, "repair-task").repairAttempts).toBe(2);
        const advisor = await runCacheAware(cacheArgs({
          taskId: "repair-task",
          stage: "advisor",
          trigger: "two-failed-repairs",
          question: "What is blocking verification?",
          evidence: ["state.json"],
        }), gateHost.host);
        expect(advisor.error).toBeUndefined();
        expect(gateHost.spawns[4]).toMatchObject({ agentType: "advisor", effort: "high" });

        const providerHost = stubHost({ failSpawnsFor: ["worker"] });
        await runCacheAware(cacheArgs({ taskId: "provider-task" }), providerHost.host);
        const failed = await runCacheAware(
          cacheArgs({ taskId: "provider-task", stage: "worker", approvedPlanVersion: 1 }),
          providerHost.host,
        );
        expect(failed.value).toMatchObject({ providerFailure: true, repairAttempts: 0 });
        expect(storedState(providerHost.artifacts, "provider-task")).toMatchObject({ repairAttempts: 0, checks: [] });
      });

      it("leaves review unverified without supplied review evidence", async () => {
        const { host, spawns, artifacts } = stubHost();
        await runCacheAware(cacheArgs(), host);
        await runCacheAware(cacheArgs({ stage: "worker", approvedPlanVersion: 1 }), host);
        const result = await runCacheAware(cacheArgs({ stage: "review" }), host);

        expect(result.value).toMatchObject({ status: "unverified", pass: false });
        expect(spawns).toHaveLength(2);
        expect(storedState(artifacts)).toMatchObject({ stage: "review", reviewStatus: "unverified" });
      });

    });

    it("fan-out-audit returns one verified finding per discovered file", async () => {
      const { host } = stubHost();
      const result = await runExample("fan-out-audit.js", host);

      // 1 discovery + 2 files x (audit + verify).
      expect(result.agentCount).toBe(5);
      expect(result.value).toEqual(["ok:verify:src/routes/a.ts", "ok:verify:src/routes/b.ts"]);
    });

    it("structured-findings returns validated objects, not prose", async () => {
      const { host } = stubHost();
      const result = await runExample("structured-findings.js", host);

      // 2 dimensions x (1 review + 1 finding verified).
      expect(result.agentCount).toBe(4);
      expect(result.value).toMatchObject({ confirmed: 2 });
    });

    it("review-panel synthesizes once, after every lens", async () => {
      const { host, spawns } = stubHost();
      const result = await runExample("review-panel.js", host);

      expect(result.agentCount).toBe(4); // 3 lenses + 1 synthesis
      expect(result.value).toMatchObject({ reviewed: 3 });
      // The cheap/expensive split is the point of the example.
      expect(spawns.filter(s => s.effort === "low")).toHaveLength(3);
      expect(spawns.find(s => s.label === "synthesize")?.effort).toBe("high");
    });

    it("compose runs its nested child and reports what it counted", async () => {
      const { host } = stubHost();
      const result = await runExample("compose.js", host);

      // The child's agent counts toward the parent run — they share the counter.
      expect(result.agentCount).toBe(2);
      expect(result.value).toMatchObject({ ok: true, count: 2 });
    });

    it("gated-fix passes straight through when the gate is happy", async () => {
      const { host, spawns } = stubHost();
      const result = await runExample("gated-fix.js", host);

      expect(result.agentCount).toBe(1);
      expect(result.value).toMatchObject({ passed: true });
      expect(spawns[0]?.gate).toBe("npm test");
    });

    it("gated-fix resumes the same child when the gate rejects the work", async () => {
      // The branch the example exists to demonstrate: fail the first gate only.
      const { host, spawns } = stubHost({ gateFailsFor: ["fix"] });
      const result = await runExample("gated-fix.js", host);

      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ passed: true });
      // fix (gated, fails) → resume → verify (gated, passes).
      expect(spawns.map(s => s.label)).toEqual(["fix", "verify"]);
      expect(result.agentCount).toBe(3);
    });
  });

  // A negative case, rather than shipping a deliberately broken file.
  it("a file with no meta declaration is not treated as a workflow", () => {
    // `const meta` without `export` is the near-miss worth pinning: it reads
    // like a workflow and is not one.
    const notAWorkflow = "const meta = { name: 'x' };\nreturn 1;\n";

    expect(hasMetaDeclaration(notAWorkflow)).toBe(false);
    expect(() => extractMeta(notAWorkflow)).toThrow(WorkflowMetaError);
  });
});
