import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EffectiveThinkingLevel, ThinkingLevel } from "../types.js";

export type WorkflowTextArtifact = "plan.md" | "state.json" | "review.md";

export interface WorkflowState {
  taskId: string;
  mode: "routine" | "complex";
  stage: "plan" | "advisor" | "worker" | "review";
  originalRequestRef: string | null;
  planVersion: number;
  approvedPlanVersion: number | null;
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

export interface WorkflowUsageInput {
  event: "usage" | "complete";
  taskId: string;
  workflowId: string;
  agentId: string;
  role: string;
  provider: string | null;
  model: string | null;
  requestedThinking: EffectiveThinkingLevel | null;
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

export interface WorkflowUsageRecord extends WorkflowUsageInput {
  timestamp: string;
}

export interface WorkflowArtifactStore {
  exists(): Promise<boolean>;
  read(name: WorkflowTextArtifact): Promise<string | undefined>;
  write(name: WorkflowTextArtifact, content: string): Promise<void>;
  appendUsage(record: WorkflowUsageInput): Promise<void>;
  readUsage(): Promise<{ records: WorkflowUsageRecord[]; malformedLines: number }>;
}

export type WorkflowUsageEvent = Omit<WorkflowUsageInput, "taskId">;
export type WorkflowCheckOutcome = WorkflowState["checks"][number]["outcome"];

interface ActiveWorkflowArtifacts {
  taskId: string;
  store: WorkflowArtifactStore;
  tail: Promise<void>;
  pending: Set<Promise<void>>;
  failure?: unknown;
}

const activeWorkflowArtifacts = new Map<string, ActiveWorkflowArtifacts>();

/** Register one task-scoped store for host-side agent usage callbacks. */
export function registerWorkflowArtifacts(
  workflowId: string,
  taskId: string,
  store: WorkflowArtifactStore,
): void {
  if (!/^wf_[a-z0-9-]{6,}$/.test(workflowId)) fail("invalid workflow ID.");
  const current = activeWorkflowArtifacts.get(workflowId);
  if (current !== undefined) {
    if (current.taskId !== taskId || current.store !== store) fail("workflow artifact registration changed mid-run.");
    return;
  }
  activeWorkflowArtifacts.set(workflowId, { taskId, store, tail: Promise.resolve(), pending: new Set() });
}

function queueWorkflowArtifactWrite(active: ActiveWorkflowArtifacts, write: () => Promise<void>): Promise<void> {
  const queued = active.tail.then(write).catch(error => {
    active.failure ??= error;
  });
  active.tail = queued;
  active.pending.add(queued);
  void queued.then(() => active.pending.delete(queued));
  return queued;
}

/** Queue allowlisted usage without blocking the message_end callback. */
export function appendWorkflowUsage(workflowId: string, event: WorkflowUsageEvent): void {
  const active = activeWorkflowArtifacts.get(workflowId);
  if (active === undefined) return;
  void queueWorkflowArtifactWrite(active, () => active.store.appendUsage({ ...event, taskId: active.taskId }));
}

/** Persist gate outcome only; never persist command arguments or output. */
export async function appendWorkflowCheck(
  workflowId: string,
  check: { outcome: WorkflowCheckOutcome; exitCode: number | null },
): Promise<void> {
  const active = activeWorkflowArtifacts.get(workflowId);
  if (active === undefined) return;
  if (!(check.outcome === "passed" || check.outcome === "failed" || check.outcome === "unavailable")
    || !(check.exitCode === null || Number.isSafeInteger(check.exitCode))) {
    fail("workflow check does not match state schema.");
  }
  await queueWorkflowArtifactWrite(active, async () => {
    const content = await active.store.read("state.json");
    if (content === undefined) return;
    const state: unknown = JSON.parse(content);
    validateState(state, active.taskId);
    if (state.checks.length >= 256) fail("state.json check limit reached.");
    state.checks.push({ command: "workflow gate", ...check });
    await active.store.write("state.json", JSON.stringify(state, null, 2));
  });
  if (active.failure !== undefined) throw active.failure;
}

/** Drain message/completion rows, then release the session-local association. */
export async function finishWorkflowArtifacts(workflowId: string): Promise<void> {
  const active = activeWorkflowArtifacts.get(workflowId);
  if (active === undefined) return;
  try {
    while (active.pending.size > 0) await Promise.all(active.pending);
    if (active.failure !== undefined) throw active.failure;
  } finally {
    if (activeWorkflowArtifacts.get(workflowId) === active) activeWorkflowArtifacts.delete(workflowId);
  }
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const TEXT_LIMIT = 1024 * 1024;
const STATE_LIMIT = 64 * 1024;
const USAGE_LIMIT = 5 * 1024 * 1024;
const USAGE_RECORD_LIMIT = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const TEXT_NAMES = new Set<WorkflowTextArtifact>(["plan.md", "state.json", "review.md"]);
const USAGE_INPUT_KEYS = [
  "event", "taskId", "workflowId", "agentId", "role", "provider", "model",
  "requestedThinking", "effectiveThinking", "input", "output", "cacheRead", "cacheWrite",
  "costUsd", "attempt", "status", "durationMs",
] as const;
const USAGE_RECORD_KEYS = ["timestamp", ...USAGE_INPUT_KEYS] as const;
const STATE_KEYS = [
  "taskId", "mode", "stage", "originalRequestRef", "planVersion", "approvedPlanVersion", "agents",
  "repairAttempts", "checks", "blockers", "reviewStatus",
] as const;
const AGENT_STATE_KEYS = [
  "role", "agentId", "sessionId", "provider", "model", "requestedThinking", "effectiveThinking", "attempts",
] as const;
const CHECK_KEYS = ["command", "outcome", "exitCode"] as const;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function fail(message: string): never {
  throw new Error(`Workflow artifacts: ${message}`);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function safeText(value: unknown, maxLength = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTERS.test(value);
}

function nullableText(value: unknown, maxLength = 1024): value is string | null {
  return value === null || safeText(value, maxLength);
}

function isThinking(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value);
}

function isEffectiveThinking(value: unknown): value is EffectiveThinkingLevel {
  return value === "off" || isThinking(value);
}

function isNullableFinite(value: unknown, minimum = 0): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= minimum);
}

function validateState(value: unknown, taskId: string): asserts value is WorkflowState {
  if (!isRecord(value) || !hasExactKeys(value, STATE_KEYS)) fail("state.json does not match workflow state schema.");
  if (value.taskId !== taskId
    || (value.mode !== "routine" && value.mode !== "complex")
    || !["plan", "advisor", "worker", "review"].includes(value.stage as string)
    || !(value.originalRequestRef === null || safeText(value.originalRequestRef, 256))
    || !Number.isSafeInteger(value.planVersion) || (value.planVersion as number) < 1
    || !(value.approvedPlanVersion === null
      || (Number.isSafeInteger(value.approvedPlanVersion) && value.approvedPlanVersion === value.planVersion))
    || !Number.isSafeInteger(value.repairAttempts) || (value.repairAttempts as number) < 0
    || !Array.isArray(value.agents) || value.agents.length > 256
    || !Array.isArray(value.checks) || value.checks.length > 256
    || !Array.isArray(value.blockers) || value.blockers.length > 100
    || !["pending", "pass", "fail", "unverified"].includes(value.reviewStatus as string)) {
    fail("state.json does not match workflow state schema.");
  }
  for (const agent of value.agents) {
    if (!isRecord(agent) || !hasExactKeys(agent, AGENT_STATE_KEYS)
      || !safeText(agent.role, 80) || !safeText(agent.agentId, 128)
      || !nullableText(agent.sessionId, 128) || !nullableText(agent.provider, 128) || !nullableText(agent.model, 256)
      || !(agent.requestedThinking === null || isThinking(agent.requestedThinking))
      || !(agent.effectiveThinking === null || isEffectiveThinking(agent.effectiveThinking))
      || !Number.isSafeInteger(agent.attempts) || (agent.attempts as number) < 0) {
      fail("state.json agent entry does not match workflow state schema.");
    }
  }
  for (const check of value.checks) {
    if (!isRecord(check) || !hasExactKeys(check, CHECK_KEYS)
      || !safeText(check.command, 256)
      || !["passed", "failed", "unavailable"].includes(check.outcome as string)
      || !(check.exitCode === null || (Number.isSafeInteger(check.exitCode) && (check.exitCode as number) >= 0))) {
      fail("state.json check entry does not match workflow state schema.");
    }
  }
  if (!value.blockers.every(blocker => safeText(blocker, 512))) {
    fail("state.json blockers do not match workflow state schema.");
  }
}

function validateUsageInput(value: unknown, taskId: string): asserts value is WorkflowUsageInput {
  if (!isRecord(value) || !hasExactKeys(value, USAGE_INPUT_KEYS)
    || (value.event !== "usage" && value.event !== "complete")
    || value.taskId !== taskId
    || !safeText(value.workflowId, 128) || !safeText(value.agentId, 128) || !safeText(value.role, 80)
    || !nullableText(value.provider, 128) || !nullableText(value.model, 256)
    || !(value.requestedThinking === null || isEffectiveThinking(value.requestedThinking))
    || !(value.effectiveThinking === null || isEffectiveThinking(value.effectiveThinking))
    || !Number.isSafeInteger(value.attempt)
    || (value.event === "usage" ? (value.attempt as number) < 1 : (value.attempt as number) < 0)) {
    fail("usage record does not match telemetry schema or task ID.");
  }
  if (value.event === "usage") {
    if (![value.input, value.output, value.cacheRead, value.cacheWrite].every(item => isNullableFinite(item))
      || !isNullableFinite(value.costUsd, Number.NEGATIVE_INFINITY)
      || value.status !== null || value.durationMs !== null) {
      fail("usage record values do not match telemetry schema.");
    }
  } else if (value.input !== null || value.output !== null || value.cacheRead !== null || value.cacheWrite !== null
    || value.costUsd !== null || !safeText(value.status, 80)
    || typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    fail("completion record values do not match telemetry schema.");
  }
}

function validateStoredUsage(value: unknown, taskId: string): value is WorkflowUsageRecord {
  if (!isRecord(value) || !hasExactKeys(value, USAGE_RECORD_KEYS)
    || typeof value.timestamp !== "string"
    || !Number.isFinite(Date.parse(value.timestamp))
    || new Date(value.timestamp).toISOString() !== value.timestamp) return false;
  try {
    const { timestamp: _timestamp, ...input } = value;
    validateUsageInput(input, taskId);
    return true;
  } catch {
    return false;
  }
}

function validateName(name: string): asserts name is WorkflowTextArtifact {
  if (!TEXT_NAMES.has(name as WorkflowTextArtifact)) fail("artifact name is not allowed.");
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail("path component is not a real directory (symlinks are rejected).");
    return;
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail("path component is not a real directory (symlinks are rejected).");
}

async function ensureTaskDirectory(cwd: string, taskId: string): Promise<string> {
  const projectRoot = await realpath(resolve(cwd));
  const piDir = join(projectRoot, ".pi");
  const workflowDir = join(piDir, "workflow");
  const taskDir = join(workflowDir, taskId);
  await ensureDirectory(piDir);
  await ensureDirectory(workflowDir);
  await ensureDirectory(taskDir);
  const canonicalTaskDir = await realpath(taskDir);
  const fromRoot = relative(projectRoot, canonicalTaskDir);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    fail("task directory escaped the project root.");
  }
  return canonicalTaskDir;
}

