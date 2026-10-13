import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexCredential } from "../quota-guard/test/guard-fixtures.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import {
  quotaGuardControls,
  quotaGuardExtension,
  resetQuotaGuardStateForTest,
} from "../src/quota-guard/index.js";
import type { AgentConfig } from "../src/types.js";

// Exercise real SDK providers under CPU contention; a genuine hang still fails.
vi.setConfig({ testTimeout: 30_000 });

const pi = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
const Runtime = pi.ModelRuntime as
  | { create(options?: Record<string, unknown>): Promise<any>; prototype: object }
  | undefined;
const migrated = typeof Runtime?.create === "function";
const RuntimeClass = Runtime as NonNullable<typeof Runtime>;
const modelRegistryUrl = import.meta
  .resolve("@earendil-works/pi-coding-agent")
  .replace(/index\.js$/, "core/model-registry.js");

const CODEX_LIMITS = [{ id: "codex", windows: ["primary_window", "secondary_window"] }] as const;
const RESERVES = new Map([
  ["codex.primary_window", 3],
  ["codex.secondary_window", 3],
]);
const PROBE_MODEL = {
  id: "quota-guard-probe",
  name: "Quota guard probe",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_768,
  maxTokens: 128,
};

interface NetworkCounts {
  codexQuotaReads: number;
  commandCodeQuotaReads: number;
  codexModelRequests: number;
  commandCodeModelRequests: number;
}

