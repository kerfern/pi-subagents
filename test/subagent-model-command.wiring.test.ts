/**
 * subagent-model-command.wiring.test.ts — `/subagent-model` and its alias.
 *
 * The route itself (catalog validation, the fallback leg, the latch) is covered
 * in test/subagent-model-routing.test.ts against the manager. What is untested
 * until here is the surface a user drives: that both command names reach ONE
 * handler, that an exact argument is persisted as a session entry, that an
 * unusable argument is refused rather than stored, and that the status line
 * reports what the route will actually use.
 */

import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

const FAUX = { provider: "faux", id: "faux-1" };
const ROUTING_KEY = "subagent";
/**
 * Two providers serving the SAME model id — the case that makes a bare "luna"
 * query ambiguous, and the one a person hits by typing `codex/...` for
 * `openai-codex/...`.
 */
const LUNA = [
  { provider: "commandcode", id: "gpt-5.6-luna" },
  { provider: "openai-codex", id: "gpt-5.6-luna" },
];

function boot() {
  const booted = makePi();
  subagentsExtension(booted.pi);
  return booted;
}

function commandCtx(overrides: Record<string, unknown> = {}) {
  const notes: { text: string; level?: string }[] = [];
  const statuses: { key: string; text: string }[] = [];
  const context = ctx({
    hasUI: true,
    ui: {
      notify: vi.fn((text: string, level?: string) => notes.push({ text, level })),
      setStatus: vi.fn((key: string, text: string) => statuses.push({ key, text })),
      // The fleet list subscribes to terminal input the moment it is handed a
      // UI context, so a session_start test needs the subscription, not just notify.
      onTerminalInput: vi.fn(() => vi.fn()),
      addAutocompleteProvider: vi.fn(),
      setWidget: vi.fn(),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
      select: vi.fn(async () => undefined),
    },
    scopedModels: [],
    modelRegistry: {
      find: vi.fn((provider: string, id: string) =>
        provider === FAUX.provider && id === FAUX.id ? FAUX : undefined),
      getAll: vi.fn(() => [FAUX]),
      getAvailable: vi.fn(() => [FAUX]),
    },
    ...overrides,
  });
  return { context, notes, statuses };
}

const entryWrites = (pi: any) =>
  (pi.appendEntry as any).mock.calls.filter((call: unknown[]) => call[0] === "subagent-model-state");

let hermetic: Hermetic | undefined;

beforeEach(() => {
  hermetic = hermeticDir();
});

afterEach(() => {
  hermetic?.restore();
  hermetic = undefined;
});

describe("/subagent-model", () => {
  it("registers the canonical command and the implementer-model alias on one handler", () => {
    const booted = boot();
    const canonical = booted.commands.get("subagent-model");
    const alias = booted.commands.get("implementer-model");
    expect(canonical).toBeDefined();
    expect(alias).toBeDefined();
    // One handler, so the alias cannot drift from the canonical command.
    expect(alias.handler).toBe(canonical.handler);
  });

  it("persists an exact provider/model argument as a routing session entry", async () => {
    const booted = boot();
    const { context, notes } = commandCtx();
    await booted.commands.get("subagent-model").handler("faux/faux-1", context);

    expect(entryWrites(booted.pi)).toEqual([[
      "subagent-model-state",
      {
        provider: "faux",
        model: "faux-1",
        reviewerProvider: "faux",
        reviewerModel: "faux-1",
      },
    ]]);
    expect(notes.at(-1)).toEqual({
      text: "Subagent models set: reviewer=faux/faux-1, others=faux/faux-1.",
      level: "info",
    });
  });

  it("refuses an unknown or unavailable model without writing state", async () => {
    const booted = boot();
    const { context, notes } = commandCtx();
    await booted.commands.get("subagent-model").handler("faux/nope", context);

    expect(entryWrites(booted.pi)).toEqual([]);
    expect(notes.at(-1)?.level).toBe("warning");
    expect(notes.at(-1)?.text).toContain('Unknown or unavailable model "faux/nope"');
  });

  it("names the near misses when the argument is not a catalog key", async () => {
    const booted = boot();
    // The provider is `openai-codex`; `codex/...` is what a person types.
    const { context, notes } = commandCtx({
      modelRegistry: {
        find: vi.fn(),
        getAll: vi.fn(() => LUNA),
        getAvailable: vi.fn(() => LUNA),
      },
    });
    await booted.commands.get("subagent-model").handler("codex/gpt-5.6-luna", context);

    expect(entryWrites(booted.pi)).toEqual([]);
    expect(notes.at(-1)?.text).toContain("openai-codex/gpt-5.6-luna");
    expect(notes.at(-1)?.text).not.toContain("commandcode/gpt-5.6-luna");
  });

  it("refuses a fuzzy name, because the route is an exact identity", async () => {
    const booted = boot();
    const { context } = commandCtx();
    await booted.commands.get("subagent-model").handler("faux-1", context);
    expect(entryWrites(booted.pi)).toEqual([]);
  });

  it("requires an exact argument when there is no picker UI", async () => {
    const booted = boot();
    const { context, notes } = commandCtx({ hasUI: false });
    await booted.commands.get("subagent-model").handler("", context);

    expect(entryWrites(booted.pi)).toEqual([]);
    expect(notes.at(-1)?.level).toBe("warning");
    expect(notes.at(-1)?.text).toContain("exact provider/model argument is required");
  });

  it("reports the selected model on the status line", async () => {
    const booted = boot();
    const { context, statuses } = commandCtx();
    await booted.commands.get("subagent-model").handler("faux/faux-1", context);

    expect(statuses.at(-1)).toEqual({
      key: ROUTING_KEY,
      text: "🧿: faux/faux-1 | 👷🏻‍♂️: faux/faux-1",
    });
  });
});

