import assert from 'node:assert/strict';
import { after, test } from 'node:test';
// @ts-expect-error check-host.mjs is an executable JS harness; keep this test scoped to two files.
import { loadHostContractModules, resolveHost, runChecks, withBlockedGlobalFetch } from '../check-host.mjs';
import { installQuotaGuard, type GatedCoordinator, type GuardRuntime } from '../../src/quota-guard/root.ts';
import type { AttemptScope } from '../../src/quota-guard/coordinator.ts';

type AdapterStream = (...args: unknown[]) => AsyncIterable<unknown>;
interface ResolvedHost {
  root: string;
  piAiRoot: string;
  source: 'explicit' | 'global' | 'local';
}
interface HostContractModules {
  host: ResolvedHost;
  ModelRuntime: { prototype: GuardRuntime };
  completions: AdapterStream;
  codex: AdapterStream;
}

const originalGlobalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('fixture blocked unexpected global fetch'); };
after(() => { globalThis.fetch = originalGlobalFetch; });

const key = 'synthetic-not-a-real-key';
const codexKey = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url')}.sig`;
const completionModel = {
  api: 'openai-completions',
  provider: 'commandcode',
  id: 'synthetic-model',
  name: 'Synthetic',
  baseUrl: 'https://api.commandcode.ai/provider/v1',
  contextWindow: 8192,
  maxTokens: 128,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const codexModel = {
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  id: 'synthetic-model',
  name: 'Synthetic',
  baseUrl: 'https://chatgpt.com/backend-api',
  contextWindow: 8192,
  maxTokens: 128,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const completionChunks = [
  { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
  { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: 'synthetic-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
const codexChunks = `data: ${JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp-synthetic',
    status: 'completed',
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  },
})}\n\n`;

const hostHarness = { loadHostContractModules, resolveHost, runChecks, withBlockedGlobalFetch } as unknown as {
  loadHostContractModules: (host: ResolvedHost) => Promise<unknown>;
  resolveHost: () => Promise<ResolvedHost>;
  runChecks: (host: ResolvedHost) => Promise<unknown[]>;
  withBlockedGlobalFetch: <T>(operation: () => Promise<T>) => Promise<T>;
};

async function loadHost(testContext: { skip(message?: string): void }): Promise<HostContractModules | undefined> {
  const host = await hostHarness.resolveHost();
  if (host.source === 'local') {
    testContext.skip('local devDependency is fallback only; installed-host conformance is not available');
    return undefined;
  }
  return await hostHarness.loadHostContractModules(host) as unknown as HostContractModules;
}

test('host checker blocks ambient fetch and restores it after success or failure', async () => {
  const previousFetch = globalThis.fetch;
  let ambientCalls = 0;
  const ambientFetch: typeof fetch = async () => {
    ambientCalls += 1;
    throw new Error('outer fixture fetch');
  };
  globalThis.fetch = ambientFetch;
  try {
    const value = await hostHarness.withBlockedGlobalFetch(async () => {
      await assert.rejects(globalThis.fetch('https://example.invalid'), /blocked unexpected global fetch/);
      return 'synthetic result';
    });
    assert.equal(value, 'synthetic result');
    assert.equal(ambientCalls, 0);
    assert.equal(globalThis.fetch, ambientFetch);

    await assert.rejects(hostHarness.withBlockedGlobalFetch(async () => {
      await globalThis.fetch('https://example.invalid');
    }), /blocked unexpected global fetch/);
    assert.equal(ambientCalls, 0);
    assert.equal(globalThis.fetch, ambientFetch);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('runChecks installs and restores ambient-fetch trap', async () => {
  const host = await hostHarness.resolveHost();
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  if (!originalDescriptor?.configurable || typeof originalDescriptor.value !== 'function') {
    throw new Error('fixture requires a configurable global fetch data property');
  }
  const originalFetch = originalDescriptor.value as typeof fetch;
  let currentFetch = originalFetch;
  let assignments = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: originalDescriptor.enumerable,
    get: () => currentFetch,
    set: (next: typeof fetch) => { assignments += 1; currentFetch = next; },
  });
  try {
    const checks = await hostHarness.runChecks(host);
    assert.equal(checks.length, 10);
    assert.equal(assignments, 2);
    assert.equal(globalThis.fetch, originalFetch);
  } finally {
    Object.defineProperty(globalThis, 'fetch', originalDescriptor);
  }
});

function setup(prototype: GuardRuntime, stream: AdapterStream, credential = key, body = completionChunks) {
  const calls: { url: string; method?: string; authorization: string | null; account: string | null; accept: string | null }[] = [];
  const scopes: AttemptScope[] = [];
  const pauses: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: headers.get('authorization'),
      account: headers.get('chatgpt-account-id'),
      accept: headers.get('accept'),
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const coordinator: GatedCoordinator = {
    pause: (reason) => { pauses.push(reason); },
    gatedFetch: (scope, inner = fetchImpl) => async (input, init) => {
      scopes.push(scope);
      return inner(input, init);
    },
  };
  const receiver = Object.create(prototype) as GuardRuntime;
  Object.defineProperties(receiver, {
    models: { value: { getProvider: (id: string) => ({ id, stream }), getAuth: async () => ({ auth: { apiKey: credential, headers: {} }, env: {} }) } },
    config: { value: { getProvider: () => undefined } },
    extensionProviders: { value: new Map() },
  });
  return { receiver, calls, scopes, pauses, coordinator, fetchImpl };
}

async function consume(iterable: AsyncIterable<unknown>): Promise<string[]> {
  const errors: string[] = [];
  for await (const event of iterable) {
    if (typeof event !== 'object' || event === null) continue;
    const candidate = event as { type?: unknown; error?: { errorMessage?: unknown } };
    if (candidate.type === 'error') {
      errors.push(typeof candidate.error?.errorMessage === 'string' ? candidate.error.errorMessage : 'provider stream error');
    }
  }
  return errors;
}

test('installed host prototype guard gates final authenticated request', async (t) => {
  const host = await loadHost(t);
  if (!host) return;
  const { ModelRuntime, completions } = host;
  const prototype = ModelRuntime.prototype;
  const h = setup(prototype, completions);
  const originalStream = Object.getOwnPropertyDescriptor(prototype, 'stream');
  const originalSimple = Object.getOwnPropertyDescriptor(prototype, 'streamSimple');
  if (!originalStream || !originalSimple) throw new Error('fixture requires own dispatch descriptors');
  let dispose: (() => void) | undefined;
  try {
    dispose = installQuotaGuard({ runtime: prototype, rootId: 'host-contract', coordinator: h.coordinator, fetchImpl: h.fetchImpl });
    const errors = await consume(h.receiver.stream(completionModel, { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, {}) as AsyncIterable<unknown>);
    assert.deepEqual({
      errors,
      request: h.calls.map(({ method, authorization }) => ({ method, authorization })),
      scopes: h.scopes.map(({ providerId, scope }) => ({ providerId, scope })),
      pauses: h.pauses,
    }, {
      errors: [],
      request: [{ method: 'POST', authorization: `Bearer ${key}` }],
      scopes: [{ providerId: 'commandcode', scope: 'provider' }],
      pauses: [],
    });
  } finally {
    try { dispose?.(); } finally {
      Object.defineProperty(prototype, 'stream', originalStream);
      Object.defineProperty(prototype, 'streamSimple', originalSimple);
      assert.deepEqual(
        [Object.getOwnPropertyDescriptor(prototype, 'stream'), Object.getOwnPropertyDescriptor(prototype, 'streamSimple')],
        [originalStream, originalSimple],
      );
    }
  }
});

test('installed host guard forces Codex SSE and refuses bypass routes before transport', async (t) => {
  const host = await loadHost(t);
  if (!host) return;
  const { ModelRuntime, codex } = host;
  const codexTransports: unknown[] = [];
  const guardedCodexStream: AdapterStream = (...args) => {
    const options = args[2] as { transport?: unknown } | undefined;
    codexTransports.push(options?.transport);
    if (options?.transport !== 'sse') throw new Error('fixture blocked non-SSE Codex transport');
    return codex(...args);
  };
  const prototype = ModelRuntime.prototype;
  const h = setup(prototype, guardedCodexStream, codexKey, codexChunks);
  const originalStream = Object.getOwnPropertyDescriptor(prototype, 'stream');
  const originalSimple = Object.getOwnPropertyDescriptor(prototype, 'streamSimple');
  if (!originalStream || !originalSimple) throw new Error('fixture requires own dispatch descriptors');
  let dispose: (() => void) | undefined;
  try {
    dispose = installQuotaGuard({
      runtime: prototype,
      rootId: 'host-contract',
      coordinator: h.coordinator,
      fetchImpl: h.fetchImpl,
      codexLimits: [{ id: 'codex', windows: ['primary_window', 'secondary_window'] }],
    });
    const errors = await consume(h.receiver.stream(codexModel, { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, { transport: 'websocket' }) as AsyncIterable<unknown>);
    assert.deepEqual({
      errors,
      transports: codexTransports,
      request: h.calls.map(({ method, authorization, account, accept }) => ({ method, authorization, account, accept })),
      scopes: h.scopes.map(({ providerId, scope, accountId }) => ({ providerId, scope, accountId })),
    }, {
      errors: [],
      transports: ['sse'],
      request: [{ method: 'POST', authorization: `Bearer ${codexKey}`, account: 'synthetic-account', accept: 'text/event-stream' }],
      scopes: [{ providerId: 'openai-codex', scope: 'account', accountId: 'synthetic-account' }],
    });
    assert.throws(() => h.receiver.stream({ ...codexModel, api: 'unsupported' }, {}, {}), /cannot be guarded/);
    assert.throws(() => h.receiver.stream({ ...completionModel, api: 'anthropic-messages' }, {}, { client: {} }), /supplied client/);
    assert.equal(h.calls.length, 1);
  } finally {
    try { dispose?.(); } finally {
      Object.defineProperty(prototype, 'stream', originalStream);
      Object.defineProperty(prototype, 'streamSimple', originalSimple);
      assert.deepEqual(
        [Object.getOwnPropertyDescriptor(prototype, 'stream'), Object.getOwnPropertyDescriptor(prototype, 'streamSimple')],
        [originalStream, originalSimple],
      );
    }
  }
});

test('broken transport fails host contract negative control', async (t) => {
  const host = await loadHost(t);
  if (!host) return;
  const { ModelRuntime, completions } = host;
  const prototype = ModelRuntime.prototype;
  const h = setup(prototype, completions);
  const originalStream = Object.getOwnPropertyDescriptor(prototype, 'stream');
  const originalSimple = Object.getOwnPropertyDescriptor(prototype, 'streamSimple');
  if (!originalStream || !originalSimple) throw new Error('fixture requires own dispatch descriptors');
  let brokenTransportCalls = 0;
  const brokenFetch: typeof fetch = async () => {
    brokenTransportCalls += 1;
    throw new Error('synthetic broken transport');
  };
  let dispose: (() => void) | undefined;
  try {
    dispose = installQuotaGuard({ runtime: prototype, rootId: 'host-contract', coordinator: h.coordinator, fetchImpl: brokenFetch });
    const errors = await consume(h.receiver.stream(completionModel, { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }, {}) as AsyncIterable<unknown>);
    assert.deepEqual({
      errorEvents: errors.length,
      gatedRequests: h.scopes.length,
      brokenTransportCalls,
      successfulRequests: h.calls.length,
    }, {
      errorEvents: 1,
      gatedRequests: 1,
      brokenTransportCalls: 1,
      successfulRequests: 0,
    });
  } finally {
    try { dispose?.(); } finally {
      Object.defineProperty(prototype, 'stream', originalStream);
      Object.defineProperty(prototype, 'streamSimple', originalSimple);
      assert.deepEqual(
        [Object.getOwnPropertyDescriptor(prototype, 'stream'), Object.getOwnPropertyDescriptor(prototype, 'streamSimple')],
        [originalStream, originalSimple],
      );
    }
  }
});
