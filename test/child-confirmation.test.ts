import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildConfirmationBridge } from "../src/child-confirmation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeRoot(confirm: ExtensionUIContext["confirm"]): Pick<ExtensionContext, "hasUI" | "ui"> {
  return {
    hasUI: true,
    ui: {
      confirm,
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => () => {}),
      setStatus: vi.fn(),
      setWorkingMessage: vi.fn(),
      setWorkingVisible: vi.fn(),
      setWorkingIndicator: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      setWidget: vi.fn(),
      setFooter: vi.fn(),
      setHeader: vi.fn(),
      setTitle: vi.fn(),
      custom: vi.fn(async () => undefined),
      pasteToEditor: vi.fn(),
      setEditorText: vi.fn(),
      getEditorText: vi.fn(function (this: { marker: string }) { return this.marker; }),
      editor: vi.fn(async () => undefined),
      addAutocompleteProvider: vi.fn(),
      setEditorComponent: vi.fn(),
      getEditorComponent: vi.fn(),
      theme: {},
      getAllThemes: vi.fn(() => []),
      getTheme: vi.fn(() => undefined),
      setTheme: vi.fn(() => ({ success: false })),
    } as unknown as ExtensionUIContext,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChildConfirmationBridge", () => {
  it("attributes the full title, preserves the message, and approves only literal true", async () => {
    const confirm = vi.fn(async (_title: string, _message: string) => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("agent-7", "worker");
    binding.beginRun();

    const answer = await binding.uiContext!.confirm("Inspect /private", "Read the requested source?");

    expect(answer).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toBe("[Child name=worker; id=agent-7] Inspect /private");
    expect(confirm.mock.calls[0]![1]).toBe("Read the requested source?");
    bridge.dispose();
  });

  it("rejects truthy non-boolean native results", async () => {
    const confirm = vi.fn(async () => "yes" as unknown as boolean);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("agent-1", "reviewer");
    binding.beginRun();

    await expect(binding.uiContext!.confirm("Approve?", "Proceed?")).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    bridge.dispose();
  });

  it("forwards non-confirm methods with the native UI receiver", () => {
    const root = makeRoot(async () => true);
    (root.ui as unknown as { marker: string }).marker = "native receiver";
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("agent-1", "worker");
    binding.beginRun();

    expect(binding.uiContext!.getEditorText()).toBe("native receiver");
    bridge.dispose();
  });

  it("does not let children mutate the root native UI through the facade", async () => {
    const confirm = vi.fn(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("a", "worker");
    binding.beginRun();
    const facade = binding.uiContext!;
    const replacement = vi.fn(async () => true);

    expect(Reflect.set(facade, "confirm", replacement)).toBe(false);
    expect(root.ui.confirm).toBe(confirm);
    await expect(facade.confirm("approve", "message")).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("keeps native confirm descriptors inside the live lease", async () => {
    const confirm = vi.fn(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("agent-1", "worker");
    const facade = binding.uiContext!;
    const descriptorConfirm = Object.getOwnPropertyDescriptor(facade, "confirm")?.value as
      | ExtensionUIContext["confirm"]
      | undefined;
    const closeRun = binding.beginRun();
    closeRun();

    expect(descriptorConfirm).toBeTypeOf("function");
    await expect(descriptorConfirm!("Approve?", "Proceed?")).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("does not forward inherited Object methods with the native UI receiver", () => {
    const root = makeRoot(vi.fn(async () => true));
    const bridge = new ChildConfirmationBridge(() => root);
    const facade = bridge.forChild("agent-1", "worker").uiContext!;

    expect(Reflect.get(facade, "valueOf")).toBeUndefined();
    expect(Reflect.get(facade, "hasOwnProperty")).toBeUndefined();
    bridge.dispose();
  });

  it("serializes confirmations from different children in FIFO order", async () => {
    const first = deferred<boolean>();
    const confirm = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const a = bridge.forChild("a", "worker");
    const b = bridge.forChild("b", "reviewer");
    a.beginRun();
    b.beginRun();

    const answerA = a.uiContext!.confirm("First", "first message");
    const answerB = b.uiContext!.confirm("Second", "second message");
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);
    first.resolve(true);

    await expect(answerA).resolves.toBe(true);
    await expect(answerB).resolves.toBe(true);
    expect(confirm.mock.calls.map((call) => call[0])).toEqual([
      "[Child name=worker; id=a] First",
      "[Child name=reviewer; id=b] Second",
    ]);
    bridge.dispose();
  });

  it("settles an aborted visible request but keeps the native slot until its promise settles", async () => {
    const native = deferred<boolean>();
    const second = deferred<boolean>();
    const third = deferred<boolean>();
    const confirm = vi.fn()
      .mockImplementationOnce(() => native.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const a = bridge.forChild("a", "worker");
    const b = bridge.forChild("b", "worker");
    const c = bridge.forChild("c", "worker");
    const owner = new AbortController();
    a.beginRun(owner.signal);
    b.beginRun();
    c.beginRun();

    const answerA = a.uiContext!.confirm("First", "first", { timeout: 1000 });
    const answerB = b.uiContext!.confirm("Second", "second", { timeout: 1000 });
    await Promise.resolve();
    owner.abort();
    await expect(answerA).resolves.toBe(false);
    const answerC = c.uiContext!.confirm("Third", "third", { timeout: 1000 });
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);

    native.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(2);
    second.resolve(true);
    await expect(answerB).resolves.toBe(true);
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(3);
    third.resolve(true);
    await expect(answerC).resolves.toBe(true);
    bridge.dispose();
  });

  it("expires a queued request independently while a native dialog is stuck", async () => {
    vi.useFakeTimers();
    const native = deferred<boolean>();
    const confirm = vi.fn(async () => native.promise);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const a = bridge.forChild("a", "worker");
    const b = bridge.forChild("b", "worker");
    a.beginRun();
    b.beginRun();

    const answerA = a.uiContext!.confirm("First", "first");
    const answerB = b.uiContext!.confirm("Second", "second", { timeout: 10 });
    await vi.advanceTimersByTimeAsync(11);
    await expect(answerB).resolves.toBe(false);
    expect((bridge as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    expect(confirm).toHaveBeenCalledTimes(1);

    native.resolve(true);
    await answerA;
    bridge.dispose();
  });

  it("denies native approval past the monotonic deadline before timer callback runs", async () => {
    vi.useFakeTimers();
    let now = 100;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    const native = deferred<boolean>();
    const confirm = vi.fn(async () => native.promise);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("late", "worker");
    binding.beginRun();

    const answer = binding.uiContext!.confirm("Late", "message", { timeout: 10 });
    await Promise.resolve();
    now = 111;
    native.resolve(true);

    await expect(answer).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    bridge.dispose();
    nowSpy.mockRestore();
  });

  it("denies synchronous throws and rejected native dialogs", async () => {
    const confirm = vi.fn()
      .mockImplementationOnce(() => { throw new Error("UI failed"); })
      .mockRejectedValueOnce(new Error("dialog rejected"));
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("a", "worker");
    binding.beginRun();

    await expect(binding.uiContext!.confirm("one", "one")).resolves.toBe(false);
    await expect(binding.uiContext!.confirm("two", "two")).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
    bridge.dispose();
  });

  it("denies late approval after invalidation and blocks the next dialog until native settlement", async () => {
    const native = deferred<boolean>();
    const confirm = vi.fn()
      .mockImplementationOnce(() => native.promise)
      .mockImplementationOnce(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const oldBinding = bridge.forChild("old", "worker");
    oldBinding.beginRun();
    const oldAnswer = oldBinding.uiContext!.confirm("old", "old");
    await Promise.resolve();

    bridge.invalidate();
    await expect(oldAnswer).resolves.toBe(false);
    const fresh = bridge.forChild("fresh", "worker");
    fresh.beginRun();
    const freshAnswer = fresh.uiContext!.confirm("fresh", "fresh");
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(1);

    native.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    await expect(freshAnswer).resolves.toBe(true);
    expect(await oldAnswer).toBe(false);
    bridge.dispose();
  });

  it("keeps one facade across same-root resume and fences stale run closers", async () => {
    const root = makeRoot(async () => true);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("a", "worker");
    const firstFacade = binding.uiContext;
    const closeOld = binding.beginRun();
    const secondFacade = binding.uiContext;
    const closeCurrent = binding.beginRun();
    closeOld();

    expect(secondFacade).toBe(firstFacade);
    await expect(binding.uiContext!.confirm("current", "message")).resolves.toBe(true);
    closeCurrent();
    await expect(binding.uiContext!.confirm("closed", "message")).resolves.toBe(false);
    bridge.dispose();
  });

  it("permanently denies an old binding if the native root UI changes", async () => {
    let root = makeRoot(async () => true);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("old", "worker");
    binding.beginRun();
    const facade = binding.uiContext;
    root = makeRoot(async () => true);

    await expect(facade!.confirm("old", "message")).resolves.toBe(false);
    const fresh = bridge.forChild("new", "worker");
    fresh.beginRun();
    await expect(fresh.uiContext!.confirm("new", "message")).resolves.toBe(true);
    bridge.dispose();
  });

  it("keeps a pinned binding stale across root epochs until a fresh binding is issued", async () => {
    const confirm = vi.fn(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const stale = bridge.forChild("stale", "worker");
    stale.beginRun();
    const facade = stale.uiContext!;

    bridge.invalidate();
    stale.beginRun();
    expect(stale.uiContext).toBe(facade);
    await expect(facade.confirm("stale resume", "message")).resolves.toBe(false);

    const fresh = bridge.forChild("fresh", "worker");
    fresh.beginRun();
    await expect(fresh.uiContext!.confirm("fresh run", "message")).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    bridge.dispose();
  });

  it("pins headless mode on first UI access", async () => {
    let root: Pick<ExtensionContext, "hasUI" | "ui"> | undefined;
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("a", "worker");
    expect(binding.uiContext).toBeUndefined();
    root = makeRoot(async () => true);
    binding.beginRun();
    expect(binding.uiContext).toBeUndefined();
    bridge.dispose();
  });

  it("denies already-aborted owner and caller signals", async () => {
    const confirm = vi.fn(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const owner = new AbortController();
    owner.abort();
    const binding = bridge.forChild("a", "worker");
    binding.beginRun(owner.signal);
    await expect(binding.uiContext!.confirm("owner", "message")).resolves.toBe(false);

    const current = bridge.forChild("b", "worker");
    current.beginRun();
    const caller = new AbortController();
    caller.abort();
    await expect(current.uiContext!.confirm("caller", "message", { signal: caller.signal })).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("disposal is permanently fail-closed", async () => {
    const confirm = vi.fn(async () => true);
    const root = makeRoot(confirm);
    const bridge = new ChildConfirmationBridge(() => root);
    const binding = bridge.forChild("a", "worker");
    binding.beginRun();
    const facade = binding.uiContext!;
    bridge.dispose();
    binding.beginRun();
    await expect(facade.confirm("after dispose", "message")).resolves.toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