function makeSse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function codexResponse(): Response {
  const item = {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "ok", annotations: [] }],
  };
  const response = {
    id: "resp_probe",
    status: "completed",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    { type: "response.created", response: { id: "resp_probe" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_probe", type: "message", role: "assistant", content: [] },
    },
    { type: "response.output_text.delta", output_index: 0, delta: "ok" },
    { type: "response.completed", response },
  ];
  return makeSse(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
}

function commandCodeResponse(): Response {
  const chunks = [
    {
      id: "chatcmpl_probe",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_probe",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
  return makeSse(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`);
}

function requestParts(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : undefined;
  const rawUrl = input instanceof URL ? input.href : typeof input === "string" ? input : request?.url;
  if (!rawUrl) throw new Error("Fake transport received an unreadable request URL");
  return {
    url: new URL(rawUrl),
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
  };
}

function makeNetwork() {
  const counts: NetworkCounts = {
    codexQuotaReads: 0,
    commandCodeQuotaReads: 0,
    codexModelRequests: 0,
    commandCodeModelRequests: 0,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const { url, method } = requestParts(input, init);
    if (method === "GET" && url.hostname === "chatgpt.com" && url.pathname.endsWith("/wham/usage")) {
      counts.codexQuotaReads++;
      const resetAt = Math.floor(Date.now() / 1000) + 3_600;
      return new Response(JSON.stringify({
        plan_type: "pro",
        credits: { balance: "90000", unlimited: true },
        rate_limit: {
          primary_window: { used_percent: 0, reset_at: resetAt, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 0, reset_at: resetAt + 3_600, limit_window_seconds: 604_800 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.hostname === "api.commandcode.ai"
      && url.pathname === "/alpha/billing/credits") {
      counts.commandCodeQuotaReads++;
      return new Response("unsupported quota endpoint", {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST" && url.hostname === "chatgpt.com") {
      counts.codexModelRequests++;
      return codexResponse();
    }
    if (method === "POST" && url.hostname === "api.commandcode.ai") {
      counts.commandCodeModelRequests++;
      return commandCodeResponse();
    }
    throw new Error(`Unexpected fake transport request: ${method} ${url.origin}${url.pathname}`);
  };
  return { counts, fetch };
}

const tempDirs: string[] = [];
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  resetQuotaGuardStateForTest();
  registerAgents(new Map());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function createFixture(guardedProviders: readonly ("openai-codex" | "commandcode")[]) {
  if (!migrated) throw new Error("ModelRuntime is unavailable on this Pi peer version");
  const dir = mkdtempSync(join(tmpdir(), "quota-subagent-runtime-"));
  tempDirs.push(dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("PI_OFFLINE", "1");

  const runtime = await RuntimeClass.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    apiKey: codexCredential("acct-test"),
    models: [PROBE_MODEL],
  });
  runtime.registerProvider("commandcode", {
    api: "openai-completions",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey: "test-commandcode-key",
    models: [PROBE_MODEL],
  });

  const { ModelRegistry } = (await import(modelRegistryUrl)) as {
    ModelRegistry: new (runtime: any) => { find(provider: string, modelId: string): any; runtime?: unknown };
  };
  const modelRegistry = new ModelRegistry(runtime);
  const prototype = Object.getPrototypeOf(runtime);
  expect(prototype).toBe(RuntimeClass.prototype);
  expect(Object.hasOwn(runtime, "stream")).toBe(false);
  expect(Object.hasOwn(runtime, "streamSimple")).toBe(false);
  expect((modelRegistry as { runtime?: unknown }).runtime).toBe(runtime);

  const network = makeNetwork();
  vi.stubGlobal("fetch", network.fetch);
  const host = {
    rootId: "quota-subagent-runtime-test",
    runtime: prototype,
    stateDir: join(dir, "guard-state"),
    codexLimits: CODEX_LIMITS,
    reserveUnits: RESERVES,
    fetchImpl: network.fetch,
  };
  quotaGuardExtension(host, {
    stateDir: host.stateDir,
    codexLimits: host.codexLimits,
    reserveUnits: host.reserveUnits,
    guardedProviders,
  });
  const controls = quotaGuardControls(prototype);
  if (!controls) throw new Error("Quota guard did not install on ModelRuntime.prototype");
  disposers.push(() => controls.dispose());

  const config: AgentConfig = {
    name: "Quota runtime probe",
    description: "Exercise the real inherited model runtime",
    builtinToolNames: [],
    extensions: false,
    skills: false,
    maxTurns: 1,
    systemPrompt: "",
    promptMode: "replace",
  };
  registerAgents(new Map([["quota-runtime-probe", config]]));
  const context = {
    cwd: dir,
    modelRegistry,
    getSystemPrompt: () => "Answer with the single word ok.",
  } as any;
  return { runtime, modelRegistry, controls, network, context };
}

async function runChild(fixture: Awaited<ReturnType<typeof createFixture>>, provider: string) {
  const model = fixture.modelRegistry.find(provider, "quota-guard-probe");
  if (!model) throw new Error(`Probe model was not registered for ${provider}`);
  return runAgent(fixture.context, "quota-runtime-probe" as any, "Reply now.", {
    pi: { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any,
    model,
  });
}

function modelFor(fixture: Awaited<ReturnType<typeof createFixture>>, provider: string) {
  const model = fixture.modelRegistry.find(provider, "quota-guard-probe");
  if (!model) throw new Error(`Probe model was not registered for ${provider}`);
  return model;
}

function sessionContext(session: any) {
  const messages = session.state?.messages;
  if (!Array.isArray(messages)) throw new Error("Real AgentSession did not expose its message context");
  return { systemPrompt: "Answer with the single word ok.", messages, tools: [] };
}

async function dispatchWithAbort(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  provider: string,
  context: unknown,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const stream = fixture.runtime.stream(modelFor(fixture, provider), context, {
      signal: controller.signal,
      maxRetries: 0,
    });
    return { result: await stream.result(), error: undefined };
  } catch (error) {
    return { result: undefined, error };
  } finally {
    clearTimeout(timer);
  }
}

function refused(dispatch: Awaited<ReturnType<typeof dispatchWithAbort>>): boolean {
  return dispatch.error !== undefined
    || (dispatch.result !== undefined && dispatch.result.stopReason !== "stop");
}

describe.skipIf(!migrated)("quota guard on inherited real ModelRuntime child dispatch", () => {
  it("guards Codex and leaves CommandCode OFF unguarded across run and resume", async () => {
    const fixture = await createFixture(["openai-codex"]);
    expect(fixture.controls.status().providers["openai-codex"].guard).toBe("guarded");
    expect(fixture.controls.status().providers.commandcode.guard).toBe("unguarded");

    const codex = await runChild(fixture, "openai-codex");
    expect(codex.failure).toBeUndefined();
    expect(codex.responseText).toBe("ok");
    expect((codex.session as any).modelRuntime).toBe(fixture.runtime);
    const codexResume = await resumeAgent(codex.session, "Reply once more.");
    expect(codexResume.failure).toBeUndefined();
    expect(codexResume.text).toBe("ok");

    const commandCode = await runChild(fixture, "commandcode");
    expect(commandCode.failure).toBeUndefined();
    expect(commandCode.responseText).toBe("ok");
    expect((commandCode.session as any).modelRuntime).toBe(fixture.runtime);
    const commandCodeResume = await resumeAgent(commandCode.session, "Reply once more.");
    expect(commandCodeResume.failure).toBeUndefined();
    expect(commandCodeResume.text).toBe("ok");

    expect(fixture.network.counts.codexModelRequests).toBeGreaterThanOrEqual(2);
    expect(fixture.network.counts.codexQuotaReads).toBe(fixture.network.counts.codexModelRequests);
    expect(fixture.network.counts.commandCodeQuotaReads).toBe(0);
    expect(fixture.network.counts.commandCodeModelRequests).toBeGreaterThanOrEqual(2);
  });

  it("keeps Codex available after an automatic CommandCode unsupported-quota refusal", async () => {
    const fixture = await createFixture(["openai-codex", "commandcode"]);
    const healthyCodex = await runChild(fixture, "openai-codex");
    expect(healthyCodex.failure).toBeUndefined();
    expect(healthyCodex.responseText).toBe("ok");

    const commandCode = await dispatchWithAbort(fixture, "commandcode", sessionContext(healthyCodex.session));
    expect(refused(commandCode)).toBe(true);
    expect(fixture.controls.status().providers.commandcode.unsupported).toBe(true);
    expect(fixture.network.counts.commandCodeQuotaReads).toBe(1);
    expect(fixture.network.counts.commandCodeModelRequests).toBe(0);

    const codex = await runChild(fixture, "openai-codex");
    expect(codex.failure).toBeUndefined();
    expect(codex.responseText).toBe("ok");
    expect(fixture.network.counts.codexModelRequests).toBeGreaterThanOrEqual(2);
    expect(fixture.network.counts.codexQuotaReads).toBe(fixture.network.counts.codexModelRequests);
  });

  it("applies targeted manual pause to an OFF provider without blocking its peer", async () => {
    const fixture = await createFixture(["openai-codex"]);
    fixture.controls.pause("commandcode");
    expect(fixture.controls.status().providers.commandcode.guard).toBe("unguarded");
    expect(fixture.controls.status().providers.commandcode.manualTarget).toBe("commandcode");

    expect(() => fixture.runtime.stream(
      modelFor(fixture, "commandcode"), {}, {},
    )).toThrow(/manually paused/i);
    expect(fixture.network.counts.commandCodeQuotaReads).toBe(0);
    expect(fixture.network.counts.commandCodeModelRequests).toBe(0);

    const codex = await runChild(fixture, "openai-codex");
    expect(codex.failure).toBeUndefined();
    expect(codex.responseText).toBe("ok");
    expect(fixture.network.counts.codexModelRequests).toBeGreaterThanOrEqual(1);
    expect(fixture.network.counts.codexQuotaReads).toBe(fixture.network.counts.codexModelRequests);
  });

  it("pause-all holds the guarded child dispatch and the OFF-provider passthrough", async () => {
    const fixture = await createFixture(["openai-codex"]);
    const healthyCodex = await runChild(fixture, "openai-codex");
    expect(healthyCodex.failure).toBeUndefined();
    const baseline = { ...fixture.network.counts };
    const context = sessionContext(healthyCodex.session);

    fixture.controls.pause();
    expect(fixture.controls.status().providers["openai-codex"].manualTarget).toBe("all");
    expect(fixture.controls.status().providers.commandcode.manualTarget).toBe("all");

    const codex = await dispatchWithAbort(fixture, "openai-codex", context);
    expect(refused(codex)).toBe(true);
    expect(() => fixture.runtime.stream(modelFor(fixture, "commandcode"), context, {}))
      .toThrow(/manually paused/i);
    expect(fixture.network.counts.codexQuotaReads).toBe(baseline.codexQuotaReads);
    expect(fixture.network.counts.codexModelRequests).toBe(baseline.codexModelRequests);
    expect(fixture.network.counts.commandCodeQuotaReads).toBe(baseline.commandCodeQuotaReads);
    expect(fixture.network.counts.commandCodeModelRequests).toBe(baseline.commandCodeModelRequests);
  });
});
