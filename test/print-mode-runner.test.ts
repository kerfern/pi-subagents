/**
 * print-mode-runner.test.ts — guard behaviour of the headless test host.
 *
 * The host is shared by several e2e suites, so its cleanup guarantees are
 * worth pinning: a hook that resolves AFTER the wall-clock guard must not
 * drive a session that is already being torn down, and disposal must be
 * idempotent.
 */
import { describe, expect, it, vi } from "vitest";
import { runPrintMode } from "./helpers/print-mode-runner.js";

describe("print-mode runner guards", () => {
  it("does not prompt when the onBound hook resolves after the timeout", async () => {
    const respond = vi.fn(() => "should never be used");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompted: unknown[] = [];

    const running = runPrintMode({
      prompt: "hello",
      respond,
      live: false,
      timeoutMs: 1_000,
      onBound: async (handle) => {
        // Spy on the session the runner is about to prompt: the losing race arm
        // must not call it once the run has been torn down.
        const session = handle.session as unknown as {
          prompt: (...args: unknown[]) => unknown;
        };
        const original = session.prompt.bind(session);
        session.prompt = (...args: unknown[]) => {
          prompted.push(args);
          return original(...args);
        };
        await gate;
      },
    });

    await expect(running).rejects.toThrow(/timed out/);

    // The hook now resolves — after the run lost the race and was torn down.
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prompted).toEqual([]);
    expect(respond).not.toHaveBeenCalled();
  });

  it("disposes once, not twice", async () => {
    let shutdowns = 0;
    const run = await runPrintMode({
      prompt: "hello",
      respond: () => "done",
      live: false,
      timeoutMs: 30_000,
      onBound: (handle) => {
        const runner = handle.session.extensionRunner as unknown as {
          emit: (event: { type: string }) => Promise<unknown> | unknown;
        };
        const original = runner.emit.bind(runner);
        runner.emit = (event: { type: string }) => {
          if (event.type === "session_shutdown") shutdowns++;
          return original(event);
        };
      },
    });
    await run.dispose();
    await expect(run.dispose()).resolves.toBeUndefined();
    // The teardown ran exactly once: a second dispose must not re-emit the
    // shutdown that extensions use to release timers and child sessions.
    expect(shutdowns).toBe(1);
  });
});