describe("the /subagent-model picker", () => {
  const DOWN = "\x1b[B";
  const ENTER = "\r";

  /** Holds the picker component open and hands out its input stream. */
  function picker(
    models: { provider: string; id: string }[] = LUNA,
    thinkingChoices: string[] = ["off", "off"],
  ) {
    let instance: { handleInput: (data: string) => void } | undefined;
    const build = (factory: unknown, done: (value: string | null) => void) => {
      instance = (
        factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          finish: (value: string | null) => void,
        ) => { handleInput: (data: string) => void }
      )(
        { requestRender: vi.fn() },
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
        new KeybindingsManager(TUI_KEYBINDINGS, {}),
        done,
      );
    };
    const context = ctx({
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        custom: vi.fn((factory: unknown) =>
          new Promise((resolve) => { build(factory, resolve as (value: string | null) => void); })),
        select: vi.fn(async () => thinkingChoices.shift()),
      },
      scopedModels: [],
      modelRegistry: {
        find: vi.fn((provider: string, id: string) =>
          models.find(model => model.provider === provider && model.id === id)),
        getAll: vi.fn(() => models),
        getAvailable: vi.fn(() => models),
      },
    });
    return { context, send: (data: string) => instance?.handleInput(data) };
  }

  it("takes the row the arrow keys moved to, not the top fuzzy match", async () => {
    const booted = boot();
    const { context, send } = picker(LUNA, ["high", "minimal"]);

    const pending = booted.commands.get("subagent-model").handler("", context);
    // "luna" matches both rows; the shorter key (commandcode) sorts first, so
    // only honouring ↓ can reach the codex entry the user moved down to.
    for (const char of "luna") send(char);
    send(DOWN);
    send(ENTER);
    // Series: reviewer model → reviewer thinking → other model → other thinking.
    await new Promise(resolve => setTimeout(resolve, 0));
    send(ENTER);
    await new Promise(resolve => setTimeout(resolve, 0));
    send(ENTER);
    await pending;

    expect(entryWrites(booted.pi)).toEqual([[
      "subagent-model-state",
      {
        provider: "commandcode",
        model: "gpt-5.6-luna",
        reviewerProvider: "openai-codex",
        reviewerModel: "gpt-5.6-luna",
        thinking: "minimal",
        reviewerThinking: "high",
      },
    ]]);
  });

  it("still picks the top match when no arrow key is pressed", async () => {
    const booted = boot();
    const { context, send } = picker(LUNA, ["off", "off"]);

    const pending = booted.commands.get("subagent-model").handler("", context);
    for (const char of "luna") send(char);
    send(ENTER);
    // Reviewer first; choose same top match for shared agents in second prompt.
    await new Promise(resolve => setTimeout(resolve, 0));
    send(ENTER);
    await new Promise(resolve => setTimeout(resolve, 0));
    send(ENTER);
    await pending;

    expect(entryWrites(booted.pi)).toEqual([[
      "subagent-model-state",
      {
        provider: "commandcode",
        model: "gpt-5.6-luna",
        reviewerProvider: "commandcode",
        reviewerModel: "gpt-5.6-luna",
        thinking: "off",
        reviewerThinking: "off",
      },
    ]]);
  });
});

