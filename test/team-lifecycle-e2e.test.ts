/**
 * team-lifecycle-e2e.test.ts — concurrency and cancellation through the REAL
 * extension: real `runAgent`, real child `bash` tool calls, faux model seats.
 *
 * Children write timestamped markers through the real bash tool; those markers
 * are an independent record of what actually ran concurrently.
 *
 * Faux and hermetic: no network, no paid calls, temp project dirs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCall, isSubagentContext, type PrintModeRun, runPrintMode } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

interface Marker {
  kind: "start" | "end";
  name: string;
  at: number;
}

/** Read `start:<name>:<ms>` / `end:<name>:<ms>` lines the children wrote. */
function readMarkers(file: string): Marker[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [kind, name, at] = line.split(":");
      return { kind: kind as "start" | "end", name, at: Number(at) };
    });
}

/** Largest number of intervals open at the same instant. */
function peakOverlap(markers: Marker[]): number {
  const events = markers
    .map((m) => ({ at: m.at, delta: m.kind === "start" ? 1 : -1 }))
    // Ends sort before starts at the same instant: back-to-back is not overlap.
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let open = 0;
  let peak = 0;
  for (const e of events) {
    open += e.delta;
    peak = Math.max(peak, open);
  }
  return peak;
}

/** The child's own prompt — the last user message in its context. */
function childPrompt(messages: unknown[]): string {
  const users = messages.filter((m) => (m as { role?: string }).role === "user") as Array<{ content?: unknown }>;
  const content = users[users.length - 1]?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
  }
  return "";
}

/** Whether the child already has a bash result — its command ran, so finish. */
function bashAlreadyRan(messages: unknown[]): boolean {
  return messages.some(
    (m) => (m as { role?: string; toolName?: string }).role === "toolResult" &&
      (m as { toolName?: string }).toolName === "bash",
  );
}

/** Timestamped start/end markers around a real sleep. */
function markedCommand(file: string, name: string, seconds: number): string {
  return `echo "start:${name}:$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')" >> ${file}; sleep ${seconds}; echo "end:${name}:$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')" >> ${file}`;
}