async function taskDirectoryExists(cwd: string, taskId: string): Promise<boolean> {
  const projectRoot = await realpath(resolve(cwd));
  const taskDir = join(projectRoot, ".pi", "workflow", taskId);
  for (const path of [join(projectRoot, ".pi"), join(projectRoot, ".pi", "workflow"), taskDir]) {
    try {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        fail("path component is not a real directory (symlinks are rejected).");
      }
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }
  const canonicalTaskDir = await realpath(taskDir);
  const fromRoot = relative(projectRoot, canonicalTaskDir);
  if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    fail("task directory escaped the project root.");
  }
  return true;
}

async function existingRegularFile(path: string) {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) fail("artifact target is not a regular file.");
    return entry;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readRegularFile(path: string, maxBytes: number): Promise<string | undefined> {
  const entry = await existingRegularFile(path);
  if (entry === undefined) return undefined;
  if (entry.size > maxBytes) fail("artifact exceeds its size limit.");
  const handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > maxBytes) fail("artifact target changed or exceeds its size limit.");
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

async function atomicReplace(cwd: string, taskId: string, directory: string, target: string, content: string): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await existingRegularFile(target);
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const currentDirectory = await ensureTaskDirectory(cwd, taskId);
    if (currentDirectory !== directory) fail("task directory changed during atomic write.");
    await existingRegularFile(target);
    await rename(temporary, target);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createWorkflowArtifacts(cwd: string, taskId: string): WorkflowArtifactStore {
  if (typeof cwd !== "string" || cwd.length === 0 || typeof taskId !== "string"
    || !TASK_ID.test(taskId) || taskId.includes("..")) fail("invalid project root or task ID.");

  return {
    async exists() {
      return taskDirectoryExists(cwd, taskId);
    },

    async read(name) {
      validateName(name);
      const directory = await ensureTaskDirectory(cwd, taskId);
      const content = await readRegularFile(join(directory, name), name === "state.json" ? STATE_LIMIT : TEXT_LIMIT);
      if (content !== undefined && name === "state.json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          fail("state.json contains malformed JSON.");
        }
        validateState(parsed, taskId);
      }
      return content;
    },

    async write(name, content) {
      validateName(name);
      if (typeof content !== "string") fail("artifact content must be text.");
      const maxBytes = name === "state.json" ? STATE_LIMIT : TEXT_LIMIT;
      if (Buffer.byteLength(content, "utf-8") > maxBytes) fail("artifact exceeds its size limit.");
      if (name === "state.json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          fail("state.json contains malformed JSON.");
        }
        validateState(parsed, taskId);
      }
      const directory = await ensureTaskDirectory(cwd, taskId);
      await atomicReplace(cwd, taskId, directory, join(directory, name), content);
    },

    async appendUsage(record) {
      validateUsageInput(record, taskId);
      const stored: WorkflowUsageRecord = { ...record, timestamp: new Date().toISOString() };
      const line = `${JSON.stringify(stored)}\n`;
      if (Buffer.byteLength(line, "utf-8") > USAGE_RECORD_LIMIT) fail("usage record exceeds its size limit.");
      const directory = await ensureTaskDirectory(cwd, taskId);
      const path = join(directory, "usage.jsonl");
      const current = await existingRegularFile(path);
      if ((current?.size ?? 0) + Buffer.byteLength(line, "utf-8") > USAGE_LIMIT) fail("usage.jsonl exceeds its size limit.");
      const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | O_NOFOLLOW, 0o600);
      try {
        const afterOpen = await handle.stat();
        if (!afterOpen.isFile() || afterOpen.size + Buffer.byteLength(line, "utf-8") > USAGE_LIMIT) {
          fail("usage.jsonl changed or exceeds its size limit.");
        }
        await handle.writeFile(line, "utf-8");
      } finally {
        await handle.close();
      }
    },

    async readUsage() {
      const directory = await ensureTaskDirectory(cwd, taskId);
      const content = await readRegularFile(join(directory, "usage.jsonl"), USAGE_LIMIT);
      if (content === undefined) return { records: [], malformedLines: 0 };
      const records: WorkflowUsageRecord[] = [];
      let malformedLines = 0;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (line === "" && index === lines.length - 1) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!validateStoredUsage(parsed, taskId)) malformedLines++;
          else records.push(parsed);
        } catch {
          malformedLines++;
        }
      }
      return { records, malformedLines };
    },
  };
}
