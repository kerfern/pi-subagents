import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInChildSessionContext } from "../src/child-context.js";
import registerDefault, { registerOpencodePoc } from "../src/opencode-poc.js";
import { OPENCODE_MODEL } from "../src/opencode-runner.js";

type Captured = { name: string; parameters: unknown; execute: (...args: any[]) => Promise<any> };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-poc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(opts: { isChild?: boolean } = {}) {
  let tool: Captured | undefined;
  const pi = { registerTool: vi.fn((t: Captured) => { tool = t; }) };
  const runTask = vi.fn(async () => ({ text: "done", details: { runtime: "opencode", model: OPENCODE_MODEL, cwd: dir, tools: [] } }));
  registerOpencodePoc(pi as any, { runTask, isChild: () => opts.isChild ?? false });
  return { pi, runTask, get tool() { return tool!; } };
}

function ctx(over: Partial<{ hasUI: boolean; mode: string; trusted: boolean; confirm: () => Promise<boolean> }> = {}) {
  return {
    cwd: dir,
    hasUI: over.hasUI ?? true,
    mode: over.mode ?? "tui",
    isProjectTrusted: () => over.trusted ?? true,
    ui: { confirm: vi.fn(over.confirm ?? (async () => true)) },
  };
}

describe("opencode_task registration", () => {
  it("default export registers the tool for explicit extension loading", () => {
    const pi = { registerTool: vi.fn() };
    registerDefault(pi as any);
    expect(pi.registerTool).toHaveBeenCalledTimes(1);
  });

  it("registers a single tool exposing only the prompt parameter", () => {
    const h = harness();
    expect(h.pi.registerTool).toHaveBeenCalledTimes(1);
    expect(h.tool.name).toBe("opencode_task");
    const props = (h.tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(["prompt"]);
    expect((h.tool.parameters as { additionalProperties: boolean }).additionalProperties).toBe(false);
  });

  it("does not register inside a child session context", () => {
    const h = harness({ isChild: true });
    expect(h.pi.registerTool).not.toHaveBeenCalled();
  });

  it("does not register inside the real child session context", async () => {
    let registered = false;
    await runInChildSessionContext(async () => {
      registerOpencodePoc({ registerTool: () => { registered = true; } } as any);
    });
    expect(registered).toBe(false);
  });

  it("fails closed at execute when running inside a child context", async () => {
    let child = false;
    let tool: Captured | undefined;
    const pi = { registerTool: (t: Captured) => { tool = t; } };
    const runTask = vi.fn();
    registerOpencodePoc(pi as any, { runTask, isChild: () => child });
    child = true;
    const result = await tool!.execute("id", { prompt: "hi" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(runTask).not.toHaveBeenCalled();
  });
});

describe("opencode_task approval and execution", () => {
  it("runs the task after approval with cwd and approval message details", async () => {
    const h = harness();
    const c = ctx();
    const result = await h.tool.execute("id", { prompt: "summarize" }, undefined, undefined, c);
    expect(c.ui.confirm).toHaveBeenCalledTimes(1);
    const [, message, opts] = c.ui.confirm.mock.calls[0] as unknown as [string, string, { timeout: number }];
    expect(message).toContain(OPENCODE_MODEL);
    expect(message).toContain("summarize");
    expect(message).toContain(dir);
    expect(message).toMatch(/runs separately with its own permissions/);
    expect(opts.timeout).toBe(120_000);
    expect(h.runTask).toHaveBeenCalledWith("summarize", expect.any(String), undefined, expect.any(Function));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("done");
  });

  it("does not spawn when the user denies", async () => {
    const h = harness();
    const result = await h.tool.execute("id", { prompt: "x" }, undefined, undefined, ctx({ confirm: async () => false }));
    expect(result.isError).toBe(true);
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("does not spawn when approval throws (timeout/cancel)", async () => {
    const h = harness();
    const result = await h.tool.execute("id", { prompt: "x" }, undefined, undefined, ctx({ confirm: async () => { throw new Error("timeout"); } }));
    expect(result.isError).toBe(true);
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("does not spawn without UI", async () => {
    const h = harness();
    const result = await h.tool.execute("id", { prompt: "x" }, undefined, undefined, ctx({ hasUI: false }));
    expect(result.isError).toBe(true);
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("does not spawn in non-TUI mode", async () => {
    const h = harness();
    const result = await h.tool.execute("id", { prompt: "x" }, undefined, undefined, ctx({ mode: "print" }));
    expect(result.isError).toBe(true);
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("does not spawn for an untrusted project", async () => {
    const h = harness();
    const result = await h.tool.execute("id", { prompt: "x" }, undefined, undefined, ctx({ trusted: false }));
    expect(result.isError).toBe(true);
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("does not spawn for an empty, whitespace, or NUL prompt", async () => {
    const h = harness();
    for (const prompt of ["", "   ", "a\0b", "x".repeat(16_385)]) {
      const result = await h.tool.execute("id", { prompt }, undefined, undefined, ctx());
      expect(result.isError).toBe(true);
    }
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("does not spawn when already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const result = await h.tool.execute("id", { prompt: "x" }, controller.signal, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(h.runTask).not.toHaveBeenCalled();
  });

  it("returns isError when the runner fails, without retry", async () => {
    const runTask = vi.fn(async () => { throw new Error("OpenCode exited with status 3"); });
    let tool: Captured | undefined;
    registerOpencodePoc({ registerTool: (t: Captured) => { tool = t; } } as any, { runTask, isChild: () => false });
    const result = await tool!.execute("id", { prompt: "x" }, undefined, undefined, ctx());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("status 3");
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("forwards only the prompt; no model, cwd, or binary override from params", async () => {
    const h = harness();
    await h.tool.execute("id", { prompt: "x", model: "evil", cwd: "/", binary: "sh" } as any, undefined, undefined, ctx());
    expect(h.runTask.mock.calls[0]?.[0]).toBe("x");
    expect(h.runTask.mock.calls[0]?.length).toBeLessThanOrEqual(4);
  });
});