describe("team lifecycle through the real extension", () => {
  let run: PrintModeRun | undefined;
  const dirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function projectDir(settings: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "team-lifecycle-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ outputTranscript: false, ...settings }));
    return dir;
  }

  it("never runs more than maxConcurrent background workers at once", async () => {
    const cap = 3;
    const names = Array.from({ length: 6 }, (_, i) => `w${i}`);
    const dir = projectDir({ maxConcurrent: cap });
    const markers = join(dir, "markers.log");

    run = await runPrintMode({
      prompt: "fan out",
      cwd: dir,
      timeoutMs: 45_000,
      respond: (context, state) => {
        if (isSubagentContext(context)) {
          if (bashAlreadyRan(context.messages)) return "worker finished";
          return fauxToolCall("bash", { command: markedCommand(markers, childPrompt(context.messages), 0.4) });
        }
        if (state.callCount === 1) {
          return names.map((name) =>
            agentCall({ prompt: name, description: name, run_in_background: true }, { id: `call-${name}` }),
          ) as never;
        }
        return "All workers done.";
      },
    });

    const observed = readMarkers(markers);
    expect(observed.filter((m) => m.kind === "start").map((m) => m.name).sort()).toEqual([...names].sort());
    expect(observed.filter((m) => m.kind === "end")).toHaveLength(names.length);
    const peak = peakOverlap(observed);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(cap);
  });

  it("serializes foreground children when maxConcurrentForeground is 1", async () => {
    const dir = projectDir({ maxConcurrentForeground: 1 });
    const markers = join(dir, "markers.log");

    run = await runPrintMode({
      prompt: "two blocking",
      cwd: dir,
      timeoutMs: 45_000,
      respond: (context, state) => {
        if (isSubagentContext(context)) {
          if (bashAlreadyRan(context.messages)) return "done";
          return fauxToolCall("bash", { command: markedCommand(markers, childPrompt(context.messages), 0.3) });
        }
        if (state.callCount === 1) {
          return [
            agentCall({ prompt: "fg-a", description: "fg-a", run_in_background: false }, { id: "call-fg-a" }),
            agentCall({ prompt: "fg-b", description: "fg-b", run_in_background: false }, { id: "call-fg-b" }),
          ] as never;
        }
        return "both done";
      },
    });

    const observed = readMarkers(markers);
    expect(observed.filter((m) => m.kind === "start")).toHaveLength(2);
    expect(peakOverlap(observed)).toBe(1);
  });

  it("cancels a child mid-bash: stop halts the model loop, in-flight bash completes", async () => {
    const dir = projectDir({ maxConcurrent: 1 });
    const sentinel = join(dir, "sentinel.txt");
    const markers = join(dir, "markers.log");

    run = await runPrintMode({
      prompt: "cancel then reuse",
      cwd: dir,
      timeoutMs: 45_000,
      respond: (context, state) => {
        if (isSubagentContext(context)) {
          if (childPrompt(context.messages) === "victim") {
            if (bashAlreadyRan(context.messages)) return "unreachable";
            // Marks its start, then writes the sentinel only if never stopped.
            return fauxToolCall("bash", {
              command: `echo "start:victim:$(perl -MTime::HiRes=time -e 'printf "%d", time()*1000')" >> ${markers}; sleep 2; echo ran > ${sentinel}`,
            });
          }
          return "replacement finished";
        }
        if (state.callCount === 1) {
          return [agentCall({ prompt: "victim", description: "victim", run_in_background: true }, { id: "call-victim" })] as never;
        }
        if (state.callCount === 2) {
          return [fauxToolCall("stop_subagent", { agent_id: "victim" }, { id: "call-stop" })] as never;
        }
        return "stopped";
      },
    });

    // Wait past the victim's 2s sleep so a late write would be visible.
    await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    const victimStarts = readMarkers(markers).filter((m) => m.name === "victim" && m.kind === "start");
    expect(victimStarts).toHaveLength(1); // victim really was mid-bash when stopped
    // An in-flight bash command is NOT killed by stop (observed: sentinel written).
    // Pinned as current behavior; not a fence this step owns.
    expect(existsSync(sentinel)).toBe(true);
  });

  it("refuses a second nested child when maxConcurrentNested is 1", async () => {
    const dir = projectDir({ maxConcurrentNested: 1 });
    // An orchestrator opted into nesting, allowed to spawn `worker` only.
    const agents = join(dir, ".pi", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "orchestrator.md"),
      "---\ndescription: Delegating orchestrator\ntools: read\nextensions: false\nallowed_subagents: worker\n---\nDelegate to worker.\n",
    );
    writeFileSync(join(agents, "worker.md"), "---\ndescription: Leaf worker\ntools: read\nextensions: false\n---\nDo the work.\n");
    const markers = join(dir, "markers.log");
    let orchResults = "";

    run = await runPrintMode({
      prompt: "nested overflow",
      cwd: dir,
      timeoutMs: 45_000,
      respond: (context, state) => {
        const messages = context.messages as Array<{ role?: string; toolName?: string; content?: unknown }>;
        if (isSubagentContext(context)) {
          const text = childPrompt(context.messages);
          if (text === "outer") {
            // Orchestrator: fan out two nested children in one turn.
            const spawned = messages.some((m) => m.role === "toolResult" && m.toolName === "Agent");
            if (spawned) { orchResults = JSON.stringify(messages.filter((m) => m.role === "toolResult").map((m) => m.content)); return "orchestrator done"; }
            return [
              agentCall({ subagent_type: "worker", prompt: "inner-a", description: "inner-a", run_in_background: false }, { id: "call-inner-a" }),
              agentCall({ subagent_type: "worker", prompt: "inner-b", description: "inner-b", run_in_background: false }, { id: "call-inner-b" }),
            ] as never;
          }
          if (bashAlreadyRan(context.messages)) return "worker done";
          return fauxToolCall("bash", { command: markedCommand(markers, text, 0.3) });
        }
        if (state.callCount === 1) {
          return [agentCall({ subagent_type: "orchestrator", prompt: "outer", description: "outer", run_in_background: false }, { id: "call-outer" })] as never;
        }
        return "parent done";
      },
    });

    expect(peakOverlap(readMarkers(markers))).toBeLessThanOrEqual(1);
    // The second nested spawn is refused, with the documented message, in the orchestrator's context.
    expect(orchResults).toContain("Concurrent nested subagent limit reached. You can run 1 nested subagents at once. Do not retry.");
    expect(orchResults).toContain("worker done");
  });
});