describe("the Agent tool under a live route", () => {
  // vitest.config turns routing off process-wide; this block turns it back on so
  // the refusal happens at the real tool boundary, before any session starts.
  beforeEach(() => {
    delete process.env.PI_SUBAGENTS_MODEL_ROUTING;
  });
  afterEach(() => {
    process.env.PI_SUBAGENTS_MODEL_ROUTING = "off";
  });

  function agentCtx(
    models: { provider: string; id: string }[],
    branch: unknown[] = [],
  ) {
    return commandCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "s1"),
        getBranch: vi.fn(() => branch),
      },
      modelRegistry: {
        find: vi.fn((provider: string, id: string) =>
          models.find(model => model.provider === provider && model.id === id)),
        getAll: vi.fn(() => models),
        getAvailable: vi.fn(() => models),
      },
    }).context;
  }

  it("refuses a per-call model override that the route cannot honour", async () => {
    const booted = boot();
    const execute = booted.tools.get("Agent").execute;
    await expect(execute(
      "tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose", model: "faux/faux-1" },
      undefined,
      undefined,
      agentCtx([
        FAUX,
        { provider: "openai-codex", id: "gpt-5.6-luna" },
        { provider: "openai-codex", id: "gpt-5.6-sol" },
      ]),
    )).rejects.toThrow(/override/i);
  });

  it("refuses a per-call thinking override that conflicts with the route", async () => {
    const booted = boot();
    const models = [
      FAUX,
      { provider: "openai-codex", id: "gpt-5.6-luna" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "openrouter", id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
    ];
    const context = agentCtx(models, [{
      type: "custom",
      customType: "subagent-model-state",
      data: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        reviewerProvider: "openai-codex",
        reviewerModel: "gpt-5.6-sol",
        thinking: "high",
        reviewerThinking: "medium",
      },
    }]);
    await booted.lifecycle.get("session_start")({}, context);

    await expect(booted.tools.get("Agent").execute(
      "tc",
      {
        prompt: "go",
        description: "d",
        subagent_type: "general-purpose",
        thinking: "medium",
        run_in_background: false,
      },
      undefined,
      undefined,
      context,
    )).rejects.toThrow(/Thinking override "medium" is refused.*routes general-purpose to high/i);
  });

  it("refuses the dispatch, before running anything, when the route's model is unavailable", async () => {
    const booted = boot();
    const execute = booted.tools.get("Agent").execute;
    await expect(execute(
      "tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined,
      undefined,
      agentCtx([FAUX]),
    )).rejects.toThrow(/unavailable/i);
  });
});

describe("routing restore on session start", () => {
  it("reports a stored selection the catalog still serves", async () => {
    const booted = boot();
    const { context, statuses } = commandCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "s1"),
        getBranch: vi.fn(() => [
          { type: "custom", customType: "subagent-model-state", data: { provider: "faux", model: "faux-1" } },
        ]),
      },
    });
    await booted.lifecycle.get("session_start")({}, context);

    expect(statuses.at(-1)).toEqual({
      key: ROUTING_KEY,
      text: "🧿: faux/faux-1 | 👷🏻‍♂️: faux/faux-1",
    });
  });

  it("falls back to the default and warns when the stored selection is gone", async () => {
    const booted = boot();
    const { context, notes, statuses } = commandCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "s1"),
        getBranch: vi.fn(() => [
          { type: "custom", customType: "subagent-model-state", data: { provider: "gone", model: "x" } },
        ]),
      },
    });
    await booted.lifecycle.get("session_start")({}, context);

    expect(statuses.at(-1)).toEqual({
      key: ROUTING_KEY,
      text: "🧿: openai-codex/gpt-5.6-sol | 👷🏻‍♂️: openai-codex/gpt-5.6-luna",
    });
    expect(notes.some(note => note.level === "warning" && note.text.includes("gone/x"))).toBe(true);
  });

  it("migrates a legacy implementer-model entry into the new entry type", async () => {
    const booted = boot();
    const { context } = commandCtx({
      sessionManager: {
        getSessionId: vi.fn(() => "s1"),
        getBranch: vi.fn(() => [
          { type: "custom", customType: "implementer-model-state", data: { provider: "faux", model: "faux-1" } },
        ]),
      },
    });
    await booted.lifecycle.get("session_start")({}, context);

    expect(entryWrites(booted.pi)).toEqual([[
      "subagent-model-state",
      {
        provider: "faux",
        model: "faux-1",
        reviewerProvider: "faux",
        reviewerModel: "faux-1",
      },
    ]]);
  });
});
