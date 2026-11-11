import { type ChildProcess, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export const OPENCODE_MODEL = "opencode/deepseek-v4.1-flash-free";

const TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 1_000;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const ENV_ALLOWLIST = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"]);
const ENV_PREFIXES = ["XDG_", "OPENCODE_", "PI_OPENCODE_"];
const modelMatches = (id: string) => id === OPENCODE_MODEL || id === OPENCODE_MODEL.split("/").at(-1);

interface OpenCodeUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
  cost?: number;
}
interface OpenCodeToolObservation {
  name?: string;
  status?: string;
  executed?: boolean;
}
export interface OpenCodeDetails {
  runtime: "opencode";
  model: typeof OPENCODE_MODEL;
  cwd: string;
  sessionId?: string;
  usage?: OpenCodeUsage;
  tools: OpenCodeToolObservation[];
}
export interface RunnerOptions {
  /** Test-only seam. Never reachable from tool parameters. */
  binaryPath?: string;
  /** Test-only seam. Environment source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test-only seam. Deadline override; defaults to 120s. */
  timeoutMs?: number;
}

interface Failure { message: string }

function allowedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(key) || ENV_PREFIXES.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

const finiteNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export async function runOpenCodeTask(
  prompt: string,
  cwdInput: string,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
  options: RunnerOptions = {},
): Promise<{ text: string; details: OpenCodeDetails }> {
  if (process.platform === "win32") throw new Error("OpenCode task is unsupported on Windows (requires POSIX process groups)");
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.includes("\0") || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("Prompt must contain 1–16384 UTF-8 bytes and no NUL");
  }
  if (signal?.aborted) throw new Error("OpenCode task aborted");
  const cwd = await realpath(cwdInput);
  if (signal?.aborted) throw new Error("OpenCode task aborted");
  const argv = ["--standalone", "run", "--model", OPENCODE_MODEL, "--format", "json", "--archived", `Task:\n${prompt}`];
  const child = spawn(options.binaryPath ?? "opencode", argv, {
    cwd,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: allowedEnv(options.env ?? process.env),
  });

  return supervise(child, cwd, signal, onUpdate, options.timeoutMs ?? TIMEOUT_MS);
}

