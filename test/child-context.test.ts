import { describe, expect, it, vi } from "vitest";
import { inChildSessionContext, runInChildSessionContext } from "../src/child-context.js";
import subagentsExtension from "../src/index.js";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("shares the marker with a separately loaded copy of the module", async () => {
    // Two live copies (parent's package, another extension's copy) must agree on
    // the same storage, or a guard using one copy would miss a child from the other.
    const slot = (globalThis as any)[Symbol.for("pi-subagents.child-context.v1")];
    expect(slot?.storage).toBeDefined();
    await runInChildSessionContext(async () => {
      expect(slot.storage.getStore()).toBe(true);
    });
    expect(slot.storage.getStore()).toBeUndefined();
  });

  it("prevents a child resource load from creating another extension manager", async () => {
    const pi = new Proxy({}, {
      get: vi.fn(() => {
        throw new Error("child extension factory must be a no-op");
      }),
    });

    await runInChildSessionContext(async () => {
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    });
  });
});
