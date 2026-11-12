import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPENCODE_MODEL, runOpenCodeTask } from "../src/opencode-runner.js";

const fixture = join(__dirname, "fixtures", "fake-opencode.mjs");
const isPosix = process.platform !== "win32";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-runner-"));
  chmodSync(fixture, 0o755);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeBinary(mode = "success", extra: Record<string, string> = {}, argvFile = join(dir, "argv.json")): string {
  const wrapper = join(dir, "opencode");
  // The runner allowlists env, so fixture controls are baked into the wrapper script.
  const vars = { FAKE_MODE: mode, ARGV_FILE: argvFile, ...extra };
  const exports = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join(" ");
  writeFileSync(wrapper, `#!/bin/sh\n${exports} exec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}
function runWith(mode: string, extraEnv: Record<string, string> = {}, opts: { timeoutMs?: number; signal?: AbortSignal; binary?: string } = {}) {
  const argvFile = join(dir, "argv.json");
  const promise = runOpenCodeTask("hi there", dir, opts.signal, undefined, {
    binaryPath: opts.binary ?? fakeBinary(mode, extraEnv, argvFile),
    env: { PATH: process.env.PATH ?? "" },
    timeoutMs: opts.timeoutMs,
  });
  return { argvFile, promise };
}

describe.skipIf(!isPosix)("runOpenCodeTask", () => {
  it("spawns exact argv with pinned model and no shell", async () => {
    const { argvFile, promise } = runWith("success");
    const result = await promise;
    const recorded = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(recorded.argv).toEqual(["--standalone", "run", "--model", OPENCODE_MODEL, "--format", "json", "--archived", "Task:\nhi there"]);
    expect(recorded.cwd).toBe(realpathSync(dir));
    expect(result.text).toBe("Hello world");
  });

  it("aggregates usage and cost from step_finish, sums across steps", async () => {
    const { promise } = runWith("success");
    const { details } = await promise;
    expect(details.usage).toEqual({ input: 14, output: 7, reasoning: 1, cache: { read: 2, write: 3 }, cost: 0.012 });
    expect(details.tools).toEqual([{ name: "bash", status: "completed" }]);
    expect(details.sessionId).toBe("ses_1");
    expect(details.model).toBe(OPENCODE_MODEL);
  });

  it("emits accumulated text snapshots through onUpdate", async () => {
    const updates: string[] = [];
    await runOpenCodeTask("hi", dir, undefined, (t) => updates.push(t), {
      binaryPath: fakeBinary("success"),
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(updates).toEqual(["Hello ", "Hello world"]);
  });

  it("fails closed when the update callback throws", async () => {
    await expect(
      runOpenCodeTask("hi", dir, undefined, () => { throw new Error("update boom"); }, {
        binaryPath: fakeBinary("success"),
        env: { PATH: process.env.PATH ?? "" },
      }),
    ).rejects.toThrow("update boom");
  });

  it("leaves usage unknown (not zero) when step_finish is absent", async () => {
    const { promise } = runWith("missing-usage");
    const { details, text } = await promise;
    expect(text).toBe("ok");
    expect(details.usage).toBeUndefined();
  });

  it("fails on malformed JSONL", async () => {
    await expect(runWith("malformed").promise).rejects.toThrow("malformed JSONL");
  });

  it("fails on a structurally malformed event envelope", async () => {
    await expect(runWith("malformed-envelope").promise).rejects.toThrow("malformed event envelope");
  });

  it("fails on an event without a type", async () => {
    await expect(runWith("missing-type").promise).rejects.toThrow("without a type");
  });

  it("fails on a null event envelope", async () => {
    await expect(runWith("null-envelope").promise).rejects.toThrow("malformed event envelope");
  });

  it("fails on a malformed event part", async () => {
    await expect(runWith("malformed-part").promise).rejects.toThrow("malformed event part");
  });

  it("fails closed when aggregate stdout exceeds the bound", async () => {
    await expect(runWith("stdout-flood").promise).rejects.toThrow("exceeded output bound");
  });

  it("fails on OpenCode error events, surfacing provider detail", async () => {
    await expect(runWith("error-event").promise).rejects.toThrow(
      /error event: provider\.rate-limit: The inference service is overloaded.*\(status 429\)/,
    );
  });

  it("still fails on an OpenCode error event with no detail", async () => {
    await expect(runWith("error-event-bare").promise).rejects.toThrow("error event: no detail");
  });

  it("fails on contradictory model identity", async () => {
    await expect(runWith("wrong-model").promise).rejects.toThrow("model identity");
  });

  it("fails on nonzero exit with stderr detail", async () => {
    await expect(runWith("nonzero").promise).rejects.toThrow(/status 3.*boom from fake/s);
  });

  it("fails when final text is missing", async () => {
    await expect(runWith("missing-text").promise).rejects.toThrow("no final text");
  });

  it("fails closed on missing executable without fallback", async () => {
    await expect(runOpenCodeTask("hi", dir, undefined, undefined, { binaryPath: join(dir, "nope"), env: { PATH: "" } })).rejects.toThrow();
  });

  it("fails closed when a JSONL line exceeds 256 KiB", async () => {
    await expect(runWith("long-line").promise).rejects.toThrow("exceeded output bound");
  });

  it("fails closed when final text exceeds 64 KiB (no truncation)", async () => {
    await expect(runWith("huge-text").promise).rejects.toThrow("exceeded output bound");
  });

  it("fails closed when stderr exceeds bound", async () => {
    await expect(runWith("stderr-flood").promise).rejects.toThrow("exceeded output bound");
  });

  it("times out, kills the process group, and reports timeout", async () => {
    await expect(runWith("hang", {}, { timeoutMs: 300 }).promise).rejects.toThrow("timed out");
  });

  it("aborts on signal and kills the process group", async () => {
    const controller = new AbortController();
    const { promise } = runWith("hang", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    await expect(promise).rejects.toThrow("aborted");
  });

  it("kills a SIGTERM-resistant descendant after the leader is gone", async () => {
    const pidFile = join(dir, "child.pid");
    const { promise } = runWith("sigterm-resistant", { CHILD_PIDFILE: pidFile }, { timeoutMs: 300 });
    await expect(promise).rejects.toThrow("timed out");
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(pid)).toBe(false);
  });

  it("fails closed when an escaped descendant keeps stdio open", async () => {
    const pidFile = join(dir, "child.pid");
    const { promise } = runWith("leader-exit-with-child", { CHILD_PIDFILE: pidFile });
    // Leader exits 0 with text; a detached, SIGTERM-resistant sleeper keeps the pipes open.
    let pid: number | undefined;
    try {
      await expect(promise).rejects.toThrow("did not close");
    } finally {
      if (existsSync(pidFile)) {
        pid = Number(readFileSync(pidFile, "utf8"));
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(pid).toBeDefined();
    expect(alive(pid!)).toBe(false);
  });

  it("reaps an in-group descendant when the leader exits first", async () => {
    const pidFile = join(dir, "child.pid");
    const { promise } = runWith("leader-exit-in-group-child", { CHILD_PIDFILE: pidFile });
    const result = await promise;
    expect(result.text).toBe("partial");
    const pid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(pid)).toBe(false);
  });

  it("rejects an empty or NUL prompt before spawning", async () => {
    await expect(runOpenCodeTask("   ", dir, undefined, undefined, { binaryPath: fakeBinary() })).rejects.toThrow("Prompt");
    await expect(runOpenCodeTask("a\0b", dir, undefined, undefined, { binaryPath: fakeBinary() })).rejects.toThrow("Prompt");
  });

  it("passes only allowlisted environment keys to the child", async () => {
    const argvFile = join(dir, "argv.json");
    await runOpenCodeTask("hi", dir, undefined, undefined, {
      binaryPath: fakeBinary("success"),
      env: { PATH: process.env.PATH ?? "", SECRET_TOKEN: "x", OPENCODE_CONFIG: "y" },
    });
    const { envKeys } = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(envKeys).not.toContain("SECRET_TOKEN");
    expect(envKeys).toContain("OPENCODE_CONFIG");
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runner platform guard", () => {
  it("ships the fake executable fixture", () => {
    expect(existsSync(fixture)).toBe(true);
  });
});