function supervise(
  child: ChildProcess,
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
  timeoutMs: number,
): Promise<{ text: string; details: OpenCodeDetails }> {
  const details: OpenCodeDetails = { runtime: "opencode", model: OPENCODE_MODEL, cwd, tools: [] };
  let text = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stderr = "";
  let usage: OpenCodeUsage | undefined;
  let sessionId: string | undefined;
  let modelId: string | undefined;
  let failure: Failure | undefined;
  let finished = false;
  const timers: NodeJS.Timeout[] = [];
  let groupKillTimer: NodeJS.Timeout | undefined;
  let forceSettle: (() => void) | undefined;
  let forceTimer: NodeJS.Timeout | undefined;

  const killGroup = (sig: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      // Group already gone.
    }
  };
  const scheduleGroupKill = () => {
    killGroup("SIGTERM");
    if (groupKillTimer !== undefined) return;
    groupKillTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    groupKillTimer.unref();
  };
  const armForceSettle = (ms: number) => {
    if (finished || forceTimer !== undefined) return;
    forceTimer = setTimeout(() => {
      if (finished) return;
      if (!failure) failure = { message: "OpenCode did not close after termination" };
      killGroup("SIGKILL");
      forceSettle?.();
    }, ms);
  };
  // Kill the group even when the leader has already exited: descendants may still hold pipes.
  const terminate = (f: Failure) => {
    if (!failure) failure = f;
    scheduleGroupKill();
    armForceSettle(KILL_GRACE_MS + 250);
  };
  const onAbort = () => terminate({ message: "OpenCode task aborted" });
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  timers.push(setTimeout(() => terminate({ message: `OpenCode task timed out after ${timeoutMs}ms` }), timeoutMs));

  const handleEvent = (event: Record<string, unknown>) => {
    if (event.type === "text" || event.type === "tool" || event.type === "step_finish") {
      if (!event.part || typeof event.part !== "object" || Array.isArray(event.part)) {
        return protocol("OpenCode emitted malformed event part");
      }
    }
    if (typeof event.sessionID === "string") {
      if (sessionId !== undefined && sessionId !== event.sessionID) return protocol("OpenCode emitted contradictory session identity");
      sessionId = event.sessionID;
    }
    if (typeof event.modelID === "string") {
      if (modelId !== undefined && modelId !== event.modelID) return protocol("OpenCode emitted contradictory model identity");
      modelId = event.modelID;
    }
    if (modelId !== undefined && !modelMatches(modelId)) return protocol("OpenCode emitted contradictory model identity");
    if (event.type === "error") return protocol("OpenCode reported an error event");
    const part = asRecord(event.part);
    if (event.type === "text") {
      if (typeof part.text !== "string") return protocol("OpenCode text event missing text");
      if (Buffer.byteLength(text + part.text, "utf8") > MAX_TEXT_BYTES) return bound("final text");
      text += part.text;
      if (onUpdate) {
        try {
          onUpdate(text);
        } catch (error) {
          terminate({ message: `OpenCode update callback failed: ${error instanceof Error ? error.message : String(error)}` });
          return;
        }
      }
    } else if (event.type === "tool") {
      const state = asRecord(part.state);
      details.tools.push({
        name: typeof part.name === "string" ? part.name : typeof part.tool === "string" ? part.tool : undefined,
        status: typeof part.state === "string" ? part.state : typeof state.status === "string" ? state.status : undefined,
        executed: typeof part.executed === "boolean" ? part.executed : undefined,
      });
    } else if (event.type === "step_finish") {
      const tokens = asRecord(part.tokens);
      const cache = asRecord(tokens.cache);
      const step: OpenCodeUsage = {
        input: finiteNumber(tokens.input),
        output: finiteNumber(tokens.output),
        reasoning: finiteNumber(tokens.reasoning),
        cache: { read: finiteNumber(cache.read), write: finiteNumber(cache.write) },
        cost: finiteNumber(part.cost),
      };
      usage = accumulate(usage, step);
    }
  };
  const protocol = (message: string) => {
    terminate({ message });
  };
  const bound = (what: string) => {
    terminate({ message: `OpenCode ${what} exceeded output bound` });
  };

  // Manual line splitter: caps each partial line before buffering, unlike readline.
  let pending = "";
  const onLine = (line: string) => {
    if (failure) return;
    if (line.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return protocol("OpenCode emitted malformed JSONL");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return protocol("OpenCode emitted malformed event envelope");
    }
    const record = event as Record<string, unknown>;
    if (typeof record.type !== "string") return protocol("OpenCode emitted event without a type");
    handleEvent(record);
  };
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (stdoutBytes > MAX_STDOUT_BYTES) return bound("stdout");
    pending += chunk;
    let nl = pending.indexOf("\n");
    while (nl !== -1) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) return bound("stdout line");
      onLine(line);
      if (failure) return;
      nl = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > MAX_LINE_BYTES) bound("stdout line");
  });
  const flushPending = () => {
    if (!failure && pending.length > 0) onLine(pending.replace(/\r$/, ""));
    pending = "";
  };
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) return bound("stderr");
    stderr += chunk.toString("utf8");
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      finished = true;
      for (const t of timers) clearTimeout(t);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    // `close` fires only after stdio closes, so descendants holding pipes must be killed first.
    child.once("exit", () => {
      // Leader gone: reap any surviving group members so pipes can close.
      scheduleGroupKill();
      armForceSettle(KILL_GRACE_MS + 250);
    });
    // `close` fires after stdio closes; pending partial line is flushed first.
    child.once("close", (code) => {
      flushPending();
      settle(code);
    });
    const settle = (code: number | null) => {
      if (finished) return;
      cleanup();
      if (failure) return reject(new Error(failure.message));
      if (code !== 0) {
        const detail = stderr.trim();
        return reject(new Error(`OpenCode exited with status ${String(code)}${detail ? `: ${detail.slice(0, 500)}` : ""}`));
      }
      if (!text) return reject(new Error("OpenCode returned no final text"));
      details.sessionId = sessionId;
      details.usage = usage;
      resolve({ text, details });
    };
    forceSettle = () => settle(null);
  });
}

function accumulate(prev: OpenCodeUsage | undefined, next: OpenCodeUsage): OpenCodeUsage {
  if (!prev) return next;
  const add = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    input: add(prev.input, next.input),
    output: add(prev.output, next.output),
    reasoning: add(prev.reasoning, next.reasoning),
    cache: { read: add(prev.cache?.read, next.cache?.read), write: add(prev.cache?.write, next.cache?.write) },
    cost: add(prev.cost, next.cost),
  };
}
